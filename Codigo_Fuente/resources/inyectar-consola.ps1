# Inyecta un texto en la consola del proceso ConsolaPid (AttachConsole + WriteConsoleInputW).
# Lo lanza src/dictado/consola.ts en un proceso aparte: AttachConsole cambia la consola del
# proceso que llama, y eso no puede hacerse desde el host de la extension.
# Uso: powershell -File inyectar-consola.ps1 -ConsolaPid <pid> -TextoFile <ruta UTF-8> -StartedAt <ms epoch> [-Enviar]
# El texto es LITERAL: no hay tokens ni mini-lenguaje (un "{ESC}" del usuario son 5 caracteres).
# Con saltos de linea (o tabuladores) va entre marcadores de pegado ESC[200~ ... ESC[201~, para
# que el TUI no envie en cada salto; -Enviar manda UN Enter suelto despues. Salida: una linea
# JSON {ok, error, records, ms}; exit 1 si falla (PID inexistente = "AttachConsole:87").
param(
  [Parameter(Mandatory=$true)][uint32]$ConsolaPid,
  [Parameter(Mandatory=$true)][string]$TextoFile,
  [Parameter(Mandatory=$true)][int64]$StartedAt,
  [switch]$Enviar
)
# El PID sale de un sessions/<pid>.json que puede ser huerfano: si Windows reciclo el PID, el
# Enter lo ejecutaria otro programa (un cmd, un PowerShell). Se comprueba ANTES de attach que el
# proceso es claude/node y que arranco cuando dice la sesion (startedAt, tolerancia 5 s).
function Salir($err) {
  ([ordered]@{ ok = $false; error = $err; records = 0; ms = 0 } | ConvertTo-Json -Compress)
  exit 1
}
if ($StartedAt -le 0) { Salir 'PidNoVerificado:sin-startedAt' }
try { $proc = Get-Process -Id $ConsolaPid -ErrorAction Stop } catch { $proc = $null }
if (-not $proc) { Salir 'PidNoVerificado:proceso' }
if ($proc.ProcessName -notin @('claude', 'node')) { Salir 'PidNoVerificado:nombre' }
$inicio = $null
try { $inicio = [DateTimeOffset]::new($proc.StartTime).ToUnixTimeMilliseconds() } catch { Salir 'PidNoVerificado:inicio' }
if ($null -eq $inicio) { Salir 'PidNoVerificado:inicio' }
if ([Math]::Abs($inicio - $StartedAt) -gt 5000) { Salir 'PidNoVerificado:inicio' }
$Texto = [IO.File]::ReadAllText($TextoFile, [Text.Encoding]::UTF8)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Con {
  [StructLayout(LayoutKind.Explicit, Size=20)]
  public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public int bKeyDown;
    [FieldOffset(8)] public ushort wRepeatCount;
    [FieldOffset(10)] public ushort wVirtualKeyCode;
    [FieldOffset(12)] public ushort wVirtualScanCode;
    [FieldOffset(14)] public ushort UnicodeChar;
    [FieldOffset(16)] public uint dwControlKeyState;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFile(string n, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] b, uint len, out uint written);
  [DllImport("user32.dll")] public static extern short VkKeyScanW(char c);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint code, uint type);

  static INPUT_RECORD K(bool down, ushort vk, ushort ch, uint ctrl) {
    var r = new INPUT_RECORD();
    r.EventType = 1; r.bKeyDown = down ? 1 : 0; r.wRepeatCount = 1;
    r.wVirtualKeyCode = vk; r.wVirtualScanCode = (ushort)MapVirtualKeyW(vk, 0);
    r.UnicodeChar = ch; r.dwControlKeyState = ctrl;
    return r;
  }
  static void Key(System.Collections.Generic.List<INPUT_RECORD> l, ushort vk, ushort ch) {
    l.Add(K(true, vk, ch, 0)); l.Add(K(false, vk, ch, 0));
  }
  static void Literal(System.Collections.Generic.List<INPUT_RECORD> l, string s) {
    foreach (char c in s) {
      short v = VkKeyScanW(c);
      ushort vk = (v == -1) ? (ushort)0 : (ushort)(v & 0xFF);
      uint ctrl = (v != -1 && (v & 0x100) != 0) ? 0x10u : 0u;
      l.Add(K(true, vk, c, ctrl)); l.Add(K(false, vk, c, ctrl));
    }
  }
  public static System.Collections.Generic.List<INPUT_RECORD> Build(string t, bool enviar) {
    var l = new System.Collections.Generic.List<INPUT_RECORD>();
    t = t.Replace("\r\n", "\n").Replace('\r', '\n');
    bool pegado = t.IndexOf('\n') >= 0 || t.IndexOf('\t') >= 0;
    if (pegado) { Key(l, 0x1B, 27); Literal(l, "[200~"); }
    foreach (char c in t) {
      if (c == '\n') { Key(l, 0x0D, 13); continue; }  // dentro del pegado no envia
      if (c == '\t') { Key(l, 0x09, 9); continue; }
      if (c < 32 || (c >= 127 && c <= 159)) continue; // nunca un control suelto
      Literal(l, c.ToString());
    }
    if (pegado) { Key(l, 0x1B, 27); Literal(l, "[201~"); }
    return l;
  }
  static string Write(IntPtr h, System.Collections.Generic.List<INPUT_RECORD> list) {
    var recs = list.ToArray();
    int off = 0;
    while (off < recs.Length) {
      int n = Math.Min(256, recs.Length - off);
      var chunk = new INPUT_RECORD[n]; Array.Copy(recs, off, chunk, 0, n);
      uint w;
      if (!WriteConsoleInputW(h, chunk, (uint)n, out w)) return "WriteConsoleInput:" + Marshal.GetLastWin32Error();
      off += n;
    }
    return "";
  }
  // Devuelve "" si ok, o "etapa:codigo".
  public static string Send(uint pid, string text, bool enviar, out int count) {
    var recs = Build(text, enviar);
    count = recs.Count + (enviar ? 2 : 0);
    FreeConsole();
    if (!AttachConsole(pid)) return "AttachConsole:" + Marshal.GetLastWin32Error();
    string err = "";
    IntPtr h = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) err = "CreateFile:" + Marshal.GetLastWin32Error();
    else {
      err = Write(h, recs);
      if (err == "" && enviar) {
        // El Enter va aparte y tras una pausa: pegado y Enter juntos se interpretan como parte del pegado.
        System.Threading.Thread.Sleep(250);
        var e = new System.Collections.Generic.List<INPUT_RECORD>();
        Key(e, 0x0D, 13);
        err = Write(h, e);
      }
      CloseHandle(h);
    }
    FreeConsole();
    return err;
  }
}
'@
$sw = [Diagnostics.Stopwatch]::StartNew()
$cnt = 0
$e = [Con]::Send($ConsolaPid, $Texto, [bool]$Enviar, [ref]$cnt)
$sw.Stop()
$o = [ordered]@{ ok = ($e -eq ''); error = $e; records = $cnt; ms = $sw.ElapsedMilliseconds }
$o | ConvertTo-Json -Compress
if ($e -ne '') { exit 1 } else { exit 0 }
