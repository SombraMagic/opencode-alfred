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

- **Mando**: `GLOBAL` / `PROYECTO`, `ASIGNAR AGENTES` y, debajo, el interruptor
  `ACEPTAR TODOS LOS PERMISOS`. `ASIGNAR AGENTES` es de opencode: con Claude Code o Codex
  queda apagado.
- **Explorador**: agentes de proyecto y globales, con su modelo, animación de vuelo cuando
  trabajan y tokens (sesión y total). `VER` abre su formulario.
- **MCP, skills y plugins**: los de cada proveedor, con interruptor para activar y
  desactivar. Para Claude los MCP de usuario y locales se conmutan inyectando
  `/mcp disable|enable` en la terminal viva; los `.mcp.json` van por
  `disabledMcpjsonServers`.

CLIC en `VER` sobre un integrado con override abre **su `.md`**, no el integrado, así que su
sobrescritura se puede borrar desde el propio formulario.

### Control

La vista hermana del Explorador, en la misma barra. Sin plegado ni rótulo: dos filas de iconos
apiladas arriba, con 6 px de aire. La primera lleva el grupo de sesión `‹ [terminal] ›` —el
botón principal, abrir la sesión del
proveedor activo y cambiar de agente— y cinco botones de módulo **solo icono**: el enchufe
de los conectores de opencode (apagado con otro proveedor), `ASIGNAR AGENTES` (solo con
opencode), el cerebro de `OLLAMA` (la pestaña
de Ollama, que brilla mientras el servidor responde), la foto del generador de imágenes (en verde
mientras está compartido con los agentes) y el
bocadillo del chatbot (se enciende cuando responde el servidor de Ollama). La segunda fila
abre pizarra, dictado, voz, estadísticas de prompt y el explorador del proyecto. Al estrechar la
barra las filas saltan a más líneas y los botones se estiran.

### Explorador del proyecto

Pestaña central —comando `opencodeAgents.projectExplorer` («opencode: Explorador del proyecto»),
o el icono de carpeta de la segunda fila de `Control`—. Uno o dos árboles de ficheros, cada uno
con su raíz elegida; el diseño, las raíces, lo expandido y la división se recuerdan por espacio de
trabajo.

- **Vista**: tamaño lógico de cada fichero con barra y porcentaje respecto al padre, tamaños
  redondeados, iconos SVG por tipo y los `.md` resaltados.
- **Búsqueda**: por nombre o carpeta y por contenido en texto (1 MB por fichero, sin binarios;
  omite `.git`, `node_modules`, `dist` y `build`). El resultado es un árbol podado con sus
  ancestros.
- **Git**: chips `TODO`, `CAMBIOS`, `STAGED`, `NUEVOS`, `SIN PUSH` y `LIMPIOS`, insignias
  `M`/`S`/`?`/`D`/`R`/`↑` y `+N −M` por fichero. Por la CLI de git: rama, `fetch`,
  `pull --ff-only`, `push` (con `-u` si no hay upstream y con confirmación), commit de lo staged,
  `ADD ALL`, `checkout` y rama nueva.
- **Menú contextual**: sin menú nativo sobre el árbol —comparar con Git (`vscode.diff`),
  stage/unstage, descartar cambios (solo modificados, con confirmación), renombrar y crear fichero—.
- **Operaciones**: borrar a la papelera con confirmación (permanente tras segundo aviso); copiar
  y mover arrastrando (`Ctrl` = copiar) o con el menú contextual Copiar/Cortar/Pegar, dentro del
  mismo árbol o entre los dos, sin sobrescribir nunca. Las rutas se validan dentro de la raíz de
  su árbol: `.git` y la raíz no se tocan y no se siguen symlinks.

### Contexto

Una fila con lo gastado y el límite del modelo, el desglose de qué ocupa la ventana
(instrucciones, skills, historial, sin atribuir) y el botón `COMPACTAR`. Mide opencode por
su base SQLite; Claude y Codex por sus ficheros de sesión.

### Límites de consumo

Saldo o topes por proveedor: DeepSeek (saldo), OpenAI (coste del mes), GitHub Copilot
(cuotas del plan) y OpenCode Go (estimación por tokens). Se enciende por proveedor en el panel
de conectores (el botón de enchufe de la vista `Control`); solo sondea con la vista abierta. La
tarjeta de cada proveedor recuerda si estaba plegada.

### Voz (barra lateral derecha) y Dictado (panel inferior)

- Voz: ecualizador de barras pixeladas y cuatro motores (SAPI de Windows, Edge, OpenAI, ElevenLabs).
  `Ctrl+Alt+V` lee la selección. El ecualizador también reacciona a lo que diga el MCP; el
  servidor MCP `mcp_alfred` (voz, pizarra e imágenes) viaja dentro del paquete en
  `dist/alfred-mcp.js` y se da de alta solo en los agentes que haya (opencode, Claude Code,
  Claude Desktop, Cursor). El botón `ALFRED MCP` del panel, con su punto verde o ámbar, lo
  enciende y lo apaga.
- Las tarjetas del panel no son solo agentes: generar una imagen, transcribir voz y
  cargar o instalar modelos de Ollama salen también, con la generación que lanza el MCP
  incluida. Se distinguen por el borde discontinuo y el icono delante del nombre, y
  desaparecen al terminar.
- Encima del ecualizador hay un **monitor del equipo**: `CPU` (temperatura y uso), `RAM`
  (total y uso), `GPU` (temperatura y uso) y `VRAM` (total y uso), con su barra de bloques.
  Se refresca cada 2 s y solo con la vista abierta; sin muestra, pinta guiones. Al arrancar no
  se pide nada: la temperatura de la CPU sale en `—` hasta que se pulse ese dato (subrayado
  punteado), y ese clic es el único que abre el UAC. Mientras espera se pinta `…`; si se cancela,
  vuelve `—` con un aviso. Sin permisos, el uso de CPU, la RAM, la GPU, la VRAM y la temperatura
  de la GPU se leen igual, y no aparece ninguna ventana de PowerShell.
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
  paleta de widgets —catorce tipos: contenedor, ventana, pestañas horizontales y verticales,
  acordeón, menú, lista, etiqueta, campo, área de texto, elección, botón, icono e imagen— y el
  inspector del elegido. La colocación va armada: eliges la forma, el botón queda luminoso y el
  widget cae con su esquina donde haces clic, con un fantasma bajo el puntero (`Esc` o cerrar
  la paleta cancela). Los widgets se insertan en el contenedor seleccionado, se anidan
  (hasta 8 niveles), se mueven, se redimensionan y se borran; un clic sobre el que ya está
  elegido simula su control (pestañas, acordeón, casillas) y el doble clic edita su etiqueta,
  como la de un texto, un nodo o un conector. Con un widget `image` elegido,
  `Ctrl+V` le pone la imagen del portapapeles. Cada widget se pinta como quieras: fondo
  (automático, sin fondo o color), borde y color y tamaño de su texto, y el menú en fila o en
  columna; la `LISTA` lleva además icono y barra de desplazamiento opcionales por widget, y el
  `CAMPO` una casilla `DESPLEGABLE` que le pinta la flecha final y acorta el texto para no
  pisarla (solo aspecto: no abre ninguna lista).
  Para anidar, suelta un widget sobre un contenedor (`container`, `window`, `tabs-h`, `tabs-v`,
  `accordion`): entra dentro, y arrastrando uno ya colocado cambia de contenedor o vuelve a la
  raíz sin moverse de donde se ve. La caja útil del destino se marca con un marco discontinuo
  cian mientras arrastras o apuntas con la paleta. Con la rejilla encendida, los widgets se
  encajan al lienzo dentro de su contenedor: el ajuste se calcula en absoluto, así que un texto,
  un botón o un campo anidado cae en la misma cuadrícula que uno de raíz y el fantasma de la
  paleta marca el sitio final. Un hijo nunca se sale de la caja útil de su padre.
- **Edición**: deshacer/rehacer de 50 pasos, `Ctrl+C`/`Ctrl+V` dentro del panel (nodos con sus
  conectores, conector suelto, widget con su subárbol, texto e imagen), multi-selección con
  alinear y distribuir, guías
  y rejilla, ajuste del lienzo al contenido y `COPIAR MERMAID` al portapapeles. La rejilla tiene
  paso configurable (1 a 64 px, campo junto al botón `REJILLA`): con pasos pequeños pinta una
  línea de cada `n` para distinguirse, y el ajuste usa siempre el paso fino. Encendida, el ajuste
  va por la esquina superior izquierda (textos e imágenes incluidos, y la caja entera de una
  selección de nodos); las flechas mueven una celda (con `Mayús`, diez) y las guías inteligentes
  no desplazan nada. Apagada vuelven las guías y el movimiento de 1/10 px. El ajuste
  encaja también la capa INTERFACES: la caja absoluta de cada widget entra en la medida, así
  que una pizarra solo de widgets se encaja y el PNG que sube al bloc los incluye. La barra es
  una sola fila y cada herramienta abre su ventana de ajustes en un cajón superpuesto
  (`NODO`, `CONECTOR`, `TEXTO`, `LÁPIZ`, `BORRADOR` e `INTERFAZ`), que se cierra con su ✕ o
  con `Esc` y no le come alto al lienzo.
- **Varias pizarras**: una tira de pestañas en la cabecera, con `+` para añadir y `−` para
  eliminar. La pizarra 1 no se puede borrar: es la que leen y editan los agentes. Las demás
  viven cada una en su carpeta dentro de los adjuntos, y cambiar de pestaña guarda lo dibujado
  en la que se deja. Junto al `+` y el `−`, dos botones de icono: el disquete (`#btn-board-save`)
  guarda la pizarra activa con un nombre y la carpeta (`#btn-board-load`) carga una guardada y
  sustituye todo lo que haya, con deshacer. Se guardan en `<raíz>/.alfred/.pizarras/<Nombre>/`
  (sin proyecto, en el almacén global) con `pizarra.json` y `pizarra.png`.
- **Qué se guarda**: el PNG aplanado en `pizarra-ultima.png` y, junto a él, la escena
  editable en `pizarra.json` (misma carpeta de adjuntos). Al reabrir manda la escena; si no
  es válida, se descarta y queda el PNG. `GUARDAR` deja el PNG y su `.json` donde elijas. El
  servidor MCP `mcp_alfred` expone diez herramientas de pizarra (`pizarra_leer`,
  `pizarra_escribir`, `pizarra_lienzo`, `pizarra_nodo`, `pizarra_arista`, `pizarra_texto`,
  `pizarra_imagen`, `pizarra_ui_leer`, `pizarra_ui_escribir` y `pizarra_ui_nodo`) para leerla
  y editarla desde un agente; el panel recarga el cambio solo.

### Mente local (Ollama)

El cerebro local del equipo, en una pestaña central (el botón de cerebro, `OLLAMA`, en la vista
`Control`).
Comprueba si Ollama está instalado y lo instala o desinstala con `winget`;
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

### Generador de imágenes IA

Pestaña central, desde el botón de foto de la vista `Control`. Dos motores:

- **ComfyUI**: texto a imagen e imagen a imagen contra un servidor propio (URL, puerto y todo
  lo que haga falta en el panel; por defecto `http://localhost:8188`). Los checkpoints y las
  LoRAs salen del propio servidor (`/object_info`), y un trabajo muestra su progreso en la
  barra sin reenviar la imagen de partida en cada tick. La semilla se fija a mano o se sortea
  (`ALEATORIA`), y la usada queda en el campo para repetir la toma. `PASOS` y `GUÍA` (CFG) van
  en la misma fila que la semilla y viajan al muestreador del servidor (20 y 7 por defecto).
- **El panel recuerda los ajustes entre sesiones**: el modelo de cada proveedor, el tamaño, los
  pasos, la guía, la semilla y si es aleatoria. Al abrir la pestaña se comprueba el enlace con
  ComfyUI y se recarga el catálogo sin pulsar `CONECTAR`; el botón de recargar que hay junto a
  `MODELO` lo vuelve a pedir, y `CONECTAR` sigue recargando la lista.
- **OpenAI o un servicio compatible**: texto a imagen con una clave propia, guardada en
  `secrets` (`opencodeAgents.imageGen.openaiKey`); al panel solo vuelve si hay clave o no. La
  URL base es configurable (`http://localhost:8000/v1`, etc.) y el modelo se escribe a mano.

Los lados se recortan a 2048 px y a múltiplos de 8 en el host, con aviso. Las imágenes se
guardan en `.alfred/imagenes` (sin proyecto abierto, en el almacén global) y el historial es esa
carpeta: las 20 últimas, con miniatura y el motor que las hizo. Se borran una a una o todas de
golpe, con confirmación. La pizarra y el generador no pintan las scanlines del tema: las
capturas que salen de ellos van limpias. La columna de vista previa e historial se queda con el
alto libre de la ventana (sin scroll en pestañas anchas) y el formulario se aprieta en ventanas
bajas.

La casilla **COMPARTIR CON ALFRED** de la cabecera deja que los agentes generen con este mismo
generador. Solo se enciende si ComfyUI responde con modelos o si hay clave de OpenAI; mientras
está compartido se revalida cada 5 s y se apaga sola al primer fallo (y el botón de `CONTROL`
deja de brillar). El MCP `mcp_alfred` publica entonces `generar_imagen` (prompt, prompt negativo
y tamaño, 64..2048 px; el negativo solo lo usa ComfyUI) y `consultar_estado`, que dice si está
compartido y operativo sin generar nada. La imagen que genera un agente se guarda en el mismo
historial y sus dos prompts aparecen en el panel.

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
- **Prompts**: lista estrecha multiselección con borrado por prompt y el agregado de la
  selección (prompts, trabajo, tokens, coste y agentes). La línea de tiempo va concatenada,
  sin huecos, agrupada por agente, con barras de tokens y de coste por agente; cada prompt
  guarda su duración, tokens y coste (real o estimado y marcado). Solo opencode, y solo con
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
| Explorador del proyecto | los ficheros del proyecto abierto: papelera, copiar y mover, solo dentro de la raíz de cada árbol |

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
