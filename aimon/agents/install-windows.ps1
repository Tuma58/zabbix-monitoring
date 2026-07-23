# AIMon — установка Checkmk-агента и АВТОДОБАВЛЕНИЕ узла в мониторинг (Windows).
#
# PowerShell от администратора:
#   [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
#   & ([scriptblock]::Create((irm "https://HOST/agents/install-windows.ps1"))) `
#     -Server HOST -Token <REG_TOKEN> -Hostname auto

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$BaseUrl = "",
  [string]$Token = "",
  [string]$Hostname = "auto",
  [bool]$SkipCertificateCheck = $true
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Запустите PowerShell от имени администратора."
  }
}
Assert-Admin

if (-not $BaseUrl) { $BaseUrl = "https://$Server" }
$BaseUrl = $BaseUrl.TrimEnd("/")
if ($Hostname -eq "auto" -or -not $Hostname) { $Hostname = [System.Net.Dns]::GetHostName() }

if ($SkipCertificateCheck) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
}

$msi = Join-Path $env:TEMP "check-mk-agent.msi"
Write-Host "Downloading Checkmk agent…"
Invoke-WebRequest -Uri "$BaseUrl/agent/check-mk-agent.msi" -OutFile $msi -UseBasicParsing

Write-Host "Installing agent…"
$proc = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @("/i", "`"$msi`"", "/qn", "/norestart")
if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) { throw "msiexec failed: $($proc.ExitCode)" }

# Регистрация agent controller (TLS)
$ctl = "C:\Program Files (x86)\checkmk\service\cmk-agent-ctl.exe"
if ((Test-Path $ctl) -and $Token) {
  Write-Host "Registering agent controller…"
  & $ctl register --server $Server --site cmk --hostname $Hostname --user automation --password $Token --trust-cert
}

# Автодобавление узла в backend AIMon
Write-Host "Auto-registering node in AIMon backend…"
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" } | Select-Object -First 1).IPAddress
$body = @{ hostname = $Hostname; ip = $ip; os = "windows"; token = $Token } | ConvertTo-Json
try {
  if ($PSVersionTable.PSVersion.Major -ge 6 -and $SkipCertificateCheck) {
    Invoke-RestMethod -Uri "$BaseUrl/api/v1/agents/register" -Method Post -Body $body -ContentType "application/json" -SkipCertificateCheck
  } else {
    Invoke-RestMethod -Uri "$BaseUrl/api/v1/agents/register" -Method Post -Body $body -ContentType "application/json"
  }
  Write-Host "OK: узел '$Hostname' добавлен в мониторинг автоматически."
} catch {
  Write-Warning "Backend auto-register не удался: $($_.Exception.Message). Добавьте узел вручную в дашборде."
}
