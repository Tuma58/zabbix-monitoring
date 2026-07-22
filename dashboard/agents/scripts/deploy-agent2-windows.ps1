# Однокомандный деплой Zabbix Agent 2 с зеркала NetMon dashboard.
#
# Примеры (PowerShell от имени администратора):
#
#   irm "https://HOST:7444/agents/scripts/deploy-agent2-windows.ps1" | iex
#   # затем вызовите с параметрами, либо:
#
#   & ([scriptblock]::Create((irm "https://HOST:7444/agents/scripts/deploy-agent2-windows.ps1"))) `
#     -BaseUrl "https://HOST:7444" -ZabbixServer HOST -Hostname win-srv-01
#
#   $env:NETMON_BASE_URL = "https://HOST:7444"
#   & ([scriptblock]::Create((irm "$env:NETMON_BASE_URL/agents/scripts/deploy-agent2-windows.ps1"))) `
#     -ZabbixServer HOST -Hostname win-srv-01

[CmdletBinding()]
param(
  [string]$BaseUrl = $env:NETMON_BASE_URL,
  [Parameter(Mandatory = $true)][string]$ZabbixServer,
  [Parameter(Mandatory = $true)][string]$Hostname,
  [string]$MsiName = "zabbix_agent2-7.0.28-windows-amd64-openssl.msi"
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Запустите PowerShell от имени администратора."
  }
}

Assert-Admin

if (-not $BaseUrl) {
  $BaseUrl = "https://${ZabbixServer}:7444"
}
$BaseUrl = $BaseUrl.TrimEnd("/")

$msiUrl = "$BaseUrl/agents/windows/$MsiName"
$msiPath = Join-Path $env:TEMP $MsiName

Write-Host "↓ $msiUrl"
# TLS 1.2 for older Windows; ignore self-signed lab certs if needed via env
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
  Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
} catch {
  # Fallback for self-signed HTTPS on lab VPS
  Write-Warning "Invoke-WebRequest failed ($($_.Exception.Message)); retry with cert bypass…"
  add-type @"
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class NetmonTrustAll : ICertificatePolicy {
  public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) { return true; }
}
"@
  [System.Net.ServicePointManager]::CertificatePolicy = New-Object NetmonTrustAll
  Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
}

if (-not (Test-Path $msiPath)) {
  throw "MSI download failed: $msiPath"
}

Write-Host "Installing $msiPath …"
$args = @(
  "/i", "`"$msiPath`"",
  "/qn",
  "/norestart",
  "SERVER=$ZabbixServer",
  "SERVERACTIVE=$ZabbixServer",
  "HOSTNAME=$Hostname",
  "ENABLEPATH=1"
)
$proc = Start-Process -FilePath "msiexec.exe" -ArgumentList $args -Wait -PassThru
if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
  throw "msiexec failed with exit code $($proc.ExitCode)"
}

$Conf = "C:\Program Files\Zabbix Agent 2\zabbix_agent2.conf"
if (Test-Path $Conf) {
  (Get-Content $Conf) `
    -replace '^Server=.*', "Server=$ZabbixServer" `
    -replace '^ServerActive=.*', "ServerActive=$ZabbixServer" `
    -replace '^Hostname=.*', "Hostname=$Hostname" |
    Set-Content -Encoding ASCII $Conf
}

Restart-Service "Zabbix Agent 2" -ErrorAction SilentlyContinue
Start-Service "Zabbix Agent 2" -ErrorAction SilentlyContinue
Get-Service "Zabbix Agent 2"

Write-Host ""
Write-Host "OK: Zabbix Agent 2 installed"
Write-Host "  Hostname=$Hostname"
Write-Host "  Server=$ZabbixServer"
Write-Host "  Mirror=$BaseUrl"
Write-Host "Import template: $BaseUrl/templates/os/windows_agent_active/template_os_windows_agent_active.yaml"
Write-Host "Check: Test-NetConnection $ZabbixServer -Port 10051"
