<#
.SYNOPSIS
  Установка агента EasySAM на ПК: файлы в Program Files, настройки в реестре, служба Windows.
  Токен ПК агент получает сам при первом запуске по ключу регистрации и хранит в реестре.

.DESCRIPTION
  1. Проверяет права администратора и связь с сервером (/api/health).
  2. Останавливает и удаляет прежнего агента (если был).
  3. Копирует sam-agent.exe в «C:\Program Files\SAM».
  4. Пишет в HKLM\SOFTWARE\SAM\Agent: Server, EnrollKey, Interval, UsageInterval.
  5. Закрывает раздел реестра: доступ только SYSTEM и Администраторам (пользователи ПК не прочитают ключ и токен).
  6. Ставит службу «sam-agent» (автозапуск, LocalSystem) и ждёт, пока агент зарегистрируется (появится AgentToken).

  Ключ регистрации выдаёт администратор EasySAM: POST /api/agent-enroll-keys (на ноутбуке: make enroll-key).
  Для массовой установки — deploy-sam-agent.ps1 (по сети) или этот файл как стартовый скрипт GPO/задача SCCM.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-sam-agent.ps1 -Server 192.168.249.1 -EnrollKey sek_XXXX
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-sam-agent.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Server,
  [string]$EnrollKey,
  [string]$Source = $PSScriptRoot,
  [int]$Interval = 30,
  [int]$UsageInterval = 300,
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'SAM'),
  [switch]$ReEnroll,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$RegPath = 'HKLM:\SOFTWARE\SAM\Agent'
$ServiceName = 'sam-agent'
$Exe = Join-Path $InstallDir 'sam-agent.exe'
$LogFile = Join-Path $env:ProgramData 'sam-agent\agent.log'

function Info([string]$m) { Write-Host "[SAM] $m" }
function Fail([string]$m) { Write-Host "[SAM] ОШИБКА: $m" -ForegroundColor Red; exit 1 }

$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'запустите PowerShell от имени администратора' }

function Remove-Agent {
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($svc) {
    if ($svc.Status -ne 'Stopped') {
      Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
      try { $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20)) } catch { }
    }
    & sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 1
  }
  Get-Process -Name 'sam-agent' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

if ($Uninstall) {
  Remove-Agent
  if (Test-Path $RegPath) { Remove-Item -Path $RegPath -Recurse -Force }
  if (Test-Path $InstallDir) { Remove-Item -Path $InstallDir -Recurse -Force }
  Info 'агент удалён (служба, файлы, настройки в реестре)'
  exit 0
}

if (-not $Server) { Fail 'укажите адрес сервера: -Server 192.168.249.1  (или http://host:8000)' }
if (-not $EnrollKey) { Fail 'укажите ключ регистрации: -EnrollKey sek_...  (выдаётся на сервере: make enroll-key)' }
if ($Server -notmatch '^https?://') { $Server = 'http://' + $Server }
$Server = $Server.TrimEnd('/')
if ($Server -notmatch '^https?://[^/]+:\d+') { $Server = $Server + ':8000' }

$SrcExe = Join-Path $Source 'sam-agent.exe'
if (-not (Test-Path $SrcExe)) { Fail "не найден $SrcExe (положите install-sam-agent.ps1 рядом с sam-agent.exe или укажите -Source)" }

try {
  Invoke-RestMethod -Uri ($Server + '/api/health') -TimeoutSec 10 | Out-Null
  Info "сервер $Server отвечает"
} catch {
  Fail "сервер $Server недоступен: $($_.Exception.Message)"
}

Info 'останавливаю прежнего агента (если был)'
Remove-Agent

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -Path $SrcExe -Destination $Exe -Force
Unblock-File -Path $Exe -ErrorAction SilentlyContinue   # снять пометку «скачано из интернета»
Info "агент скопирован: $Exe"

if (-not (Test-Path $RegPath)) { New-Item -Path $RegPath -Force | Out-Null }
Set-ItemProperty -Path $RegPath -Name 'Server' -Value $Server -Type String
Set-ItemProperty -Path $RegPath -Name 'EnrollKey' -Value $EnrollKey -Type String
Set-ItemProperty -Path $RegPath -Name 'Interval' -Value $Interval -Type DWord
Set-ItemProperty -Path $RegPath -Name 'UsageInterval' -Value $UsageInterval -Type DWord
if ($ReEnroll) { Remove-ItemProperty -Path $RegPath -Name 'AgentToken' -ErrorAction SilentlyContinue }
Info "настройки записаны: HKLM\SOFTWARE\SAM\Agent"

# доступ к разделу — только SYSTEM (S-1-5-18) и Администраторы (S-1-5-32-544); SID не зависят от языка Windows
$acl = Get-Acl -Path $RegPath
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
  $id = New-Object System.Security.Principal.SecurityIdentifier($sid)
  $acl.AddAccessRule((New-Object System.Security.AccessControl.RegistryAccessRule($id, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl -Path $RegPath -AclObject $acl
Info 'раздел реестра закрыт: доступ только SYSTEM и Администраторам'

& $Exe install
if ($LASTEXITCODE -ne 0) { Fail "sam-agent.exe install завершился с кодом $LASTEXITCODE (см. $LogFile)" }

Info 'жду регистрации ПК на сервере (до 60 с)…'
$deadline = (Get-Date).AddSeconds(60)
$token = $null
do {
  Start-Sleep -Seconds 2
  $token = (Get-ItemProperty -Path $RegPath -ErrorAction SilentlyContinue).AgentToken
} while (-not $token -and (Get-Date) -lt $deadline)

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($token) {
  Info "готово: ПК зарегистрирован, служба $ServiceName — $($svc.Status)"
} else {
  Write-Warning "служба $ServiceName — $($svc.Status), но токен ПК за 60 с не получен. Последние строки лога:"
  if (Test-Path $LogFile) { Get-Content -Path $LogFile -Tail 15 }
  exit 2
}
