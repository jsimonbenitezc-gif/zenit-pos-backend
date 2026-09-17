# ============================================================================
# scripts/programar-respaldo.ps1 — que el respaldo se tome SOLO, todos los días
#
#     powershell -ExecutionPolicy Bypass -File scripts\programar-respaldo.ps1
#     powershell -ExecutionPolicy Bypass -File scripts\programar-respaldo.ps1 -Quitar
#
# Un respaldo que hay que acordarse de correr no se corre. Esto registra una
# tarea de Windows que lo hace a diario a las 2 de la tarde, y —lo importante—
# con "ejecutar en cuanto se pueda si se pasó la hora": si la laptop estaba
# apagada a las 2, el respaldo se toma al encenderla, no se pierde el día.
#
# ⚠️ ESTO NO SUSTITUYE AL PLAN PRO DE SUPABASE (~25 USD/mes). Depende de que
# esta computadora exista y se encienda. Es el piso, no el techo.
# ============================================================================

param([switch]$Quitar)

$ErrorActionPreference = 'Stop'
$NOMBRE  = 'Zenit - respaldo diario'
$backend = Split-Path -Parent $PSScriptRoot

if ($Quitar) {
    schtasks /Delete /TN $NOMBRE /F
    Write-Host "`nTarea eliminada. Los respaldos ya tomados NO se borran.`n"
    exit 0
}

if (-not (Test-Path (Join-Path $backend '.env'))) {
    Write-Host "`nNo hay .env en $backend — el respaldo no sabría a qué base conectarse.`n" -ForegroundColor Red
    exit 1
}

# `npm` es un .cmd, y el Programador de tareas no lo resuelve solo: se llama a
# node con la ruta del script, que es lo que npm haría de todas formas.
$node   = (Get-Command node).Source
$guion  = Join-Path $backend 'scripts\respaldar.js'
$bitacora = Join-Path $backend 'respaldos\ultima-corrida.log'

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Respalda la base de Zenit POS (Supabase) a una carpeta local. Supabase free no respalda nada.</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T14:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <StartWhenAvailable>true</StartWhenAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c ""$node" "$guion" &gt; "$bitacora" 2&gt;&amp;1"</Arguments>
      <WorkingDirectory>$backend</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$tmp = [System.IO.Path]::GetTempFileName() + '.xml'
[System.IO.File]::WriteAllText($tmp, $xml, [System.Text.Encoding]::Unicode)
schtasks /Create /TN $NOMBRE /XML $tmp /F | Out-Null
Remove-Item $tmp -Force

Write-Host ""
Write-Host "  Listo: '$NOMBRE' corre todos los días a las 14:00." -ForegroundColor Green
Write-Host "  Si la computadora estaba apagada, se toma al encenderla."
Write-Host "  Los archivos van a: $backend\respaldos  (se conservan los 30 últimos)"
Write-Host ""
Write-Host "  Probarla ahora:  schtasks /Run /TN `"$NOMBRE`""
Write-Host "  Quitarla:        powershell -File scripts\programar-respaldo.ps1 -Quitar"
Write-Host ""
Write-Host "  Copia esa carpeta a Drive o OneDrive: un respaldo en el mismo disco" -ForegroundColor Yellow
Write-Host "  que se puede echar a perder no es un respaldo." -ForegroundColor Yellow
Write-Host ""
