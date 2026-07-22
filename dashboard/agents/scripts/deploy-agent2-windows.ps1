# Однокомандный деплой Zabbix Agent 2 с зеркала NetMon dashboard.
#
# Dashboard использует самоподписанный TLS. Перед irm отключите проверку сертификата:
#
#   [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
#   & ([scriptblock]::Create((irm "https://HOST:7444/agents/scripts/deploy-agent2-windows.ps1"))) `
#     -BaseUrl "https://HOST:7444" -ZabbixServer HOST -Hostname win-srv-01
#
# Альтернатива без TLS (если доступен HTTP dashboard, обычно :7081):
#   & ([scriptblock]::Create((irm "http://HOST:7081/agents/scripts/deploy-agent2-windows.ps1"))) `
#     -BaseUrl "http://HOST:7081" -ZabbixServer HOST -Hostname win-srv-01

[CmdletBinding()]
param(
  [string]$BaseUrl = $env:NETMON_BASE_URL,
  [Parameter(Mandatory = $true)][string]$ZabbixServer,
  [Parameter(Mandatory = $true)][string]$Hostname,
  [string]$MsiName = "zabbix_agent2-7.0.28-windows-amd64-openssl.msi",
  [bool]$SkipCertificateCheck = $true
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Запустите PowerShell от имени администратора."
  }
}

function Enable-InsecureTls {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
  try {
    Add-Type @"
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class NetmonTrustAllPolicy : ICertificatePolicy {
  public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) { return true; }
}
"@ -ErrorAction SilentlyContinue
    [System.Net.ServicePointManager]::CertificatePolicy = New-Object NetmonTrustAllPolicy
  } catch {
    # type may already exist from a previous run
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
if ($SkipCertificateCheck -and $BaseUrl -like "https://*") {
  Write-Warning "Downloading over HTTPS with certificate verification disabled (self-signed NetMon cert)."
  Enable-InsecureTls
} else {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$downloadOk = $false
try {
  if ($PSVersionTable.PSVersion.Major -ge 6 -and $SkipCertificateCheck) {
    Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing -SkipCertificateCheck
  } else {
    Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
  }
  $downloadOk = $true
} catch {
  if (-not $SkipCertificateCheck) { throw }
  Write-Warning "Invoke-WebRequest failed ($($_.Exception.Message)); retry with cert bypass…"
  Enable-InsecureTls
  Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
  $downloadOk = $true
}

if (-not $downloadOk -or -not (Test-Path $msiPath)) {
  throw "MSI download failed: $msiPath"
}

Write-Host "Installing $msiPath …"
$msiArgs = @(
  "/i", "`"$msiPath`"",
  "/qn",
  "/norestart",
  "SERVER=$ZabbixServer",
  "SERVERACTIVE=$ZabbixServer",
  "HOSTNAME=$Hostname",
  "ENABLEPATH=1"
)
$proc = Start-Process -FilePath "msiexec.exe" -ArgumentList $msiArgs -Wait -PassThru
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
