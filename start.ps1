<#
  Starts both agents and opens the demo page.
    powershell -ExecutionPolicy Bypass -File start.ps1

  Champions Group Agent  http://127.0.0.1:9100  (A2A + MCP + OAuth)
  Personal Agent + demo  http://127.0.0.1:9200
#>

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Python = Join-Path $Root ".venv\Scripts\python.exe"

if (-not (Test-Path $Python)) {
    Write-Host "Creating virtual environment and installing requirements..."
    python -m venv (Join-Path $Root ".venv")
    & $Python -m pip install -q -r (Join-Path $Root "requirements.txt")
}

function Start-Agent($module, $port) {
    Start-Process -FilePath $Python -WorkingDirectory $Root -WindowStyle Minimized `
        -ArgumentList "-m", "uvicorn", "$module`:app", "--host", "127.0.0.1", "--port", "$port"
}

Start-Agent "champions.app" 9100
Start-Agent "personal.app" 9200

$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    try { Invoke-RestMethod "http://127.0.0.1:9200/api/health" -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep 1 }
}
Write-Host "Demo:      http://127.0.0.1:9200" -ForegroundColor Green
Write-Host "Agent Lab: http://127.0.0.1:9100/lab" -ForegroundColor Green
Start-Process "http://127.0.0.1:9200"
