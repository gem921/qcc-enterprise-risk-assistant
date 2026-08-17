$ErrorActionPreference = "Stop"

$projectDir = $PSScriptRoot
$runtimeDir = Join-Path $projectDir "runtime"
$pidFile = Join-Path $runtimeDir "ui-server.pid"
$serverScript = Join-Path $projectDir "qcc-risk-rpa-ui.mjs"
$hostName = "127.0.0.1"
$port = 18080
$url = "http://${hostName}:${port}/"

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

$nodeExe = (Get-Command node -ErrorAction Stop).Source

function Get-ListenerPid {
  $line = netstat -ano -p TCP | Select-String -Pattern "^\s*TCP\s+$([regex]::Escape($hostName)):$port\s+\S+\s+LISTENING\s+(\d+)\s*$" | Select-Object -First 1
  if ($line -and $line.Matches.Count) {
    return [int]$line.Matches[0].Groups[1].Value
  }
  return $null
}

function Test-ProjectInstance([int]$processId) {
  try {
    $state = Invoke-RestMethod -Uri "${url}api/state" -TimeoutSec 2
    return $state.instance.pid -eq $processId -and
      [System.IO.Path]::GetFullPath([string]$state.instance.projectDir).TrimEnd('\') -eq
      [System.IO.Path]::GetFullPath($projectDir).TrimEnd('\')
  } catch {
    return $false
  }
}

$listenerPid = Get-ListenerPid
$recordedPid = $null
if (Test-Path -LiteralPath $pidFile) {
  $pidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if ($pidText -match '^\d+$') {
    $recordedPid = [int]$pidText
  }
}

if ($listenerPid) {
  $listenerProcess = Get-Process -Id $listenerPid -ErrorAction SilentlyContinue
  $isNode = $listenerProcess -and $listenerProcess.ProcessName -eq "node"
  $isRecordedInstance = $recordedPid -and $recordedPid -eq $listenerPid
  $isProjectInstance = Test-ProjectInstance $listenerPid

  if (-not $isNode -or (-not $isRecordedInstance -and -not $isProjectInstance)) {
    throw "Port $port is occupied by PID $listenerPid, but it is not a verified QCC Risk RPA UI instance."
  }

  Write-Host "Stopping previous QCC Risk RPA UI process (PID $listenerPid)..."
  Stop-Process -Id $listenerPid -Force
  for ($attempt = 0; $attempt -lt 30 -and (Get-ListenerPid); $attempt += 1) {
    Start-Sleep -Milliseconds 100
  }
}

if (Get-ListenerPid) {
  throw "Port $port was not released after stopping the previous service."
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $nodeExe
$startInfo.Arguments = "`"$serverScript`" --host $hostName --port $port"
$startInfo.WorkingDirectory = $projectDir
$startInfo.UseShellExecute = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($startInfo)

for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
  Start-Sleep -Milliseconds 100
  if ($process.HasExited) {
    throw "UI service exited during startup with code $($process.ExitCode)."
  }
  if ((Get-ListenerPid) -eq $process.Id -and (Test-ProjectInstance $process.Id)) {
    Write-Host "QCC Risk RPA UI started (PID $($process.Id))."
    Write-Host "URL: $url"
    try {
      Start-Process $url
    } catch {
      Write-Warning "The browser could not be opened automatically. Open $url manually."
    }
    exit 0
  }
}

Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
throw "UI service did not become ready within 5 seconds."
