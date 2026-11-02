# Monitor del equipo para el panel de VOZ: temperatura y carga de CPU y GPU,
# memoria RAM y VRAM. Lee con LibreHardwareMonitorLib y escribe la muestra en
# -OutFile; el host lo lanza una sola vez y lo deja vivo porque Open() de la
# librería tarda un par de segundos y las muestras llegan cada 2 s.
#
# La temperatura de la CPU exige permisos de administrador: sin ellos la
# librería no carga su controlador y ese campo sale null. El resto se lee igual.
#
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File sysmon-lhm.ps1 `
#        -OutFile <ruta json> [-IntervalMs 2000] [-ParentPid 0] [-Dll <dll>]
param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [int]$ParentPid = 0,
  [int]$IntervalMs = 2000,
  [string]$Dll = ""
)

$ErrorActionPreference = "Stop"

# Windows crea la consola del proceso elevado aunque Start-Process lleve
# -WindowStyle Hidden (RunAs ignora ese flag), así que se oculta desde dentro.
# Sin consola GetConsoleWindow devuelve cero y no hay nada que ocultar.
try {
  Add-Type -Namespace AlfredSysMon -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern System.IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
  $console = [AlfredSysMon.Native]::GetConsoleWindow()
  if ($console -ne [System.IntPtr]::Zero) {
    [void][AlfredSysMon.Native]::ShowWindow($console, 0)
  }
}
catch { }

# La DLL vive en resources/lhm; se admite también junto al propio script.
if (-not $Dll) {
  $Dll = Join-Path $PSScriptRoot "lhm\LibreHardwareMonitorLib.dll"
  if (-not (Test-Path -LiteralPath $Dll)) {
    $Dll = Join-Path $PSScriptRoot "LibreHardwareMonitorLib.dll"
  }
}

# Un solo proceso por sesión de Windows: dos ventanas de VS Code comparten el
# fichero de muestras y no hay razón para leer el hardware dos veces.
$mutex = $null
$created = $false
try {
  $mutex = [System.Threading.Mutex]::new($false, "Local\AlfredSysMon", [ref]$created)
}
catch {
  exit 0
}
if (-not $created) {
  $mutex.Dispose()
  exit 0
}

$utf8 = New-Object System.Text.UTF8Encoding($false)

# Escribe el JSON en un temporal y lo mueve encima: el host nunca lee un
# fichero a medio escribir.
function Save-Sample([string]$Text) {
  $tmp = "$OutFile.tmp"
  [System.IO.File]::WriteAllText($tmp, $Text, $utf8)
  Move-Item -LiteralPath $tmp -Destination $OutFile -Force
}

function Now() {
  return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

# Valor del sensor, o $null si no existe o no ha leído nada. Un 0 en
# temperatura o memoria es "no leído" (sin permisos, LHM devuelve 0).
function Get-Value($sensor, [bool]$zeroIsNull) {
  if ($null -eq $sensor) { return $null }
  $v = $sensor.Value
  if ($null -eq $v) { return $null }
  $n = [double]$v
  if ($zeroIsNull -and $n -le 0) { return $null }
  return $n
}

function Find-Sensor($hardware, $type, [string]$name) {
  if ($null -eq $hardware) { return $null }
  return $hardware.Sensors |
    Where-Object { $_.SensorType -eq $type -and $_.Name -eq $name } |
    Select-Object -First 1
}

# La carpeta de destino puede no existir todavía (globalStorage nuevo).
$outDir = Split-Path -Parent $OutFile
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

$computer = $null
try {
  Add-Type -Path $Dll
  $computer = New-Object LibreHardwareMonitor.Hardware.Computer
  $computer.IsCpuEnabled = $true
  $computer.IsGpuEnabled = $true
  $computer.IsMemoryEnabled = $true
  $computer.Open()

  $cpuHw = $computer.Hardware | Where-Object { $_.HardwareType -eq [LibreHardwareMonitor.Hardware.HardwareType]::Cpu } |
    Select-Object -First 1
  $ramHw = $computer.Hardware | Where-Object { $_.HardwareType -eq [LibreHardwareMonitor.Hardware.HardwareType]::Memory } |
    Select-Object -First 1

  # GPU primaria: NVIDIA, luego AMD, luego Intel. Con varias del mismo tipo se
  # queda la primera de la lista.
  $gpuHw = $computer.Hardware | Where-Object { $_.HardwareType -eq [LibreHardwareMonitor.Hardware.HardwareType]::GpuNvidia } |
    Select-Object -First 1
  if (-not $gpuHw) {
    $gpuHw = $computer.Hardware | Where-Object { $_.HardwareType -eq [LibreHardwareMonitor.Hardware.HardwareType]::GpuAmd } |
      Select-Object -First 1
  }
  if (-not $gpuHw) {
    $gpuHw = $computer.Hardware | Where-Object { $_.HardwareType -eq [LibreHardwareMonitor.Hardware.HardwareType]::GpuIntel } |
      Select-Object -First 1
  }

  $gpuName = if ($gpuHw) { [string]$gpuHw.Name } else { $null }
  $GiB = 1073741824
  $MiB = 1048576

  while ($true) {
    # Si el padre (VS Code) desaparece, se sale solo: un proceso elevado no se
    # puede matar desde el host.
    if ($ParentPid -gt 0) {
      if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    }

    try {
      foreach ($hw in @($cpuHw, $gpuHw, $ramHw)) {
        if ($hw) { $hw.Update() }
      }

      # CPU: en AMD la lectura buena es "Core (Tctl/Tdie)"; en Intel, "CPU Package".
      # Ojo: un tipo suelto como `[Tipo]::Valor` llega al parámetro como texto, de
      # ahí los paréntesis en cada llamada.
      $cpuTemp = Get-Value (Find-Sensor $cpuHw ([LibreHardwareMonitor.Hardware.SensorType]::Temperature) "Core (Tctl/Tdie)") $true
      if ($null -eq $cpuTemp) {
        $cpuTemp = Get-Value (Find-Sensor $cpuHw ([LibreHardwareMonitor.Hardware.SensorType]::Temperature) "CPU Package") $true
      }
      if ($null -eq $cpuTemp) {
        $cpuTemp = Get-Value (Find-Sensor $cpuHw ([LibreHardwareMonitor.Hardware.SensorType]::Temperature) "Package") $true
      }
      if ($null -eq $cpuTemp -and $cpuHw) {
        $fallback = $cpuHw.Sensors |
          Where-Object { $_.SensorType -eq [LibreHardwareMonitor.Hardware.SensorType]::Temperature -and $_.Value -gt 0 } |
          Select-Object -First 1
        $cpuTemp = Get-Value $fallback $true
      }

      # La carga usa la misma escala 0..100 que el panel; el 0 es un valor real.
      $cpuLoad = Get-Value (Find-Sensor $cpuHw ([LibreHardwareMonitor.Hardware.SensorType]::Load) "CPU Total") $false

      $ramTotal = $null
      $ramUsed = $null
      $usedGb = Get-Value (Find-Sensor $ramHw ([LibreHardwareMonitor.Hardware.SensorType]::Data) "Memory Used") $true
      $freeGb = Get-Value (Find-Sensor $ramHw ([LibreHardwareMonitor.Hardware.SensorType]::Data) "Memory Available") $true
      if ($null -ne $usedGb -and $null -ne $freeGb) {
        $ramTotal = [long][math]::Round(($usedGb + $freeGb) * $GiB)
        $ramUsed = [long][math]::Round($usedGb * $GiB)
      }

      $gpuTemp = Get-Value (Find-Sensor $gpuHw ([LibreHardwareMonitor.Hardware.SensorType]::Temperature) "GPU Core") $true
      $gpuLoad = Get-Value (Find-Sensor $gpuHw ([LibreHardwareMonitor.Hardware.SensorType]::Load) "GPU Core") $false

      $vramTotal = $null
      $vramUsed = $null
      $totalMb = Get-Value (Find-Sensor $gpuHw ([LibreHardwareMonitor.Hardware.SensorType]::SmallData) "GPU Memory Total") $true
      $usedMb = Get-Value (Find-Sensor $gpuHw ([LibreHardwareMonitor.Hardware.SensorType]::SmallData) "GPU Memory Used") $true
      if ($null -ne $totalMb) { $vramTotal = [long][math]::Round($totalMb * $MiB) }
      if ($null -ne $usedMb) { $vramUsed = [long][math]::Round($usedMb * $MiB) }

      $sample = @{
        at  = [long](Now)
        cpu = @{ temp = $cpuTemp; load = $cpuLoad }
        ram = @{ total = $ramTotal; used = $ramUsed }
        gpu = @{
          name      = $gpuName
          temp      = $gpuTemp
          load      = $gpuLoad
          vramTotal = $vramTotal
          vramUsed  = $vramUsed
        }
      }
      Save-Sample ($sample | ConvertTo-Json -Compress -Depth 4)
    }
    catch {
      # Un fallo de una vuelta no puede tumbar el monitor: el panel sigue vivo.
      $err = @{ at = [long](Now); error = [string]$_.Exception.Message }
      try { Save-Sample ($err | ConvertTo-Json -Compress -Depth 4) } catch { }
    }

    Start-Sleep -Milliseconds $IntervalMs
  }
}
catch {
  # Fallo al cargar la librería o al abrir el equipo: se deja el motivo escrito
  # (el host lo descarta por no ser una muestra) y se sale con error.
  $err = @{ at = [long](Now); error = [string]$_.Exception.Message }
  try { Save-Sample ($err | ConvertTo-Json -Compress -Depth 4) } catch { }
  exit 1
}
finally {
  if ($computer) {
    try { $computer.Close() } catch { }
  }
  # El mutex nunca se adquirió (nació sin propiedad inicial), así que no hay nada
  # que soltar: el Dispose cierra el handle y libera el nombre al salir.
  if ($mutex) {
    $mutex.Dispose()
  }
}
