# OpenCode Alfred

Extensión de VS Code que reúne en un solo sitio el control de **opencode**, **Claude Code**
y **Codex**: agentes, MCP, skills, plugins, contexto, consumo, estadísticas, voz y dictado.
El cuerpo de cada fichero de agente es su prompt; la extensión escribe el frontmatter YAML
por ti.

> **opencode es el centro.** La extensión está pensada y orientada a opencode: ahí funciona
> todo. Claude Code y Codex son **experimentales**: su soporte todavía no funciona del todo
> bien y puede cambiar. Cuando el documento dice «los tres CLIs», se refiere a eso.

Antes de instalar, conviene saber dónde escribe: agentes `.md` en
`~/.config/opencode/agent` y `<proyecto>/.opencode/agent`, `opencode.json(c)`,
`AGENTS.md`, los agentes y ajustes de Claude Code, `config.toml` de Codex y el bloc de
adjuntos. Las bases de opencode se abren **en solo lectura** y `~/.claude.json` no se toca
nunca. El detalle está en la tabla del
[README principal](https://github.com/SombraMagic/opencode-alfred#qu%C3%A9-toca-y-qu%C3%A9-no).

## Paneles

### ALFRED — Explorador (barra de actividad)

- **Mando**: `GLOBAL` / `PROYECTO`, el selector del agente de sesión (opencode, Claude o
  Codex), `ACEPTAR TODO` y los botones `CONECTORES`, `ASIGNAR AGENTES` y `MENTE LOCAL`.
- **Explorador**: agentes de proyecto y globales, con su modelo, animación de vuelo cuando
  trabajan y tokens (sesión y total). `VER` abre su formulario.
- **Control**: MCP, skills y plugins de cada proveedor, con interruptor para activar y
  desactivar. Para Claude los MCP de usuario y locales se conmutan inyectando
  `/mcp disable|enable` en la terminal viva; los `.mcp.json` van por
  `disabledMcpjsonServers`.

CLIC en `VER` sobre un integrado con override abre **su `.md`**, no el integrado, así que su
sobrescritura se puede borrar desde el propio formulario.

### Contexto

Una fila con lo gastado y el límite del modelo, el desglose de qué ocupa la ventana
(instrucciones, skills, historial, sin atribuir) y el botón `COMPACTAR`. Mide opencode por
su base SQLite; Claude y Codex por sus ficheros de sesión.

### Límites de consumo

Saldo o topes por proveedor: DeepSeek (saldo), OpenAI (coste del mes), GitHub Copilot
(cuotas del plan) y OpenCode Go (estimación por tokens). Se enciende por proveedor en la
fila de `CONECTORES`; solo sondea con la vista abierta.

### Voz (barra lateral derecha) y Dictado (panel inferior)

- Voz: ecualizador de barras pixeladas y cuatro motores (SAPI de Windows, Edge, OpenAI, ElevenLabs).
  `Ctrl+Alt+V` lee la selección. El ecualizador también reacciona a lo que diga el MCP; el
  servidor MCP `mcp_alfred` (voz **y** pizarra) viaja dentro del paquete en
  `dist/alfred-mcp.js` y se da de alta solo en los agentes que haya (opencode, Claude Code,
  Claude Desktop, Cursor). El botón `ALFRED MCP` del panel, con su punto verde o ámbar, lo
  enciende y lo apaga.
- Dictado: bloc de notas con adjuntos (imágenes pegadas, ficheros arrastrados o `ADJUNTAR`),
  configuración plegable y tres motores (SAPI, Whisper local, nube compatible con OpenAI).

### Pizarra

Lienzo por capas, de abajo arriba: fondo (color o imagen), **diagrama**, **interfaces**,
imágenes movibles, trazos con lápiz y goma, y textos. Zoom con la rueda y paneo con
`Espacio` + arrastrar. Se abre desde `SUBIR PIZARRA` en el bloc del dictado, y ese mismo
botón la mete en el bloc como adjunto.

- **Diagrama**: capa para dibujar workflows con nodos (seis formas y doce iconos) y
  conectores ortogonales. Los conectores se crean arrastrando un asa del nodo y se enganchan
  solos al lado más cercano; arrastrar un codo mueve sus dos tramos sin tocar el resto de la
  ruta y arrastrar un tramo lo reorienta. Se agarra lo que se ve, sin saltos a la rejilla al
  pulsar. `Alt` + clic añade un codo y el doble clic en el codo lo quita o edita la etiqueta.
  Cada arista elige sus flechas (`FLECHAS`: final, inicio, ambas o ninguna) y si la línea es
  discontinua. La etiqueta del nodo se ajusta dentro de su silueta (rombo, elipse, inicio/fin,
  icono), siempre centrada, y encoge antes de salirse; su color se fija con `TEXTO` o `AUTO`
  (contraste con el relleno). Mientras dibujas un nodo se ve su silueta y su medida; con el
  lápiz y el borrador, el círculo del grosor y el núcleo de la goma.
- **Interfaces**: capa de wireframes. El botón `INTERFAZ` abre un cajón a la izquierda con la
  paleta de widgets —trece tipos: contenedor, ventana, pestañas horizontales y verticales,
  acordeón, menú, etiqueta, campo, área de texto, elección, botón, icono e imagen— y el
  inspector del elegido. Los widgets se insertan en el contenedor seleccionado, se anidan
  (hasta 8 niveles), se mueven, se redimensionan y se borran; un clic sobre el que ya está
  elegido simula su control (pestañas, acordeón, casillas). Con un widget `image` elegido,
  `Ctrl+V` le pone la imagen del portapapeles. Cada widget se pinta como quieras: fondo
  (automático, sin fondo o color), borde y color y tamaño de su texto, y el menú en fila o en
  columna.
- **Edición**: deshacer/rehacer de 50 pasos, multi-selección con alinear y distribuir, guías
  y rejilla, ajuste del lienzo al contenido y `COPIAR MERMAID` al portapapeles. La barra es
  una sola fila y cada herramienta abre su ventana de ajustes en un cajón superpuesto
  (`NODO`, `CONECTOR`, `TEXTO`, `LÁPIZ`, `BORRADOR` e `INTERFAZ`), que se cierra con su ✕ o
  con `Esc` y no le come alto al lienzo.
- **Varias pizarras**: una tira de pestañas en la cabecera, con `+` para añadir y `−` para
  eliminar. La pizarra 1 no se puede borrar: es la que leen y editan los agentes. Las demás
  viven cada una en su carpeta dentro de los adjuntos, y cambiar de pestaña guarda lo dibujado
  en la que se deja.
- **Qué se guarda**: el PNG aplanado en `pizarra-ultima.png` y, junto a él, la escena
  editable en `pizarra.json` (misma carpeta de adjuntos). Al reabrir manda la escena; si no
  es válida, se descarta y queda el PNG. `GUARDAR` deja el PNG y su `.json` donde elijas. El
  servidor MCP `mcp_alfred` expone diez herramientas de pizarra (`pizarra_leer`,
  `pizarra_escribir`, `pizarra_lienzo`, `pizarra_nodo`, `pizarra_arista`, `pizarra_texto`,
  `pizarra_imagen`, `pizarra_ui_leer`, `pizarra_ui_escribir` y `pizarra_ui_nodo`) para leerla
  y editarla desde un agente; el panel recarga el cambio solo.

### Mente local (Ollama)

El cerebro local del equipo, en una pestaña central (`MENTE LOCAL` en el mando del
Explorador). Comprueba si Ollama está instalado y lo instala o desinstala con `winget`;
encender arranca `ollama serve` si hace falta y apagar para el proceso. El bloque `SERVIDOR`
tiene además `ARRANCAR` y `PARAR` propios, para gobernar el proceso sin tocar el interruptor
ni el proveedor de opencode. Lista los modelos con
su tamaño y el espacio libre del disco (filtrar, ordenar por nombre, tamaño o recientes,
descargar con progreso y cancelación, borrar uno, marcar el preferido).

Con el cerebro encendido escribe `provider.ollama` en el `opencode.json(c)` global (con
`@ai-sdk/openai-compatible` en `http://127.0.0.1:11434/v1` y los modelos instalados), así que
Ollama sale en `CONECTORES` y en `ASIGNAR AGENTES`; al apagar lo retira. Descargar o borrar
con el cerebro encendido reescribe el proveedor, y al activar la extensión el servidor vuelve
solo si estaba encendido. No toca credenciales ni los demás proveedores, y el config se edita
con `jsonc-parser` conservando los comentarios.

### Visor Alfred 3D (`.blend`)

Abre ficheros `.blend` como pestaña de editor: doble clic en el Explorador o
**Abrir en Alfred 3D** en su menú contextual.

- **Vista**: three.js con órbita, `OBJETOS` (mallas y armaduras; cámaras y luces no salen en
  esa lista), `CÁMARAS` —la de escena es la que usa Blender al renderizar— y
  `LUCES` con encendido y deslizador de 0 a 200 %. `TEXTURAS` alterna entre los materiales
  reales y la vista de arcilla. El estado (cámara, ocultos, luces, clip, frames, texturas)
  se conserva al cambiar de pestaña.
- **Animación**: clip elegido, frames `INICIO` / `FIN` editables, scrub y `PLAY` / `STOP` /
  `LOOP`.
- **Render**: `BASE` editable y carpeta con `ELEGIR`; los ficheros salen
  `<base>_frame<####>.png`. `FOTO` hace un frame y `RENDER ANIMACIÓN` la tirada entera, y se
  puede cancelar. El selector `MOTOR` decide quién pinta: `VISOR` (por defecto) captura desde
  la propia ventana, sin Blender y con iluminación aproximada; `BLENDER` renderiza con su
  motor, su cámara y la resolución del `.blend`. El visor usa AgX como EEVEE, pero sin
  sombras, oclusión, profundidad de campo ni geometry nodes: no es idéntico al PNG de Blender.
- **Blender es opcional**: sin él abren las escenas ya exportadas y las que traigan un
  `<nombre>.glb` junto al `.blend`, si no es más viejo que él. Su `<nombre>.meta.json` es
  opcional, y sin él no hay resolución ni fps reales (frames a 24 y captura al tamaño del
  lienzo). Sin caché, sin sidecar y sin Blender, el aviso lo dice claro.
- **Cómo lo lee**: Blender exporta el `.blend` a GLB por línea de órdenes y eso se guarda en
  la caché `<almacén global>/alfred3d/`, invalidada por la fecha del `.blend`. **El `.blend`
  nunca se guarda.** El pie de la ventana enseña el Blender en uso y `CAMBIAR` lo cambia:
  escribe `opencodeAgents.blenderPath`, limpia la caché y reexporta.
- **Versiones**: los `.blend` de Blender 5.x no los abre el 4.4 (`incomplete header`). Haz
  que la extensión apunte a 5.2 o más nuevo; el mensaje de error incluye lo que dice Blender.

### Estadísticas de agentes y de prompts

- **Agentes**: tokens (entrada, salida, razonamiento, caché), coste, tiempo de trabajo,
  sesiones y mensajes, con subtotales por scope. `REINICIAR` fija un punto de partida.
- **Prompts**: línea de tiempo por prompt, con cada agente y subagente que intervino, su
  duración, tokens y coste (real o estimado y marcado). Solo opencode, y solo con
  `MONITORIZAR` encendido; el historial se guarda en el almacén global de la extensión.

### Conectores y asignación de modelos

- **Conectores**: catálogo de integraciones, lo ya configurado y sus modelos con precio y
  contexto. Alta por clave, externa, OAuth o comando; apagado por política `provider.use`
  y borrado con confirmación. Los secretos nunca viajan al webview.
- **Asignar agentes**: tablero de tres columnas con cables agente ↔ modelo, grupos de
  favoritos y precios. Conectar escribe `model:` en el `.md` del agente: se aplica a las
  sesiones **nuevas**. Bajo el título hay pestañas de **configuraciones**: cada una guarda
  el mapa completo agente → modelo, y cambiar de pestaña lo vuelca en todos los `.md` (doble
  clic para renombrar, `×` para borrar, `+` para duplicar la activa). El buscador de modelos
  vive en la fila del título MODELOS.

## Los tres proveedores

El selector del mando decide qué config lee y escribe la extensión:

| Proveedor | Agentes | MCP | Skills | Plugins |
| --- | --- | --- | --- | --- |
| opencode | `~/.config/opencode/agent` y `.opencode/agent` | `opencode.json(c)` | sí (conmutables) | sí |
| Claude Code | `~/.claude/agents` y `.claude/agents` | `.mcp.json`, usuario y locales | solo lectura | `enabledPlugins` |
| Codex | `config.toml` | `[mcp_servers.*]` | solo lectura | `[plugins.*]` |

## Dónde escribe

| Qué | Dónde |
| --- | --- |
| Agentes de opencode | `~/.config/opencode/agent/<nombre>.md` y `<proyecto>/.opencode/agent/<nombre>.md` |
| Subagentes de Claude | `~/.claude/agents` y `<proyecto>/.claude/agents` |
| Adjuntos del dictado | `<proyecto>/.alfred/adjuntos` (o el almacén global si no hay carpeta) |

Las bases de datos de opencode se abren **en estricta solo lectura**. Nunca se escribe en
ellas.

## Ajustes

`opencodeAgents.*`: `globalConfigDir`, `blenderPath` (ruta a `blender.exe`; vacío =
autodetectar), `defaultModel`, `showBuiltins`, `schemaUrl`,
`dataDir`, `watchLive`, `liveIntervalMs`, `modelsCachePath`, `showAllProviders`,
`limitsProviders`, `goPlan`.

`voz.*`: `engine`, `voice`, `rate`, `pitch`, `volume`, `outputDevice`, y `voz.dictado.*`
(motor, idioma, modelo de Whisper, URL y modelo de la nube, filtro de ruido, umbral y
fondo de ruido).

## Requisitos

VS Code 1.90+ y Node 20+. Las estadísticas en vivo necesitan Node 22.5+ en el host; con
menos, esas vistas se degradan solas. opencode solo es necesario para su parte; la voz y
el dictado funcionan sin él (SAPI sin conexión en Windows).

**Blender es opcional** y solo lo usa el visor 3D: sin él abren las escenas cacheadas y las
que traigan su `.glb` al lado del `.blend`, y el motor `VISOR` renderiza sin proceso
externo. Lo busca por `opencodeAgents.blenderPath`, el `PATH`, `C:\Program Files\Blender
Foundation` y el registro de Windows, y elige la versión más alta. Para abrir `.blend` de
Blender 5.x hace falta **5.2 o más nuevo**: el 4.4 los rechaza.

## Desarrollo

La raíz del paquete es esta carpeta:

```bash
npm install
npm run compile     # build único (esbuild)
npm run watch       # build continuo
npm run typecheck   # tsc --noEmit
npx @vscode/vsce package
```

`F5` lanza *Run Extension* con esta carpeta abierta como espacio de trabajo. VS Code carga
la extensión **instalada**, no el repo: para probar un cambio en tu editor hay que
empaquetar el `.vsix`, instalarlo y recargar la ventana.

## Licencia

MIT. Ver [`LICENSE`](https://github.com/SombraMagic/opencode-alfred/blob/main/LICENSE).
