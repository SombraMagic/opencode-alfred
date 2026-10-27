# Dictado con el reconocedor de Windows (SAPI), sin dependencias externas.
#
# Se mantiene vivo y espera una bandera de fichero ("active") para no cargar el
# motor en cada pulsación: arrancar System.Speech cuesta casi un segundo y se
# perderían las primeras palabras. Habla por stdout en líneas JSON.
#
#   active presente -> escucha       sin "active" -> en espera
#   quit presente   -> termina el proceso
#
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File stt-sapi.ps1 -Dir <carpeta> [-Culture es-ES]
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$Culture = "es-ES"
)

$ErrorActionPreference = "Stop"

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

# SAPI sólo existe en PowerShell 5.1 (System.Speech no está en .NET Core).
Add-Type -AssemblyName System.Speech

$activeFile = Join-Path $Dir "active"
$quitFile = Join-Path $Dir "quit"
$inputSet = $false
$listening = $false

try {
  # Se elige por RecognizerInfo: pasarle un CultureInfo acaba en la sobrecarga
  # (string recognizerId) y falla aunque el idioma esté instalado.
  $info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
    Where-Object { $_.Culture.Name -eq $Culture } |
    Select-Object -First 1
  if (-not $info) {
    $have = ([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
      ForEach-Object { $_.Culture.Name }) -join ", "
    Emit @{ ev = "error"; text = "No hay reconocedor instalado para '$Culture'. Instalados: $have" }
    exit 1
  }
  $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
  $rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  # Frases cortas: el fin de locución llega pronto y el dictado fluye.
  $rec.InitialSilenceTimeout = [TimeSpan]::FromSeconds(8)
  $rec.BabbleTimeout = [TimeSpan]::FromSeconds(4)
  $rec.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(650)
  $rec.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(900)
  Emit @{ ev = "ready"; culture = $rec.RecognizerInfo.Culture.Name }
} catch {
  Emit @{ ev = "error"; text = "No se pudo iniciar el reconocedor ($Culture): $($_.Exception.Message)" }
  exit 1
}

# Tope de seguridad: 3 minutos sin reconocer nada cierran el micro. En manos
# libres se renueva con cada frase, así una sesión larga no se corta.
$limit = (Get-Date).AddMinutes(3)

while (-not (Test-Path $quitFile)) {
  if (Test-Path $activeFile) {
    try {
      if (-not $inputSet) {
        $rec.SetInputToDefaultAudioDevice()
        $inputSet = $true
      }
      if (-not $listening) {
        $limit = (Get-Date).AddMinutes(3)
        Emit @{ ev = "state"; listening = $true }
        $listening = $true
      }
      if ((Get-Date) -gt $limit) {
        Emit @{ ev = "error"; text = "Dictado detenido: 3 minutos sin reconocer voz." }
        Remove-Item $activeFile -Force -ErrorAction SilentlyContinue
        continue
      }
      # Devuelve al detectar el fin de la frase (o al agotar el tope).
      $r = $rec.Recognize([TimeSpan]::FromSeconds(15))
      if ($r -and $r.Text) {
        Emit @{ ev = "final"; text = $r.Text; confidence = [math]::Round($r.Confidence, 3) }
        $limit = (Get-Date).AddMinutes(3)
      }
    } catch {
      Emit @{ ev = "error"; text = "Falló el dictado: $($_.Exception.Message)" }
      $inputSet = $false
      $listening = $false
      Remove-Item $activeFile -Force -ErrorAction SilentlyContinue
    }
  }
  else {
    if ($listening) {
      Emit @{ ev = "state"; listening = $false }
      $listening = $false
    }
    Start-Sleep -Milliseconds 60
  }
}
