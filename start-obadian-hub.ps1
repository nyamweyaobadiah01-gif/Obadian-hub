$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$siteUrl = "http://127.0.0.1:3000/"
$healthUrl = "http://127.0.0.1:3000/api/session"

function Test-HubIsRunning {
  try {
    $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (Test-HubIsRunning) {
  Write-Host "Obadian Hub is ready. Opening the sign-in page."
  Start-Process $siteUrl
  exit 0
}

Write-Host "Starting Obadian Hub."
$server = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $projectRoot -NoNewWindow -PassThru

try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    if ($server.HasExited) {
      throw "The Obadian Hub server exited before it became ready. Check that Node.js 22.5 or later is installed."
    }
    if (Test-HubIsRunning) {
      $ready = $true
      break
    }
    Start-Sleep -Seconds 1
  }

  if (-not $ready) {
    throw "Obadian Hub did not respond at $siteUrl within 30 seconds."
  }

  Write-Host "Obadian Hub is ready. Opening the sign-in page."
  Start-Process $siteUrl
  Wait-Process -Id $server.Id
} catch {
  if (-not $server.HasExited) {
    Stop-Process -Id $server.Id
  }
  throw
}
