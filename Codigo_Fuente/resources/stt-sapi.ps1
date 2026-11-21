# Dictado con el reconocedor de Windows (SAPI), sin dependencias externas.
#
# Se mantiene vivo y espera una bandera de fichero ("active") para no cargar el
# motor en cada pulsación: arrancar System.Speech cuesta casi un segundo y se
# perderían las primeras palabras. Habla por stdout en líneas JSON.
#
#   active presente -> escucha       sin "active" -> en espera
#   quit presente   -> termina el proceso
#
# Con -Stream el audio no lo abre este script: la extensión graba el micro (con
# su dispositivo, ganancia y filtro de ruido) y lo manda por stdin como PCM crudo
# 16 kHz mono 16 bit. Cerrar stdin es el fin del audio y el script termina.
# Sin -Stream (o si el flujo falla) se usa el micro por defecto de Windows.
#
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File stt-sapi.ps1 -Dir <carpeta> [-Culture es-ES] [-Stream]
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$Culture = "es-ES",
  [switch]$Stream
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
  # Flujo de audio desde stdin: una cola con bloqueo que lee un hilo propio. Read
  # espera datos y devuelve 0 (fin de audio) cuando stdin se cierra.
  $pcm = $null
  if ($Stream) {
    try {
      Add-Type -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Threading;
public class AlfredPcmStream : Stream {
  readonly BlockingCollection<byte[]> q = new BlockingCollection<byte[]>();
  byte[] cur; int pos; bool starving;
  public volatile bool Closed;
  public AlfredPcmStream() {
    Thread t = new Thread(delegate() {
      try {
        Stream si = Console.OpenStandardInput();
        byte[] buf = new byte[4096];
        int n;
        while ((n = si.Read(buf, 0, buf.Length)) > 0) {
          byte[] c = new byte[n]; Buffer.BlockCopy(buf, 0, c, 0, n); q.Add(c);
        }
      } catch { }
      q.CompleteAdding();
      Closed = true; // stdin cerrado: el bucle principal termina aunque no esté reconociendo
    });
    t.IsBackground = true; t.Start();
  }
  // SAPI trata una lectura corta como fin del audio: se rellena siempre lo pedido,
  // salvo al cerrarse stdin. Si la extensión deja de mandar audio (se soltó el micro),
  // lo que falta se rellena con silencio: SAPI pide bloques grandes y, esperando a
  // llenarlos, la frase se quedaba retenida hasta la siguiente pulsación.
  public override int Read(byte[] b, int off, int count) {
    int got = 0;
    while (got < count) {
      if (cur == null || pos >= cur.Length) {
        cur = null;
        if (q.IsCompleted) { Closed = true; break; }
        // La primera espera es larga (un tirón del grabador no es silencio); ya sin audio,
        // el silencio se sirve deprisa para que SAPI cierre la frase cuanto antes.
        if (!q.TryTake(out cur, starving ? 10 : 300)) {
          if (q.IsCompleted) { Closed = true; break; }
          starving = true;
          Array.Clear(b, off + got, count - got); total += count - got; got = count; break;
        }
        starving = false;
        pos = 0;
      }
      int k = Math.Min(count - got, cur.Length - pos);
      Buffer.BlockCopy(cur, pos, b, off + got, k); pos += k; got += k; total += k;
    }
    return got;
  }
  // SAPI pregunta por posición y longitud: se finge un flujo "infinito".
  long total;
  public override bool CanRead { get { return true; } }
  public override bool CanSeek { get { return false; } }
  public override bool CanWrite { get { return false; } }
  public override long Length { get { return long.MaxValue; } }
  public override long Position { get { return total; } set { } }
  public override void Flush() { }
  public override long Seek(long o, SeekOrigin r) { return total; }
  public override void SetLength(long v) { throw new NotSupportedException(); }
  public override void Write(byte[] b, int o, int c) { throw new NotSupportedException(); }
}
"@
      $pcm = New-Object AlfredPcmStream
    } catch {
      Emit @{ ev = "warn"; text = "No se pudo preparar el flujo de audio; se usa el micrófono por defecto de Windows." }
      $pcm = $null
    }
  }
  # Nivel del micro para el vúmetro (solo con el micro por defecto: con -Stream lo
  # calcula la extensión, que es quien graba). Recognize() bloquea este hilo, así que el
  # evento AudioLevelUpdated no puede atenderse con un scriptblock (no hay
  # runspace en el hilo de audio): lo escucha un manejador compilado que escribe
  # {"ev":"level","value":0..100} a ~10 Hz. Si falla, el dictado sigue sin vúmetro.
  if (-not $pcm) { try {
    Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @"
using System;
using System.Speech.Recognition;
public static class AlfredLevelTap {
  static long last;
  public static void Attach(SpeechRecognitionEngine e) {
    e.AudioLevelUpdated += delegate(object s, AudioLevelUpdatedEventArgs a) {
      long now = Environment.TickCount;
      if (now - last < 100) return;
      last = now;
      Console.Out.WriteLine("{\"ev\":\"level\",\"value\":" + a.AudioLevel + "}");
      Console.Out.Flush();
    };
  }
}
"@
    [AlfredLevelTap]::Attach($rec)
  } catch { } }
  Emit @{ ev = "ready"; culture = $rec.RecognizerInfo.Culture.Name }
} catch {
  Emit @{ ev = "error"; text = "No se pudo iniciar el reconocedor ($Culture): $($_.Exception.Message)" }
  exit 1
}

# Tope de seguridad: 3 minutos sin reconocer nada cierran el micro. En manos
# libres se renueva con cada frase, así una sesión larga no se corta.
$limit = (Get-Date).AddMinutes(3)

# Con flujo, el fin de stdin (cierre de la extensión) también termina el proceso.
while (-not (Test-Path $quitFile) -and -not ($pcm -and $pcm.Closed)) {
  if (Test-Path $activeFile) {
    try {
      if (-not $inputSet) {
        if ($pcm) {
          try {
            $rec.SetInputToAudioStream($pcm, (New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)))
          } catch {
            # El flujo no valió: se abandona y se vuelve al micro por defecto.
            Emit @{ ev = "warn"; text = "Falló el flujo de audio ($($_.Exception.Message)); se usa el micrófono por defecto de Windows." }
            $pcm = $null
            $rec.SetInputToDefaultAudioDevice()
          }
        } else {
          $rec.SetInputToDefaultAudioDevice()
        }
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
