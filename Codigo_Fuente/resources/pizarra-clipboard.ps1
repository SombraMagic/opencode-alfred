# Escribe como PNG la imagen del portapapeles en -OutPath.
# Sale 0 con imagen, 1 sin imagen o si algo falla (el host lo traduce a "portapapeles vacío").
# Hay que lanzar powershell.exe con -STA: Clipboard::GetImage lo pide.
param(
  [Parameter(Mandatory = $true)][string]$OutPath
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$img = $null
try {
  # Sin imagen en el portapapeles GetImage devuelve un Bitmap vacío (0x0); en algunas
  # versiones lanza. Se cubren las dos: abajo se mira el tamaño.
  $img = [System.Windows.Forms.Clipboard]::GetImage()
}
catch {
  exit 1
}

if (-not $img -or $img.Width -lt 1 -or $img.Height -lt 1) {
  if ($img) { $img.Dispose() }
  exit 1
}

try {
  $img.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
}
catch {
  $img.Dispose()
  exit 1
}

$img.Dispose()
exit 0
