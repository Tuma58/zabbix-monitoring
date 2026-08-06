# AIMon — установка Checkmk-агента и автодобавление узла в мониторинг (Windows).
#
# PowerShell от администратора:
#   [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
#   & ([scriptblock]::Create((irm "https://HOST:7444/agents/install-windows.ps1"))) `
#       -Server HOST -Token <REG_TOKEN> -Hostname auto
#
# Или с HTTP (без TLS):
#   & ([scriptblock]::Create((irm "http://HOST:7081/agents/install-windows.ps1"))) `
#       -Server HOST -Token <REG_TOKEN>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$BaseUrl  = "",
  [string]$Token    = "",
  [string]$Hostname = "auto",
  [bool]$SkipCertificateCheck = $true
)

$ErrorActionPreference = "Stop"
$CmkVersion = "2.3.0p48"

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Запустите PowerShell от имени администратора."
  }
}
Assert-Admin

if (-not $BaseUrl)             { $BaseUrl  = "https://${Server}:7444" }
$BaseUrl = $BaseUrl.TrimEnd("/")
if ($Hostname -eq "auto" -or -not $Hostname) { $Hostname = [System.Net.Dns]::GetHostName() }

# Обход самоподписанного TLS
if ($SkipCertificateCheck) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
}

Write-Host "AIMon: устанавливаю Checkmk ${CmkVersion} агент для «${Hostname}» → сервер ${Server}"

# 1) Скачать MSI с дашборда AIMon
$msi = Join-Path $env:TEMP "check_mk_agent.msi"
Write-Host "↓ check_mk_agent.msi (${BaseUrl}/agents/windows/check_mk_agent.msi)"
Invoke-WebRequest -Uri "${BaseUrl}/agents/windows/check_mk_agent.msi" `
  -OutFile $msi -UseBasicParsing

# 2) Тихая установка MSI
Write-Host "Устанавливаю агент…"
$proc = Start-Process msiexec.exe -Wait -PassThru `
  -ArgumentList @("/i", "`"$msi`"", "/qn", "/norestart")
if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
  throw "msiexec завершился с кодом $($proc.ExitCode)"
}
Write-Host "  ✓ MSI установлен."

# 3) Регистрация через cmk-agent-ctl (TLS encrypted transport)
$ctl = "C:\Program Files (x86)\checkmk\service\cmk-agent-ctl.exe"
if ((Test-Path $ctl) -and $Token) {
  Write-Host "Регистрирую agent-controller…"
  & $ctl register `
    --server   $Server `
    --site     cmk `
    --hostname $Hostname `
    --user     automation `
    --password $Token `
    --trust-cert
}

# 4) Автодобавление узла в AIMon backend
Write-Host "Регистрирую узел в AIMon backend…"
$ip   = (Get-NetIPAddress -AddressFamily IPv4 |
         Where-Object { $_.IPAddress -notlike "127.*" } |
         Select-Object -First 1).IPAddress
$body = @{ hostname = $Hostname; ip = $ip; os = "windows"; token = $Token } |
        ConvertTo-Json -Compress
try {
  $params = @{
    Uri         = "${BaseUrl}/api/v1/agents/register"
    Method      = "Post"
    Body        = $body
    ContentType = "application/json"
  }
  if ($PSVersionTable.PSVersion.Major -ge 6 -and $SkipCertificateCheck) {
    $params['SkipCertificateCheck'] = $true
  }
  Invoke-RestMethod @params | Out-Null
  Write-Host "  ✓ Узел «${Hostname}» добавлен в мониторинг."
} catch {
  Write-Warning "Автодобавление не удалось: $($_.Exception.Message). Добавьте узел вручную в дашборде."
}

Write-Host ""
Write-Host "✓ Готово: агент Checkmk ${CmkVersion} установлен."
Write-Host "  Узел «${Hostname}» появится в мониторинге через 1–2 минуты."
