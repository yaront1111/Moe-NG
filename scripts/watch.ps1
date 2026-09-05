# The second window: follows a launcher log and colours the lines that matter.
# Opened automatically by up.ps1; run it by hand any time to re-attach:
#   .\scripts\watch.ps1 -LogFile D:\projexts\UnAI\.moe-next\up.local.log
param(
  [Parameter(Mandatory = $true)]
  [string] $LogFile,
  [string] $Title = "moe-next"
)

$Host.UI.RawUI.WindowTitle = "moe-next - $Title seats"
Write-Host "watching $LogFile" -ForegroundColor Cyan
Write-Host "seat spawns, verdicts, landings and publishes appear here. Ctrl-C to stop watching." -ForegroundColor DarkGray
Write-Host ""

while (-not (Test-Path -LiteralPath $LogFile)) { Start-Sleep -Milliseconds 300 }

# One rule per pattern: the marker to match, and the colour to say it in.
$rules = @(
  @{ Match = "#pair="; Colour = "Yellow" }
  @{ Match = "listening on"; Colour = "Cyan" }
  @{ Match = "SPAWNED|staffing|claimed"; Colour = "Green" }
  @{ Match = "\[verifier\]|ACCEPTED|REJECTED"; Colour = "Magenta" }
  @{ Match = "\[lander\]|COMMITTED"; Colour = "Blue" }
  @{ Match = "\[publisher\]|PUSHED"; Colour = "Blue" }
  @{ Match = "REFUSED|BLOCKED|_EXIT|error|Error"; Colour = "Red" }
)

# The log is UTF-8 (up.ps1 writes it that way); say so rather than trust the shell's default.
Get-Content -LiteralPath $LogFile -Wait -Tail 20 -Encoding utf8 | ForEach-Object {
  $line = $_
  $colour = $null
  foreach ($rule in $rules) {
    if ($line -match $rule.Match) { $colour = $rule.Colour; break }
  }
  if ($colour) { Write-Host $line -ForegroundColor $colour } else { Write-Host $line -ForegroundColor DarkGray }
}
