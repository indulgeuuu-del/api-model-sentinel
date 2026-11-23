param([switch]$Demo, [switch]$NoOpen, [string]$DataDir = '', [int]$Port = 0)
$ErrorActionPreference = 'Stop'
$taskNode = (Get-Command node -ErrorAction Stop).Source
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskCli = Join-Path $taskRoot 'bin\sentinel.cjs'
$taskVersion = & $taskNode -p 'process.versions.node'
if ([version]$taskVersion -lt [version]'22.14.0') { throw 'Node.js 22.14+ is required. Install Node.js LTS from https://nodejs.org/.' }
if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA ('ApiModelSentinel' + $(if ($Demo) { '-demo' } else { '' })) }
$DataDir = [IO.Path]::GetFullPath($DataDir)
if (-not $Port) { $Port = $(if ($Demo) { 17656 } else { 17655 }) }
$taskCommon = @('--data-dir', $DataDir)
if ($Demo) { $taskCommon += '--demo' }
function Test-SentinelRunning {
  $taskPreviousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $taskNode $taskCli status @taskCommon 2>$null | Out-Null
  $taskRunning = $LASTEXITCODE -eq 0
  $ErrorActionPreference = $taskPreviousPreference
  return $taskRunning
}
if (Test-SentinelRunning) {
  if (-not $NoOpen) { & $taskNode $taskCli open @taskCommon }
  Write-Output 'Service is already running. Your saved monitor settings are unchanged.'
  exit 0
}
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
if ($DataDir.Contains('"') -or $taskCli.Contains('"')) { throw 'A path cannot contain a double quote.' }
$taskArguments = '"' + $taskCli + '" supervise --data-dir "' + $DataDir + '" --port ' + $Port
if ($Demo) { $taskArguments += ' --demo' }
if (-not $NoOpen) { $taskArguments += ' --open' }
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList $taskArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $DataDir 'service.log') -RedirectStandardError (Join-Path $DataDir 'service-error.log')
for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $taskHealth = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/health') -TimeoutSec 1
    if ($taskHealth.service -eq 'api-model-sentinel' -and [bool]$taskHealth.demo -eq [bool]$Demo) {
      if (Test-SentinelRunning) { Write-Output ('Background service ready: http://127.0.0.1:' + $Port + '/'); exit 0 }
    }
  } catch { }
  if ($taskProcess.HasExited) { break }
}
throw ('Service did not become ready. Inspect ' + (Join-Path $DataDir 'service-error.log') + '. Do not publish this data directory.')
