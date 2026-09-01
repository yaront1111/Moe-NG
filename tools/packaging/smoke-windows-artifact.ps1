#Requires -Version 5.1
<#
.SYNOPSIS
  Clean-machine smoke for the packed Windows artifact.

.DESCRIPTION
  Extracts dist/moe-windows.zip into a directory OUTSIDE the repository - whose
  path deliberately contains a space - and drives the artifact the way an
  operator would: moe --version, moe projects, moe init, moe start. The manager
  leg proves the foreground project list; the direct leg proves the same
  per-project runtime boundary without a browser. Nothing here imports from the
  repo; the only input is the zip.

  Every assertion is on the ARTIFACT's own output, and the refusal checks assert
  the exact reason code rather than merely "it failed".
#>
[CmdletBinding()]
param(
  [string] $Zip = '',
  [string] $WorkRoot = (Join-Path $env:TEMP 'MoeArtifactSmoke\current'),
  [int] $StartTimeoutSec = 240
)

$ErrorActionPreference = 'Stop'
$script:Failures = @()
$SmokeOwnerMarker = '.moe-artifact-smoke-owned'
$SmokeOwnerValue = 'moe-windows-artifact-smoke/1'

function Initialize-SmokeWorkRoot {
  param([string] $Candidate)
  $sandbox = [System.IO.Path]::GetFullPath((Join-Path $env:TEMP 'MoeArtifactSmoke'))
  if (-not (Test-Path -LiteralPath $sandbox)) {
    New-Item -ItemType Directory -Path $sandbox | Out-Null
  }
  $sandboxItem = Get-Item -LiteralPath $sandbox -Force
  if (-not $sandboxItem.PSIsContainer -or
      (($sandboxItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw 'unsafe smoke sandbox: expected an ordinary temp directory'
  }

  $resolved = [System.IO.Path]::GetFullPath($Candidate)
  $prefix = $sandbox.TrimEnd([char[]] @('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $resolved.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "unsafe WorkRoot: expected a child of $sandbox"
  }
  if (Test-Path -LiteralPath $resolved) {
    $item = Get-Item -LiteralPath $resolved -Force
    if (-not $item.PSIsContainer -or
        (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw 'unsafe WorkRoot: existing path is not an ordinary directory'
    }
    $marker = Join-Path $resolved $SmokeOwnerMarker
    if (-not (Test-Path -LiteralPath $marker) -or
        (Get-Content -LiteralPath $marker -Raw) -ne $SmokeOwnerValue) {
      throw 'unsafe WorkRoot: existing directory is not marker-owned by this smoke'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
  New-Item -ItemType Directory -Path $resolved | Out-Null
  Set-Content -LiteralPath (Join-Path $resolved $SmokeOwnerMarker) `
    -Value $SmokeOwnerValue -NoNewline -Encoding ASCII
  return $resolved
}

function Assert-That {
  param([string] $Name, [bool] $Ok, [string] $Detail)
  if ($Ok) { Write-Host "  PASS  $Name" }
  else {
    Write-Host "  FAIL  $Name"
    Write-Host "        $Detail"
    $script:Failures += $Name
  }
}

# Runs the packed CLI as an operator would, through moe.cmd, and returns its exit
# code plus the output it actually printed. A timeout is a FAILURE, never a hang.
function Invoke-Moe {
  param(
    [string] $Extracted,
    [string] $CallerCwd = '',
    [string[]] $MoeArgs,
    [hashtable] $WithEnv = @{},
    [int] $TimeoutSec = 120
  )
  if ($CallerCwd -eq '') { $CallerCwd = $Extracted }
  $saved = @{}
  foreach ($key in $WithEnv.Keys) {
    $saved[$key] = [Environment]::GetEnvironmentVariable($key)
    if ($null -eq $WithEnv[$key]) {
      Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
    } else {
      Set-Item -LiteralPath "Env:$key" -Value ([string] $WithEnv[$key])
    }
  }
  try {
    $batch = Join-Path $Extracted 'moe.cmd'
    if ($batch -match '[\r\n"%]') { throw 'unsafe extracted CLI path for cmd.exe' }
    foreach ($argument in $MoeArgs) {
      if ($argument -notmatch '^[A-Za-z0-9._:-]+$') {
        throw "unsafe smoke CLI argument: $argument"
      }
    }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
    $start.Arguments = "/d /s /c call `"$batch`" $($MoeArgs -join ' ')".TrimEnd()
    $start.WorkingDirectory = $CallerCwd
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    try {
      [void] $process.Start()
      $stdout = $process.StandardOutput.ReadToEndAsync()
      $stderr = $process.StandardError.ReadToEndAsync()
      $exited = $process.WaitForExit($TimeoutSec * 1000)
      if (-not $exited) {
        $killer = Start-Process -FilePath 'taskkill.exe' `
          -ArgumentList @('/PID', [string] $process.Id, '/T', '/F') `
          -WindowStyle Hidden -PassThru -Wait
        if ($killer.ExitCode -ne 0 -and -not $process.HasExited) {
          throw "timed-out CLI tree teardown failed for pid $($process.Id)"
        }
        [void] $process.WaitForExit(5000)
        $text = $stdout.Result + $stderr.Result
        return @{
          Code = -1
          Output = ("TIMEOUT after ${TimeoutSec}s`n$text" -replace "`0", '')
          TimedOut = $true
        }
      }
      # The parameterless wait drains redirected asynchronous readers before
      # their Result is observed. The directly-created Process retains the
      # native handle on Windows PowerShell 5.1, so ExitCode is an integer;
      # Start-Process drops that handle and returns $null after a timed wait.
      $process.WaitForExit()
      $text = $stdout.Result + $stderr.Result
      return @{ Code = $process.ExitCode; Output = ($text -replace "`0", ''); TimedOut = $false }
    } finally {
      $process.Dispose()
    }
  } finally {
    foreach ($key in $saved.Keys) {
      if ($null -eq $saved[$key]) {
        Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
      } else {
        Set-Item -LiteralPath "Env:$key" -Value ([string] $saved[$key])
      }
    }
  }
}

# Starts a foreground CLI command with a parent-owned private stdin pipe. Output
# goes to marker-owned files so readiness can be polled without echoing pairing
# labels. Environment changes are restored after spawn; the child owns its copy.
function Start-MoeForeground {
  param(
    [string] $Extracted,
    [string] $CallerCwd = '',
    [string[]] $MoeArgs,
    [hashtable] $WithEnv = @{}
  )
  if ($CallerCwd -eq '') { $CallerCwd = $Extracted }
  $outFile = Join-Path $WorkRoot ([System.IO.Path]::GetRandomFileName())
  $errFile = Join-Path $WorkRoot ([System.IO.Path]::GetRandomFileName())
  $wrapperFile = Join-Path $WorkRoot (([System.IO.Path]::GetRandomFileName()) + '.cmd')
  $saved = @{}
  foreach ($key in $WithEnv.Keys) {
    $saved[$key] = [Environment]::GetEnvironmentVariable($key)
    if ($null -eq $WithEnv[$key]) {
      Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
    } else {
      Set-Item -LiteralPath "Env:$key" -Value ([string] $WithEnv[$key])
    }
  }
  try {
    $batch = Join-Path $Extracted 'moe.cmd'
    foreach ($path in @($batch, $outFile, $errFile, $wrapperFile)) {
      if ($path -match '[\r\n"%]') { throw 'unsafe foreground smoke path for cmd.exe' }
    }
    foreach ($argument in $MoeArgs) {
      if ($argument -notmatch '^[A-Za-z0-9._:-]+$') {
        throw "unsafe foreground smoke CLI argument: $argument"
      }
    }
    $wrapper = @(
      '@echo off',
      "call `"$batch`" $($MoeArgs -join ' ') 1>`"$outFile`" 2>`"$errFile`"",
      'exit /b %errorlevel%'
    ) -join "`r`n"
    Set-Content -LiteralPath $wrapperFile -Value $wrapper -NoNewline -Encoding ASCII

    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
    $start.Arguments = "/d /s /c call `"$wrapperFile`""
    $start.WorkingDirectory = $CallerCwd
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    [void] $process.Start()
    return @{
      ErrFile = $errFile
      Input = $process.StandardInput
      OutFile = $outFile
      Process = $process
      WrapperFile = $wrapperFile
    }
  } finally {
    foreach ($key in $saved.Keys) {
      if ($null -eq $saved[$key]) {
        Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
      } else {
        Set-Item -LiteralPath "Env:$key" -Value ([string] $saved[$key])
      }
    }
  }
}

function Send-MoeForegroundOperatorLine {
  param([hashtable] $Run, [string] $Line)
  if ($Line.Length -eq 0 -or $Line.Length -gt 96 -or $Line -notmatch '^[ -~]+$') {
    throw 'unsafe foreground operator line'
  }
  $Run.Input.WriteLine($Line)
  $Run.Input.Flush()
}

function Read-MoeForegroundOutput {
  param([hashtable] $Run)
  $stdout = if (Test-Path -LiteralPath $Run.OutFile) {
    Get-Content -LiteralPath $Run.OutFile -Raw -ErrorAction SilentlyContinue
  } else { '' }
  $stderr = if (Test-Path -LiteralPath $Run.ErrFile) {
    Get-Content -LiteralPath $Run.ErrFile -Raw -ErrorAction SilentlyContinue
  } else { '' }
  return (([string] $stdout + [string] $stderr) -replace "`0", '')
}

function Wait-MoeForegroundOutput {
  param(
    [hashtable] $Run,
    [regex] $Pattern,
    [int] $TimeoutSec = 30
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
  do {
    $output = Read-MoeForegroundOutput -Run $Run
    if ($output -match $Pattern) { return @{ Matched = $true; Output = $output } }
    if ($Run.Process.HasExited) { return @{ Matched = $false; Output = $output } }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  return @{ Matched = $false; Output = (Read-MoeForegroundOutput -Run $Run) }
}

# Start-Process launches a .cmd through cmd.exe. Killing that direct handle alone
# can orphan its node child, so teardown is scoped to the still-owned process tree.
function Stop-MoeForeground {
  param([hashtable] $Run)
  try { $Run.Input.Close() } catch {}
  if (-not $Run.Process.HasExited) {
    $killer = Start-Process -FilePath 'taskkill.exe' `
      -ArgumentList @('/PID', [string] $Run.Process.Id, '/T', '/F') `
      -WindowStyle Hidden -PassThru -Wait
    if ($killer.ExitCode -ne 0 -and -not $Run.Process.HasExited) {
      throw "foreground tree teardown failed for pid $($Run.Process.Id)"
    }
    [void] $Run.Process.WaitForExit(5000)
  }
  $Run.Process.Dispose()
}

if ($Zip -eq '') { $Zip = Join-Path $PSScriptRoot '..\..\dist\moe-windows.zip' }
if (-not (Test-Path $Zip)) { throw "zip not found: $Zip - run pnpm run pack:windows first" }

Write-Host "smoke: extracting $Zip"
$WorkRoot = Initialize-SmokeWorkRoot -Candidate $WorkRoot
$extracted = Join-Path $WorkRoot 'extracted'
New-Item -ItemType Directory $extracted | Out-Null
Expand-Archive -Path $Zip -DestinationPath $extracted -Force
Write-Host "smoke: extracted to $extracted"


Assert-That 'the artifact exposes a moe.cmd entry point' `
  (Test-Path (Join-Path $extracted 'moe.cmd')) 'moe.cmd missing from the extracted tree'

$version = Invoke-Moe -Extracted $extracted -MoeArgs @('--version')
Assert-That 'moe --version prints the packed version' `
  ($version.Code -eq 0 -and $version.Output.Trim() -eq '0.1.0') `
  "exit=$($version.Code) output=$($version.Output)"

$unknown = Invoke-Moe -Extracted $extracted -MoeArgs @('frobnicate')
Assert-That 'an unknown command refuses by NAME and exits nonzero' `
  ($unknown.Code -ne 0 -and $unknown.Output -match 'MOE_CLI_UNKNOWN_COMMAND: frobnicate') `
  "exit=$($unknown.Code) output=$($unknown.Output)"

# A no-op agent command keeps this smoke independent of an installed provider.
# It is created before the manager so manager-owned project wrappers inherit it.
$noop = Join-Path $WorkRoot 'noop-agent.cmd'
Set-Content -Path $noop -Value "@echo off`r`nexit /b 0`r`n" -Encoding ASCII
$operatorRoot = Join-Path $WorkRoot 'operator project'
New-Item -ItemType Directory -Force -Path $operatorRoot | Out-Null
$scrubbedAgentEnvironment = @{
  ANTHROPIC_API_KEY       = $null
  ANTHROPIC_AUTH_TOKEN    = $null
  CLAUDE_CODE_OAUTH_TOKEN = $null
  CODEX_ACCESS_TOKEN      = $null
  CODEX_API_KEY           = $null
  CODEX_HOME              = $null
  OPENAI_API_KEY          = $null
  MOE_AGENT_COMMAND       = $noop
  MOE_WRAPPER_ONCE        = $null
}

# The project manager is intentionally foreground. Start it independently,
# redeem its real ticket, create two same-basename projects, and prove their
# daemon/store/board/goal isolation. Teardown deliberately kills ONLY the
# manager Node process: taskkill /T here would mask a broken Job boundary by
# killing the descendants on the test's behalf.
$managerLocalAppData = Join-Path $WorkRoot 'manager-localappdata'
New-Item -ItemType Directory -Force -Path $managerLocalAppData | Out-Null
$managerEnvironment = @{} + $scrubbedAgentEnvironment
$managerEnvironment.LOCALAPPDATA = $managerLocalAppData
$manager = Start-MoeForeground -Extracted $extracted -CallerCwd $operatorRoot `
  -MoeArgs @('projects', '--operator-stdin') `
  -WithEnv $managerEnvironment
$managerCrashedForTest = $false
$projectPorts = @()
try {
  $managerReady = Wait-MoeForegroundOutput -Run $manager `
    -Pattern 'moe projects: Ctrl-C stops the manager and every project runtime' `
    -TimeoutSec 30
  $managerOutput = $managerReady.Output
  $managerUrl = [regex]::Match(
    $managerOutput,
    'moe projects: (http://127\.0\.0\.2:39122)'
  )
  Assert-That 'moe projects reaches the foreground manager from the extracted artifact' `
    ($managerReady.Matched -and -not $manager.Process.HasExited) `
    "exited=$($manager.Process.HasExited) output=$managerOutput"
  Assert-That 'moe projects prints only the fixed manager origin' `
    ($managerUrl.Success -and $managerOutput -notmatch '[#?]manager=') `
    "output=$managerOutput"
  Assert-That 'moe projects names Ctrl-C containment for every project runtime' `
    ($managerOutput -match 'moe projects: Ctrl-C stops the manager and every project runtime') `
    "output=$managerOutput"
  if (-not $managerReady.Matched -or -not $managerUrl.Success) {
    throw 'manager readiness prerequisite failed'
  }

  $managerOrigin = 'http://127.0.0.2:39122'
  $managerSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $managerBootstrap = Invoke-RestMethod -Uri "$managerOrigin/manager/bootstrap" `
    -Method Get -WebSession $managerSession
  $managerHeaders = @{
    Origin                            = $managerOrigin
    'x-moe-manager-csrf'             = [string] $managerBootstrap.csrfToken
    'x-moe-manager-protocol-version' = [string] $managerBootstrap.schemaVersion
  }
  $managerPairRequest = Invoke-RestMethod `
    -Uri "$managerOrigin/manager/session/pair/request" `
    -Method Post -Headers $managerHeaders -ContentType 'application/json' `
    -Body '{}' `
    -WebSession $managerSession
  if (-not $managerPairRequest.ok -or
      [string] $managerPairRequest.requestId -notmatch '^[0-9a-f]{64}$' -or
      [string] $managerPairRequest.confirmationLabel -notmatch '^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$') {
    throw 'manager pairing request was malformed'
  }
  Send-MoeForegroundOperatorLine -Run $manager `
    -Line ([string] $managerPairRequest.confirmationLabel)
  $paired = $null
  $pairDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    try {
      $paired = Invoke-RestMethod -Uri "$managerOrigin/manager/session/pair/claim" `
        -Method Post -Headers $managerHeaders -ContentType 'application/json' `
        -Body (([ordered] @{ requestId = [string] $managerPairRequest.requestId }) |
          ConvertTo-Json -Compress) -WebSession $managerSession
      break
    } catch {
      $status = [int] $_.Exception.Response.StatusCode
      if ($status -ne 409) { throw }
      Start-Sleep -Milliseconds 50
    }
  } while ([DateTime]::UtcNow -lt $pairDeadline)
  if ($null -eq $paired) { throw 'manager operator approval timed out' }
  $managerCookie = $managerSession.Cookies.GetCookies(
    [uri] "$managerOrigin/manager/projects"
  )['moe_manager_session']
  Assert-That 'operator confirmation mints only the hardened manager path cookie' `
    ($paired.code -eq 'PROJECT_MANAGER_PAIRED' -and
      $paired.layer -eq 'PROJECT_MANAGER_HTTP' -and $paired.ok -and
      $null -ne $managerCookie -and $managerCookie.HttpOnly) `
    "code=$($paired.code) layer=$($paired.layer) cookiePresent=$($null -ne $managerCookie)"
  if (-not $paired.ok -or $null -eq $managerCookie) { throw 'manager pairing failed' }

  $alphaRoot = Join-Path $WorkRoot 'alpha\workspace'
  $betaRoot = Join-Path $WorkRoot 'beta\workspace'
  foreach ($input in @(
    [ordered] @{ root = $alphaRoot; title = 'Alpha' },
    [ordered] @{ root = $betaRoot; title = 'Beta' }
  )) {
    $created = Invoke-RestMethod -Uri "$managerOrigin/manager/projects/create" `
      -Method Post -Headers $managerHeaders -ContentType 'application/json' `
      -Body ($input | ConvertTo-Json -Compress) -WebSession $managerSession
    if (-not $created.ok -or $created.code -ne 'PROJECT_MANAGER_PROJECT_CREATED') {
      throw "project create refused: $($created.code) @ $($created.layer)"
    }
  }

  $catalog = Invoke-RestMethod -Uri "$managerOrigin/manager/projects" `
    -Method Get -WebSession $managerSession
  $alpha = @($catalog.projects | Where-Object title -eq 'Alpha')[0]
  $beta = @($catalog.projects | Where-Object title -eq 'Beta')[0]
  Assert-That 'the manager catalog separates two same-basename Windows roots' `
    ($catalog.schemaVersion -eq 'moe-project-manager/1' -and
      $catalog.projects.Count -eq 2 -and
      [IO.Path]::GetFileName($alpha.root) -eq 'workspace' -and
      [IO.Path]::GetFileName($beta.root) -eq 'workspace' -and
      $alpha.instanceId -ne $beta.instanceId -and
      $alpha.projectId -ne $beta.projectId) `
    "count=$($catalog.projects.Count) alpha=$($alpha.projectId) beta=$($beta.projectId)"

  foreach ($project in @($alpha, $beta)) {
    $started = Invoke-RestMethod `
      -Uri "$managerOrigin/manager/projects/$($project.instanceId)/start" `
      -Method Post -Headers $managerHeaders -ContentType 'application/json' `
      -Body ([string]::Empty) -WebSession $managerSession
    if (-not $started.ok -or $started.code -ne 'PROJECT_RUNTIME_STARTED') {
      throw "project start refused: $($started.code) @ $($started.layer)"
    }
  }

  $running = Invoke-RestMethod -Uri "$managerOrigin/manager/projects" `
    -Method Get -WebSession $managerSession
  Assert-That 'both catalog rows reach RUNNING under separate contained runtimes' `
    (@($running.projects | Where-Object lifecycle -eq 'RUNNING').Count -eq 2) `
    (($running.projects | ForEach-Object { "$($_.title)=$($_.lifecycle)" }) -join ', ')

  $projectViews = @()
  $projectSecrets = @()
  foreach ($project in @($alpha, $beta)) {
    $opened = Invoke-RestMethod `
      -Uri "$managerOrigin/manager/projects/$($project.instanceId)/open" `
      -Method Post -Headers $managerHeaders -ContentType 'application/json' `
      -Body ([string]::Empty) -WebSession $managerSession
    $projectOrigin = [regex]::Match(
      [string] $opened.origin,
      '^http://127\.0\.0\.1:(\d+)$'
    )
    if (-not $opened.ok -or $opened.code -ne 'PROJECT_RUNTIME_OPENED' -or
        -not $projectOrigin.Success) {
      throw "project open refused: $($opened.code) @ $($opened.layer)"
    }
    $port = [int] $projectOrigin.Groups[1].Value
    $origin = "http://127.0.0.1:$port"
    $bootstrap = Invoke-RestMethod -Uri "$origin/bootstrap" -Method Get
    if ($bootstrap.projectId -ne $project.projectId) {
      throw "project bootstrap mismatch for $($project.title)"
    }
    $pairHeaders = @{
      Origin                   = $origin
      'x-moe-csrf'             = [string] $bootstrap.csrfToken
      'x-moe-protocol-version' = [string] $bootstrap.protocolVersion
    }
    $projectPairRequest = Invoke-RestMethod -Uri "$origin/session/pair/request" -Method Post `
      -Headers $pairHeaders -ContentType 'application/json' `
      -Body '{}'
    if (-not $projectPairRequest.ok -or
        [string] $projectPairRequest.requestId -notmatch '^[0-9a-f]{64}$' -or
        [string] $projectPairRequest.confirmationLabel -notmatch '^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$') {
      throw "project pairing request was malformed for $($project.title)"
    }
    Send-MoeForegroundOperatorLine -Run $manager `
      -Line "$($project.instanceId) $($projectPairRequest.confirmationLabel)"
    $session = $null
    $pairDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
      try {
        $session = Invoke-RestMethod -Uri "$origin/session/pair/claim" -Method Post `
          -Headers $pairHeaders -ContentType 'application/json' `
          -Body (([ordered] @{ requestId = [string] $projectPairRequest.requestId }) |
            ConvertTo-Json -Compress)
        break
      } catch {
        $status = [int] $_.Exception.Response.StatusCode
        if ($status -ne 409) { throw }
        Start-Sleep -Milliseconds 50
      }
    } while ([DateTime]::UtcNow -lt $pairDeadline)
    if ($null -eq $session) { throw "project operator approval timed out for $($project.title)" }
    $projectHeaders = @{
      Origin                     = $origin
      'x-moe-csrf'               = [string] $bootstrap.csrfToken
      'x-moe-protocol-version'   = [string] $bootstrap.protocolVersion
      'x-moe-session-credential' = [string] $session.sessionCredential
    }
    $surface = Invoke-RestMethod -Uri "$origin/affordances/read" -Method Post `
      -Headers $projectHeaders -ContentType 'application/json' `
      -Body (([ordered] @{ projectId = $bootstrap.projectId }) | ConvertTo-Json -Compress)
    $goals = Invoke-RestMethod -Uri "$origin/goals/read" -Method Post `
      -Headers $projectHeaders -ContentType 'application/json' -Body '{}'
    if ($surface.outcome -ne 'SURFACE' -or $goals.outcome -ne 'GOALS') {
      throw "project-local reads refused for $($project.title)"
    }
    $projectPorts += $port
    $projectSecrets += @(
      [string] $projectPairRequest.requestId,
      [string] $projectPairRequest.confirmationLabel,
      [string] $session.sessionCredential
    )
    $projectViews += [pscustomobject] @{
      InstanceId = $project.instanceId
      ProjectId  = $bootstrap.projectId
      Port       = $port
      StepCount  = @($surface.steps).Count
      GoalCount  = @($goals.goals).Count
    }
  }
  Assert-That 'each project answers its own board and goal catalog with no cross-project id' `
    ($projectViews.Count -eq 2 -and
      $projectViews[0].ProjectId -eq $alpha.projectId -and
      $projectViews[1].ProjectId -eq $beta.projectId -and
      $projectViews[0].ProjectId -ne $projectViews[1].ProjectId -and
      $projectViews[0].StepCount -gt 0 -and $projectViews[1].StepCount -gt 0) `
    (($projectViews | ForEach-Object {
      "$($_.ProjectId):port=$($_.Port),steps=$($_.StepCount),goals=$($_.GoalCount)"
    }) -join '; ')

  $managerListenerOwners = @(Get-NetTCPConnection -State Listen `
    -LocalAddress '127.0.0.2' -LocalPort 39122 -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
  if ($managerListenerOwners.Count -ne 1) { throw 'manager listener owner is not unique' }
  $managerNodePid = [int] $managerListenerOwners[0]
  $allBefore = @(Get-CimInstance Win32_Process)
  $managerNode = @($allBefore | Where-Object ProcessId -eq $managerNodePid)[0]
  if ($null -eq $managerNode -or -not $managerNode.CommandLine.Contains($extracted) -or
      -not $managerNode.CommandLine.Contains('projects')) {
    throw 'manager listener is not owned by the extracted artifact projects command'
  }
  $ownedIds = [Collections.Generic.HashSet[int]]::new()
  [void] $ownedIds.Add($managerNodePid)
  do {
    $changed = $false
    foreach ($process in $allBefore) {
      if ($ownedIds.Contains([int] $process.ParentProcessId) -and
          $ownedIds.Add([int] $process.ProcessId)) { $changed = $true }
    }
  } while ($changed)
  $ownedBefore = @($allBefore | Where-Object { $ownedIds.Contains([int] $_.ProcessId) })
  $allSecrets = @(
    [string] $managerPairRequest.requestId,
    [string] $managerPairRequest.confirmationLabel,
    [string] $managerCookie.Value
  ) + @($projectSecrets)
  $commandLineLeak = @($ownedBefore | Where-Object {
    $line = [string] $_.CommandLine
    @($allSecrets | Where-Object { $line.Contains($_) }).Count -gt 0
  })
  $catalogLeaks = @()
  foreach ($secret in $allSecrets) {
    $catalogLeaks += @(Get-ChildItem -LiteralPath $managerLocalAppData -Recurse -File |
      Select-String -SimpleMatch -Pattern $secret -List)
  }
  $managerOutputAfterPairing = Read-MoeForegroundOutput -Run $manager
  $outputLeaks = @($allSecrets | Where-Object {
    $managerOutputAfterPairing.Contains($_)
  })
  Assert-That 'pairing identities and session secrets stay out of stdout, argv, and catalog files' `
    ($outputLeaks.Count -eq 0 -and $commandLineLeak.Count -eq 0 -and $catalogLeaks.Count -eq 0) `
    "outputLeaks=$($outputLeaks.Count) commandLineLeaks=$($commandLineLeak.Count) catalogLeaks=$($catalogLeaks.Count)"

  Stop-Process -Id $managerNodePid -Force
  $managerCrashedForTest = $true
  $portsToDrain = @(39122) + @($projectPorts)
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $livePorts = @(foreach ($port in $portsToDrain) {
      Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    })
    $liveOwned = @(foreach ($prior in $ownedBefore) {
      $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($prior.ProcessId)" `
        -ErrorAction SilentlyContinue
      if ($null -ne $current -and $current.CreationDate -eq $prior.CreationDate) { $current }
    })
    if ($livePorts.Count -eq 0 -and $liveOwned.Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  Assert-That 'killing only the manager Node reaps both project Jobs and all three listeners' `
    ($livePorts.Count -eq 0 -and $liveOwned.Count -eq 0) `
    "livePorts=$($livePorts.Count) liveOwned=$($liveOwned.Count)"
} catch {
  Assert-That 'the packaged two-project manager journey completes without an exception' `
    $false $_.Exception.Message
} finally {
  if (-not $manager.Process.HasExited) { Stop-MoeForeground -Run $manager }
}

$init = Invoke-Moe -Extracted $extracted -CallerCwd $operatorRoot -MoeArgs @('init', '.')
$configPath = Join-Path $operatorRoot 'moe.config.json'
Assert-That 'moe init . resolves against the external caller cwd' `
  ($init.Code -eq 0 -and (Test-Path $configPath)) `
  "exit=$($init.Code) output=$($init.Output)"
Assert-That 'moe init . never writes operator state into the installation' `
  (-not (Test-Path (Join-Path $extracted 'moe.config.json'))) `
  'the packaged installation received caller-owned configuration state'

$credential = ''
$configuredStorePath = ''
$callerStorePath = Join-Path $operatorRoot 'store.sqlite'
if (Test-Path $configPath) {
  $config = Get-Content $configPath -Raw | ConvertFrom-Json
  $credential = $config.credential
  $configuredStorePath = [string] $config.storePath
}
Assert-That 'moe init records the store under the external caller cwd' `
  ($configuredStorePath -eq $callerStorePath) `
  "configured=$configuredStorePath expected=$callerStorePath"
Assert-That 'moe init mints a 64-hex-character operator credential' `
  ($credential -match '^[0-9a-f]{64}$') "credential=<$($credential.Length) chars>"

Assert-That 'moe init never echoes the credential onto the console' `
  ($credential -ne '' -and $init.Output -notmatch [regex]::Escape($credential)) `
  'the minted credential appeared in stdout'

# The credential-bytes rule, with its POSITIVE CONTROL. Searching the shipped
# tree for a string that is nowhere is trivially satisfiable; the control proves
# the same search DOES find the credential where it genuinely lives.
$shipped = Get-ChildItem $extracted -Recurse -File -Force
$leaks = @($shipped | Select-String -SimpleMatch -Pattern $credential -List)
Assert-That 'no shipped file carries the minted credential' `
  ($leaks.Count -eq 0) "leaked in: $($leaks | ForEach-Object { $_.Path })"
$control = @(Get-Item $configPath | Select-String -SimpleMatch -Pattern $credential -List)
Assert-That 'positive control: the same search finds the credential in the config' `
  ($control.Count -eq 1) 'the search cannot find the credential even where it IS'

$again = Invoke-Moe -Extracted $extracted -CallerCwd $operatorRoot -MoeArgs @('init', '.')
Assert-That 'a second moe init refuses by NAME instead of overwriting' `
  ($again.Code -ne 0 -and $again.Output -match 'MOE_INIT_CONFIG_PRESENT: moe.config.json') `
  "exit=$($again.Code) output=$($again.Output)"
$credentialAfter = (Get-Content $configPath -Raw | ConvertFrom-Json).credential
Assert-That 'the refused re-init left the original credential untouched' `
  ($credentialAfter -eq $credential) 'the credential changed under a refusal'

# The provider-credential guard must travel INTO the artifact: without it a
# `claude --bare` child spawns, fails to authenticate, and looks like an
# orchestration bug instead of a missing variable. ALL THREE accepted names
# are cleared: leaving one set on the host would make this arm vacuous, since
# any one of them now satisfies the gate.
$noKey = Invoke-Moe -Extracted $extracted -CallerCwd $operatorRoot -MoeArgs @('start', '.') `
  -WithEnv @{
    ANTHROPIC_API_KEY = $null
    ANTHROPIC_AUTH_TOKEN = $null
    CLAUDE_CODE_OAUTH_TOKEN = $null
    MOE_AGENT_COMMAND = $null
  } -TimeoutSec 120
Assert-That 'moe start refuses by NAME when every accepted credential is absent' `
  ($noKey.Code -ne 0 -and $noKey.Output -match 'MOE_UP_ENV_MISSING PROJECT_MANAGER_LAUNCH') `
  "exit=$($noKey.Code) output=$($noKey.Output)"

Write-Host "smoke: starting one direct project runtime (this boots a real daemon)"
$direct = Start-MoeForeground -Extracted $extracted -CallerCwd $operatorRoot `
  -MoeArgs @('start', '.', '--operator-stdin') `
  -WithEnv $scrubbedAgentEnvironment
try {
  $directReady = Wait-MoeForegroundOutput -Run $direct `
    -Pattern 'moe start: Ctrl-C stops this project runtime' -TimeoutSec 30
  $directOutput = $directReady.Output
  $directUrl = [regex]::Match(
    $directOutput,
    'moe start: (http://127\.0\.0\.1:(\d+))'
  )
  Assert-That 'moe start reaches a project runtime through the native boundary' `
    ($directReady.Matched -and -not $direct.Process.HasExited) `
    "exited=$($direct.Process.HasExited) output=$directOutput"
  Assert-That 'moe start creates the store under the external caller cwd' `
    (Test-Path $callerStorePath) "store missing: $callerStorePath"
  Assert-That 'moe start never creates a store under the installation' `
    (-not (Test-Path (Join-Path $extracted 'store.sqlite'))) `
    'the packaged installation received caller-owned store state'
  Assert-That 'moe start prints only a plain project-scoped origin' `
    ($directUrl.Success -and $directOutput -notmatch '#') "output=$directOutput"
  Assert-That 'moe start names the foreground Ctrl-C boundary' `
    ($directOutput -match 'moe start: Ctrl-C stops this project runtime') `
    "output=$directOutput"
  if (-not $directReady.Matched -or -not $directUrl.Success) {
    throw 'direct project readiness prerequisite failed'
  }
  $directOrigin = $directUrl.Groups[1].Value
  $directPort = [int] $directUrl.Groups[2].Value
  $directBootstrap = Invoke-RestMethod -Uri "$directOrigin/bootstrap" -Method Get
  $directPairHeaders = @{
    Origin                   = $directOrigin
    'x-moe-csrf'             = [string] $directBootstrap.csrfToken
    'x-moe-protocol-version' = [string] $directBootstrap.protocolVersion
  }
  $directPairRequest = Invoke-RestMethod -Uri "$directOrigin/session/pair/request" `
    -Method Post -Headers $directPairHeaders -ContentType 'application/json' -Body '{}'
  if (-not $directPairRequest.ok -or
      [string] $directPairRequest.requestId -notmatch '^[0-9a-f]{64}$' -or
      [string] $directPairRequest.confirmationLabel -notmatch '^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$') {
    throw 'direct pairing request was malformed'
  }
  Send-MoeForegroundOperatorLine -Run $direct `
    -Line ([string] $directPairRequest.confirmationLabel)
  $directSession = $null
  $pairDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    try {
      $directSession = Invoke-RestMethod -Uri "$directOrigin/session/pair/claim" `
        -Method Post -Headers $directPairHeaders -ContentType 'application/json' `
        -Body (([ordered] @{ requestId = [string] $directPairRequest.requestId }) |
          ConvertTo-Json -Compress)
      break
    } catch {
      $status = [int] $_.Exception.Response.StatusCode
      if ($status -ne 409) { throw }
      Start-Sleep -Milliseconds 50
    }
  } while ([DateTime]::UtcNow -lt $pairDeadline)
  if ($null -eq $directSession) { throw 'direct operator approval timed out' }
  $directHeaders = @{
    Origin                     = $directOrigin
    'x-moe-csrf'               = [string] $directBootstrap.csrfToken
    'x-moe-protocol-version'   = [string] $directBootstrap.protocolVersion
    'x-moe-session-credential' = [string] $directSession.sessionCredential
  }
  $directSurface = Invoke-RestMethod -Uri "$directOrigin/affordances/read" -Method Post `
    -Headers $directHeaders -ContentType 'application/json' `
    -Body (([ordered] @{ projectId = $directBootstrap.projectId }) | ConvertTo-Json -Compress)
  Assert-That 'the externally rooted direct runtime admits its confirmed session' `
    ($directSurface.outcome -eq 'SURFACE') "outcome=$($directSurface.outcome)"
  $allDirect = @(Get-CimInstance Win32_Process)
  $directOwnedIds = [Collections.Generic.HashSet[int]]::new()
  [void] $directOwnedIds.Add([int] $direct.Process.Id)
  do {
    $changed = $false
    foreach ($process in $allDirect) {
      if ($directOwnedIds.Contains([int] $process.ParentProcessId) -and
          $directOwnedIds.Add([int] $process.ProcessId)) { $changed = $true }
    }
  } while ($changed)
  $directOwned = @($allDirect | Where-Object {
    $directOwnedIds.Contains([int] $_.ProcessId)
  })
  $directNode = @($directOwned | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -and
    $_.CommandLine.Contains('moe-cli-main.ts') -and
    $_.CommandLine.Contains('start . --operator-stdin')
  })
  if ($directNode.Count -ne 1) { throw 'direct CLI Node owner is not unique' }
  $directPrivateValues = @(
    [string] $directPairRequest.requestId,
    [string] $directPairRequest.confirmationLabel,
    [string] $directSession.sessionCredential
  )
  $directOutputAfterPairing = Read-MoeForegroundOutput -Run $direct
  $directOutputLeaks = @($directPrivateValues | Where-Object {
    $directOutputAfterPairing.Contains($_)
  })
  Assert-That 'direct pairing identities and credentials are absent from stdout and argv' `
    ($directOutputLeaks.Count -eq 0 -and @($directOwned | Where-Object {
      $commandLine = [string] $_.CommandLine
      @($directPrivateValues | Where-Object { $commandLine.Contains($_) }).Count -gt 0
    }).Count -eq 0) `
    "outputLeaks=$($directOutputLeaks.Count) privateValues=$($directPrivateValues.Count)"
  Stop-Process -Id ([int] $directNode[0].ProcessId) -Force
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $directListener = @(Get-NetTCPConnection -State Listen -LocalPort $directPort `
      -ErrorAction SilentlyContinue)
    $liveDirect = @(foreach ($prior in $directOwned) {
      $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($prior.ProcessId)" `
        -ErrorAction SilentlyContinue
      if ($null -ne $current -and $current.CreationDate -eq $prior.CreationDate) { $current }
    })
    if ($directListener.Count -eq 0 -and $liveDirect.Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  Assert-That 'killing only the direct CLI Node closes its native Job and listener' `
    ($directListener.Count -eq 0 -and $liveDirect.Count -eq 0) `
    "liveListeners=$($directListener.Count) liveOwned=$($liveDirect.Count)"
} catch {
  Assert-That 'the packaged direct-project journey completes without an exception' `
    $false $_.Exception.Message
} finally {
  if (-not $direct.Process.HasExited) { Stop-MoeForeground -Run $direct }
}

# The links a zip cannot carry. Asserted THROUGH the link - an existing
# directory would satisfy a mere existence check while resolving nothing.
$linked = Join-Path $extracted 'node_modules\@moe\contracts\package.json'
Assert-That 'the packaged CLI materialized the workspace links the zip could not carry' `
  (Test-Path $linked) "not reachable: $linked"
$callerLink = Join-Path $operatorRoot 'node_modules\@moe\contracts\package.json'
Assert-That 'the packaged CLI kept workspace links out of the external caller cwd' `
  (-not (Test-Path $callerLink)) "caller-owned path received an artifact link: $callerLink"

# Matched by COMMAND LINE, not by the global node process list. Six agents share
# this machine and a peer's vitest worker starting mid-smoke is not an orphan of
# this stack; a before/after diff over every node.exe reports it as one.
$orphans = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($extracted) } |
  ForEach-Object { "$($_.ProcessId): $($_.CommandLine)" })
Assert-That 'the stack left no node process holding the extracted artifact' `
  ($orphans.Count -eq 0) "orphans: $($orphans -join ' | ')"

Write-Host ''
if ($script:Failures.Count -gt 0) {
  Write-Host "SMOKE FAILED: $($script:Failures.Count) assertion(s) - $($script:Failures -join '; ')"
  exit 1
}
$zipMb = [math]::Round((Get-Item $Zip).Length / 1MB, 2)
Write-Host "SMOKE PASSED: every assertion held against $Zip ($zipMb MB)"
exit 0
