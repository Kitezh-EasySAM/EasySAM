<#
.SYNOPSIS
  Массовая установка агента EasySAM на список ПК по сети (административная шара C$ + WinRM).

.DESCRIPTION
  Для каждого ПК: копирует sam-agent.exe и install-sam-agent.ps1 в \\ПК\C$\Windows\Temp\sam-agent,
  запускает установку удалённо (Invoke-Command) и собирает итог в таблицу.
  Требования: учётная запись — администратор на целевых ПК; на ПК включён WinRM (Enable-PSRemoting);
  открыт доступ к C$. Для доменов без WinRM — используйте install-sam-agent.ps1 как стартовый скрипт GPO.

.EXAMPLE
  .\deploy-sam-agent.ps1 -Computers PC-0142,PC-0087 -Server 10.0.0.5 -EnrollKey sek_XXXX
.EXAMPLE
  .\deploy-sam-agent.ps1 -ComputersFile .\pcs.txt -Server 10.0.0.5 -EnrollKey sek_XXXX
#>
[CmdletBinding()]
param(
  [string[]]$Computers,
  [string]$ComputersFile,
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$EnrollKey,
  [string]$Source = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
if ($ComputersFile) { $Computers += Get-Content -Path $ComputersFile | Where-Object { $_.Trim() -and -not $_.StartsWith('#') } }
if (-not $Computers) { Write-Host 'укажите -Computers или -ComputersFile'; exit 1 }
foreach ($f in 'sam-agent.exe', 'install-sam-agent.ps1') {
  if (-not (Test-Path (Join-Path $Source $f))) { Write-Host "не найден $f в $Source"; exit 1 }
}

$results = foreach ($pc in $Computers) {
  $pc = $pc.Trim()
  try {
    $remoteDir = "\\$pc\C$\Windows\Temp\sam-agent"
    New-Item -ItemType Directory -Path $remoteDir -Force | Out-Null
    Copy-Item -Path (Join-Path $Source 'sam-agent.exe'), (Join-Path $Source 'install-sam-agent.ps1') -Destination $remoteDir -Force
    $out = Invoke-Command -ComputerName $pc -ArgumentList $Server, $EnrollKey -ScriptBlock {
      param($s, $k)
      # вывод установщика — в переменную, иначе он попадёт в результат вместе с объектом
      $log = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\Windows\Temp\sam-agent\install-sam-agent.ps1' -Server $s -EnrollKey $k 2>&1 | Out-String
      [pscustomobject]@{ Code = $LASTEXITCODE; Log = $log }
    }
    $res = if ($out.Code -eq 0) { 'установлен' } else { "код $($out.Code): " + (($out.Log -split "`n" | Select-Object -Last 3) -join ' ') }
    [pscustomobject]@{ Computer = $pc; Result = $res }
  } catch {
    [pscustomobject]@{ Computer = $pc; Result = "ошибка: $($_.Exception.Message)" }
  }
}
$results | Format-Table -AutoSize
