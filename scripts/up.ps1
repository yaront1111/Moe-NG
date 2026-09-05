# Start moe-next against ANY project: the daemon, the agent wrapper, and the control
# room the daemon hosts, plus a second window that watches the seats work.
#
#   .\scripts\up.ps1 -Project D:\projexts\UnAI
#   .\scripts\up.ps1 -Project D:\projexts\UnAI -Token      # token for this run only
#   .\scripts\up.ps1 -Project D:\projexts\UnAI -Agents 1   # one seat at a time
#
# Everything project-shaped is derived from -Project: the durable store, the node
# specs, and the workspace the seats build in all live under <Project>\.moe-next.
# Ctrl-C in this window stops the daemon and the wrapper.
#
# A token passed with -Token lives in THIS PowerShell process only. It is never
# written to disk, never placed on a command line, and is scrubbed on the way out,
# including on Ctrl-C. Without it, seats answer from your ordinary Claude sign-in.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $Project,
  [string] $ProjectId,
  [string] $TestCommand = "pnpm test",
  [int]    $Agents = 2,
  [switch] $Token,
  [switch] $SkipBuild
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not (Test-Path -LiteralPath $Project -PathType Container)) {
  Write-Host "moe-next: no such project directory: $Project" -ForegroundColor Red
  exit 1
}
$Project = (Resolve-Path -LiteralPath $Project).Path
$moeDir  = Join-Path $Project ".moe-next"
# `*.local.*` is the conventional git-ignored name under a project's .moe-next.
$logFile = Join-Path $moeDir "up.local.log"
if (-not (Test-Path -LiteralPath $moeDir)) { New-Item -ItemType Directory -Path $moeDir | Out-Null }
if (-not $ProjectId) { $ProjectId = (Split-Path -Leaf $Project).ToLowerInvariant() }

# --- Project identity. The durable store lives beside the project, not in this repo.
$env:MOE_PROJECT_ID = $ProjectId
$env:MOE_STORE_PATH = Join-Path $moeDir "store.sqlite"
$specsDir = Join-Path $moeDir "node-specs"
if (Test-Path -LiteralPath $specsDir) { $env:MOE_NODE_SPECS_DIR = $specsDir }

# --- Compiled-plan host facts: where agents build, and how their work is verified.
# A plan an agent submits can never name a host path or a shell command; these two do.
$env:MOE_NODE_WORKSPACE     = $Project
$env:MOE_NODE_TEST_COMMAND  = $TestCommand
$env:MOE_WRAPPER_MAX_AGENTS = "$Agents"

# --- Dev secrets, derived per project so two projects never share a daemon credential.
# Local machine only; replace both for anything you care about keeping.
if (-not $env:MOE_DAEMON_CREDENTIAL) { $env:MOE_DAEMON_CREDENTIAL = "$ProjectId-dev-daemon-credential-change-me" }
if (-not $env:MOE_CSRF_TOKEN)        { $env:MOE_CSRF_TOKEN        = "$ProjectId-dev-csrf-change-me" }

# --- Agent credential. A seat is spawned WITHOUT --bare, so with no ANTHROPIC_* variable
# set it answers from your sign-in. An environment token takes precedence over that
# sign-in, which is why -Token is opt-in and is removed again when this window exits.
$tokenWasSet = $false
if ($Token) {
  $secure = Read-Host "CLAUDE_CODE_OAUTH_TOKEN for this run (claude setup-token)" -AsSecureString
  $plain  = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
              [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  if ([string]::IsNullOrWhiteSpace($plain)) {
    Write-Host "moe-next: empty token, falling back to your Claude sign-in." -ForegroundColor Yellow
  } else {
    $env:CLAUDE_CODE_OAUTH_TOKEN = $plain
    $tokenWasSet = $true
    Write-Host "moe-next: token set for this window only; it is scrubbed on exit." -ForegroundColor Green
  }
  $plain = $null
  Remove-Variable plain, secure -ErrorAction SilentlyContinue
}

$signInDir  = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME ".claude" }
$signInFile = Join-Path $signInDir ".credentials.json"
if (-not $env:CLAUDE_CODE_OAUTH_TOKEN -and -not $env:ANTHROPIC_AUTH_TOKEN -and
    -not $env:ANTHROPIC_API_KEY -and -not (Test-Path -LiteralPath $signInFile)) {
  Write-Host "moe-next: no Claude sign-in and no credential in the environment." -ForegroundColor Yellow
  Write-Host "  Sign in once:  claude   then  /login" -ForegroundColor Yellow
  Write-Host "  Or pass a token for this run:  .\scripts\up.ps1 -Project $Project -Token" -ForegroundColor Yellow
  exit 1
}

$watcher = $null
$consoleEncoding = $null
try {
  Push-Location $repoRoot

  # The control room a source checkout does not carry. Cheap, so rebuild unless told not to.
  if (-not $SkipBuild) {
    Write-Host "moe-next: building the control room..." -ForegroundColor Cyan
    pnpm --filter @moe/control-room build | Out-Null
  }

  # Second window: the seat watcher, reading the log this window is about to write.
  # Truncate through a share-tolerant handle: a watcher window (or any `tail -f`) still
  # reading the previous run's log must not stop this run from starting. Set-Content
  # asks for exclusive access and failed on exactly that (2026-09-05).
  $logStream = [System.IO.File]::Open($logFile, [System.IO.FileMode]::Create,
    [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
  $logStream.Close()
  $shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell" }
  $watcher = Start-Process $shell -PassThru -ArgumentList @(
    "-NoExit", "-NoProfile",
    "-File", (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "watch.ps1"),
    "-LogFile", $logFile, "-Title", $ProjectId)

  Write-Host ""
  Write-Host "moe-next: project    $ProjectId"
  Write-Host "moe-next: store      $env:MOE_STORE_PATH"
  Write-Host "moe-next: workspace  $env:MOE_NODE_WORKSPACE   seats $Agents   verify '$TestCommand'"
  Write-Host "OPEN THE #pair= URL BELOW WITHIN 60 SECONDS. It is a one-use bearer." -ForegroundColor Yellow
  Write-Host ""

  # Seat prose is UTF-8 (em-dashes, section signs, arrows). PowerShell decodes a native
  # command's output with the console's OEM code page (ibm850 on this host) unless told
  # otherwise, and Tee-Object would then write that mojibake into the log for good.
  $consoleEncoding = [Console]::OutputEncoding
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

  pnpm start 2>&1 | Tee-Object -FilePath $logFile -Append
}
finally {
  Pop-Location -ErrorAction SilentlyContinue
  if ($consoleEncoding) { [Console]::OutputEncoding = $consoleEncoding }
  if ($tokenWasSet) {
    [Environment]::SetEnvironmentVariable("CLAUDE_CODE_OAUTH_TOKEN", $null)
    Write-Host "moe-next: CLAUDE_CODE_OAUTH_TOKEN scrubbed from this window." -ForegroundColor Green
  }
  if ($watcher -and -not $watcher.HasExited) {
    Write-Host "moe-next: the watcher window is still open; close it when you are done." -ForegroundColor Cyan
  }
}
