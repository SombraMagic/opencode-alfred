# Instalar OpenCode Alfred

Paquete listo para usar: **`opencode-alfred-0.7.1.vsix`** (en esta misma carpeta).
No hace falta compilar nada ni instalar Node.

## Antes de empezar

| Requisito | Detalle |
| --- | --- |
| VS Code | 1.90 o superior |
| opencode | opcional, pero sin él no hay explorador de agentes ni estadísticas |
| Windows | necesario para la voz y el dictado sin conexión (SAPI) |
| Blender | opcional: solo lo usa el Visor Alfred 3D para exportar y renderizar. Sin él, el visor abre lo ya exportado (caché o `.glb` al lado) y renderiza con el motor `VISOR` |
| Ollama | opcional: es el cerebro de **Mente local**. Se instala desde el propio panel con `winget` |

La extensión está pensada y orientada a **opencode**. Claude Code y Codex son
**experimentales**: su soporte todavía no funciona del todo bien.

## Novedades de la 0.7.1

- **Vista `Control`** en la barra ALFRED: acordeón `CONTROLES` con `‹ [terminal] ›` para abrir
  la sesión y cambiar de agente, `CONECTOR` y `MENTE GLOBAL`. Debajo, `GEN. IMÁGENES` y
  `CHATBOT` apagados con su hueco «Próximamente».
- **Explorador más corto**: el lanzador de terminales, `CONECTORES` y `MENTE LOCAL` se mudan a
  `Control`. Queda `GLOBAL` · `PROYECTO` · `ASIGNAR AGENTES` y, debajo, `ACEPTAR TODOS LOS
  PERMISOS`. `ASIGNAR AGENTES` se apaga cuando el proveedor activo no es opencode.
- **Contexto**: la matriz pasa de 20 × 8 a 10 × 16, las mismas 160 celdas con casillas más
  grandes.
- **Límites de consumo**: cada tarjeta recuerda si estaba plegada entre sesiones.

## Instalar

**Desde VS Code**

1. Abre el panel **Extensiones** (`Ctrl+Shift+X`).
2. Menú `...` → **Install from VSIX...**.
3. Elige `opencode-alfred-0.7.1.vsix`.
4. Paleta de comandos (`Ctrl+Shift+P`) → **Developer: Reload Window**.

**Desde la terminal**

```bash
code --install-extension opencode-alfred-0.7.1.vsix
```

Si ya tenías una versión anterior, añade `--force` para reemplazarla:

```bash
code --install-extension opencode-alfred-0.7.1.vsix --force
```

## Ya instalado, ¿por dónde empiezo?

- **ALFRED** en la barra de actividad (izquierda): el centro de control. Explorador de
  agentes, MCP, skills y plugins, con `GLOBAL` · `PROYECTO` · `ASIGNAR AGENTES` y el
  interruptor de permisos arriba; **Control**, con la sesión, los conectores y Mente local;
  Contexto y Límites de consumo.
- **VOZ** en la barra lateral derecha: ecualizador de barras y ajustes de voz.
- **DICTADO** en el panel inferior: bloc de notas, configuración y micrófono.
- **Visor Alfred 3D**: haz doble clic en un `.blend` desde el Explorador (o menú contextual →
  **Abrir en Alfred 3D**). Gira la escena, oculta objetos, mueve cámaras y luces y pulsa `FOTO`.
  Con Blender instalado también renderiza con su motor; sin él, elige `MOTOR → VISOR`.

Los ajustes viven en `Ajustes → OpenCode Alfred` (`opencodeAgents.*`) y
`Ajustes → Voz` (`voz.*`).

## Desinstalar

Panel **Extensiones** → busca **OpenCode Alfred** → **Uninstall** → recarga la ventana.
Tus agentes, MCP y ajustes de opencode no se tocan: la extensión nunca escribe en las
bases de datos.

## Si algo no sale

- **No aparece el icono ALFRED**: recarga la ventana. Si sigue sin salir, comprueba que
  la versión de VS Code es 1.90 o superior.
- **Las estadísticas están vacías**: necesitan que opencode haya ejecutado alguna sesión
  y un VS Code con Node 22.5+. Con menos, el resto de la extensión funciona igual.
- **No hay voz**: en Windows usa SAPI (sin conexión). En otros sistemas, elige Edge,
  OpenAI o ElevenLabs en los ajustes de voz; OpenAI y ElevenLabs piden clave API.
- **El explorador sale vacío**: instala y arranca [opencode](https://opencode.ai) al
  menos una vez para que exista su configuración.
- **«No encuentro Blender»** al abrir un `.blend` o al renderizar: instala
  [Blender](https://www.blender.org) o indica la ruta en el ajuste
  `opencodeAgents.blenderPath`. La autodetección mira el `PATH`,
  `C:\Program Files\Blender Foundation` y el registro de Windows. Mientras tanto siguen
  abriendo las escenas ya exportadas y las que traen un `.glb` al lado del `.blend`, y el
  motor `VISOR` no necesita Blender para pintar.
- **El `.blend` no abre sin Blender**: o no está en la caché o el `<nombre>.glb` de al lado
  es **más viejo** que el `.blend`, así que hace falta Blender para reexportar. Copia un
  `.glb` más nuevo que el `.blend` junto a él (y su `<nombre>.meta.json`, si lo tienes). Y
  si el `.blend` es de Blender 5.x, el 4.4 lo rechaza con `incomplete header`: usa 5.2 o
  más nuevo.

## ¿Te ha servido?

Invítame a un café por PayPal: [paypal.me/sombrawandax](https://www.paypal.com/paypalme/sombrawandax)

Licencia MIT. Ver [../LICENSE](../LICENSE).
