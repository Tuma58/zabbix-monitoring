# Установка Zabbix Agent 2 на Windows (PowerShell, от администратора)
# Пример:
#   .\install-agent2-windows.ps1 -ZabbixServer 94.181.181.43 -Hostname win-srv-01

param(
  [Parameter(Mandatory = $true)][string]$ZabbixServer,
  [Parameter(Mandatory = $true)][string]$Hostname,
  [string]$MsiPath = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not $MsiPath) {
  $MsiPath = Join-Path $Root "windows\zabbix_agent2-7.0.28-windows-amd64-openssl.msi"
}
if (-not (Test-Path $MsiPath)) {
  throw "MSI not found: $MsiPath"
}

Write-Host "Installing $MsiPath ..."
Start-Process msiexec.exe -Wait -ArgumentList @(
  "/i `"$MsiPath`"",
  "/qn",
  "SERVER=$ZabbixServer",
  "SERVERACTIVE=$ZabbixServer",
  "HOSTNAME=$Hostname",
  "ENABLEPATH=1"
)

$Conf = "C:\Program Files\Zabbix Agent 2\zabbix_agent2.conf"
if (Test-Path $Conf) {
  (Get-Content $Conf) `
    -replace '^Server=.*', "Server=$ZabbixServer" `
    -replace '^ServerActive=.*', "ServerActive=$ZabbixServer" `
    -replace '^Hostname=.*', "Hostname=$Hostname" |
    Set-Content -Encoding ASCII $Conf
}

Restart-Service "Zabbix Agent 2"
Get-Service "Zabbix Agent 2"
Write-Host "Done. Test: Test-NetConnection $ZabbixServer -Port 10051"
Write-Host "Import template: templates/os/windows_agent_active/template_os_windows_agent_active.yaml"
