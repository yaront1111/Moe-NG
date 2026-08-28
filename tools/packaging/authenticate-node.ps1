<#
.SYNOPSIS
Runs one tracked release entrypoint with the setup-node executable authenticated first.

.DESCRIPTION
This verifier intentionally runs under PowerShell, not Node. Asking a substituted
Node process to report its own version or hash would be circular trust. The script
resolves the setup-node installation without PATH, hashes it before any Node process
starts, then compares its exact version and launches the requested entry with argv.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $Entry,

  [Parameter()]
  [string[]] $NodeArguments = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

function Stop-WindowsRelease {
  param([Parameter(Mandatory = $true)][string] $Code)
  Write-Output "::error title=windows-release::$Code@WINDOWS_RELEASE_AUTHORITY"
  exit 1
}

function Read-ToolchainPins {
  param([Parameter(Mandatory = $true)][string] $Path)
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -and
        (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and
        $item.Length -gt 0 -and $item.Length -le 65536) {
      $pins = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop
      if ($pins.schemaVersion -ceq 'moe-toolchain-pins/1' -and
          $pins.nodeVersion -is [string] -and $pins.nodeVersion -cmatch '^v[0-9]+\.[0-9]+\.[0-9]+$' -and
          $pins.nodeSha256 -is [string] -and $pins.nodeSha256 -cmatch '^[0-9a-f]{64}$') {
        return $pins
      }
    }
  } catch {
    # The stable boundary refusal below deliberately hides parser and path details.
  }
  Stop-WindowsRelease -Code 'WINDOWS_RELEASE_INPUT_INVALID'
}

function Resolve-SetupNodeExecutable {
  param(
    [Parameter(Mandatory = $true)] $Pins,
    [Parameter(Mandatory = $true)][string] $ToolCache,
    [Parameter(Mandatory = $true)][string] $RunnerArchitecture
  )
  $architecture = switch ($RunnerArchitecture.ToUpperInvariant()) {
    'X64' { 'x64' }
    'ARM64' { 'arm64' }
    default { Stop-WindowsRelease -Code 'WINDOWS_RELEASE_INPUT_INVALID' }
  }
  try {
    if (-not [IO.Path]::IsPathRooted($ToolCache)) { throw 'relative tool cache' }
    $version = $Pins.nodeVersion.Substring(1)
    $expected = [IO.Path]::GetFullPath((Join-Path $ToolCache "node\$version\$architecture\node.exe"))
    $item = Get-Item -LiteralPath $expected -Force -ErrorAction Stop
    $resolved = [IO.Path]::GetFullPath($item.FullName)
    if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
        -not [String]::Equals($resolved, $expected, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'invalid setup-node executable'
    }
    return $resolved
  } catch {
    Stop-WindowsRelease -Code 'WINDOWS_RELEASE_INPUT_INVALID'
  }
}

function Resolve-TrackedEntry {
  param(
    [Parameter(Mandatory = $true)][string] $RepositoryRoot,
    [Parameter(Mandatory = $true)][string] $RelativeEntry
  )
  try {
    if ([IO.Path]::IsPathRooted($RelativeEntry)) { throw 'absolute entry' }
    $root = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $resolved = [IO.Path]::GetFullPath((Join-Path $root $RelativeEntry))
    $prefix = $root + [IO.Path]::DirectorySeparatorChar
    $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw 'invalid entry'
    }
    return $resolved
  } catch {
    Stop-WindowsRelease -Code 'WINDOWS_RELEASE_INPUT_INVALID'
  }
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$pins = Read-ToolchainPins -Path (Join-Path $PSScriptRoot 'toolchain-pins.json')
if ([String]::IsNullOrWhiteSpace($env:RUNNER_TOOL_CACHE) -or
    [String]::IsNullOrWhiteSpace($env:RUNNER_ARCH)) {
  Stop-WindowsRelease -Code 'WINDOWS_RELEASE_INPUT_INVALID'
}
$nodeExecutable = Resolve-SetupNodeExecutable -Pins $pins -ToolCache $env:RUNNER_TOOL_CACHE -RunnerArchitecture $env:RUNNER_ARCH

try {
  $nodeDigest = (Get-FileHash -LiteralPath $nodeExecutable -Algorithm SHA256 -ErrorAction Stop).Hash
} catch {
  Stop-WindowsRelease -Code 'WINDOWS_RELEASE_INPUT_INVALID'
}
if (-not [String]::Equals($nodeDigest, $pins.nodeSha256, [StringComparison]::OrdinalIgnoreCase)) {
  Stop-WindowsRelease -Code 'WINDOWS_RELEASE_NODE_DIGEST_MISMATCH'
}

$observedVersion = @(& $nodeExecutable '--version' 2>&1)
$versionStatus = $LASTEXITCODE
if ($versionStatus -ne 0 -or $observedVersion.Count -ne 1 -or
    -not [String]::Equals([string]$observedVersion[0], $pins.nodeVersion,
      [StringComparison]::Ordinal)) {
  Stop-WindowsRelease -Code 'WINDOWS_RELEASE_VERSION_MISMATCH'
}

$entryPath = Resolve-TrackedEntry -RepositoryRoot $repositoryRoot -RelativeEntry $Entry
[string[]] $arguments = @($entryPath) + @($NodeArguments)
& $nodeExecutable @arguments
$status = $LASTEXITCODE
exit $status
