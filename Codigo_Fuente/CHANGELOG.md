# Historial de cambios

Una entrada por versión publicada. Este fichero viaja dentro del `.vsix` (lo lee el
marketplace); el `.vsix` de cada versión está en [`../Instalable/`](../Instalable/).

## [0.6.0] - 2026-10-30

- **Capa INTERFACES en la pizarra**: wireframes funcionales, como árbol de widgets y no como
  dibujo. Trece tipos (`container`, `window`, `tabs-h`, `tabs-v`, `accordion`, `menu`, `label`,
  `input`, `textarea`, `choice`, `button`, `icon`, `image`), anidados por `parent` hasta 8
  niveles y 800 widgets, con coordenadas relativas a la caja útil del padre. La capa va entre
  `DIAGRAMA` e `IMÁGENES` y se enciende con su chip. El botón `INTERFAZ` abre un cajón con la
  paleta y el inspector del widget elegido: se inserta en el contenedor seleccionado, se mueve,
  se redimensiona, se anida y se borra. Un clic sobre el widget ya elegido simula su control
  (pestaña, acordeón, casilla), y con un widget `image` elegido, `Ctrl+V` le pone la imagen del
  portapapeles.
- **Tres herramientas MCP nuevas** de pizarra, hasta diez: `pizarra_ui_leer` devuelve el árbol
  de widgets con sus ids y su caja absoluta, `pizarra_ui_escribir` sustituye la capa entera y
  `pizarra_ui_nodo` da de alta, edita o borra un widget (al borrar se lleva sus descendientes).
  `pizarra_escribir` conserva la capa si no se le pasa, y `pizarra_leer` añade el recuento de
  widgets por tipo.

## [0.5.0] - 2026-10-30

- **Mente local (Ollama)**: pestaña central nueva, con botón `MENTE LOCAL` en el mando del
  Explorador (sustituye al de `PIZARRA`, que se sigue abriendo desde el bloc del dictado).
  Detecta si Ollama está instalado y lo instala o desinstala con `winget`. Enciende el cerebro
  (arranca `ollama serve` si hace falta) y lo apaga (para el proceso); el servidor se puede
  arrancar y parar también por separado, sin tocar el proveedor de opencode. El botón del
  Explorador brilla mientras el servidor responde. Lista los modelos con su
  tamaño y el espacio libre del disco, con filtro y orden; descarga uno nuevo con progreso y
  cancelación, borra los que sobran y marca un modelo preferido.
- **Proveedor `ollama` en opencode**: al encender escribe `provider.ollama`
  (`@ai-sdk/openai-compatible`, `http://127.0.0.1:11434/v1`) con los modelos instalados en el
  `opencode.json(c)` global, así que Ollama aparece en `CONECTORES` y en `ASIGNAR AGENTES`; al
  apagar lo retira. Con el cerebro encendido, descargar o borrar reescribe el proveedor. Al
  activar la extensión, si quedó encendido, el servidor vuelve solo.
- **Multipizarra**: la pizarra deja de ser una sola. Una tira de pestañas en la cabecera con
  `+` para añadir y `−` para eliminar (la pizarra 1 no se puede borrar: es la que leen y
  editan los agentes). Cambiar de pestaña vuelca lo dibujado en la que se deja; las extra viven
  en su propia carpeta dentro de los adjuntos, así que el MCP y el dictado siguen viendo la 1.
  `GUARDAR` escribe además la escena editable (`.json`) junto al PNG.
- **Seguridad**: no toca credenciales ni los demás proveedores; el config se edita con
  `jsonc-parser` conservando comentarios. Los modelos y Ollama se quedan en disco al apagar o
  desinstalar.

## [0.4.0] - 2026-10-30

- **El botón del MCP deja de preguntar**: ya no abre el selector de VS Code. Al activar, la
  extensión da de alta `mcp_alfred` sola en los agentes que encuentre (opencode, Claude Code,
  Claude Desktop, Cursor) y el botón del panel de VOZ pasa a ser `ALFRED MCP`, con punto verde
  o ámbar: enciende o apaga el servidor en todos ellos. Si se apaga a mano, el arranque no lo
  vuelve a encender.
- **La pizarra no se guarda en blanco al abrirla**: el panel medía el marco (y marcaba la
  copia como sucia) antes de recibir la escena, así que a veces el primer `snapshot` escribía
  un lienzo vacío encima de lo dibujado. Ahora no se guarda nada hasta que la escena está
  puesta.
- **El servidor MCP pasa a llamarse `mcp_alfred`** (antes `voz`) y su bundle es
  `dist/alfred-mcp.js`. Sigue cubriendo la voz con `speak` y `list_voices`, sin cambios.
  **Rompe** las configuraciones que lo llamen por `voz`: al activar, la extensión sustituye
  esa entrada del `opencode.json(c)` global por `mcp_alfred` (solo si su comando apuntaba a
  `voz-mcp.js`; un `voz` ajeno se respeta). El botón `ALFRED MCP` del panel da de alta
  `mcp_alfred` en opencode, Claude Code, Claude Desktop y Cursor, y retira la entrada vieja.
- **Herramientas MCP de pizarra**: siete herramientas sobre la escena editable del proyecto
  (`<proyecto>/.alfred/adjuntos/pizarra.json`). `pizarra_leer` devuelve lienzo, capas,
  nodos, aristas, textos e imágenes con ids e índices (imágenes resumidas por tamaño, trazos
  por número) y la ruta del PNG; `pizarra_escribir` sustituye la escena entera; `pizarra_lienzo`
  toca tamaño y fijado del lienzo, color e imagen de fondo, capas visibles y limpiar una capa;
  `pizarra_nodo`, `pizarra_arista`, `pizarra_texto` y `pizarra_imagen` crean, editan y borran
  cada elemento (formas, colores, iconos, flechas, codos, giros).
- **La pizarra se recarga sola**: el panel vigila `pizarra.json` y aplica lo que escriba el
  MCP sin mover la vista y con entrada de deshacer.
- **Carpeta de la pizarra publicada**: la extensión la deja en `%APPDATA%\voz\entorno.json`
  (`pizarraDir`) porque el MCP corre en otro proceso y no sabe qué proyecto está abierto.

## [0.3.5] - 2026-10-30

- **Interfaz de la pizarra**: letra más grande y rótulos menos apagados. Los botones pasan
  a 30-32 px con iconos SVG en lugar de texto (cabecera, herramientas y alinear/distribuir),
  y la barra se parte en dos filas: herramientas y capas arriba, ajustes contextuales abajo.
  La fila de ajustes tiene alto fijo y no se oculta ni cambia de alto al cambiar de
  herramienta: con `SELECCIONAR` y nada elegido queda el hueco reservado, y si el marco es
  muy estrecho se desplaza en horizontal. La capa `FONDO` enseña su color junto al chip
  y `DISCONTINUA` es una casilla con el estilo del HUD.
- **Asas de los conectores**: al seleccionar una arista solo se marcan los quiebres reales
  de la ruta, así que ya no parece que la línea tenga nodos sueltos. Los codos materializados
  se siguen marcando uno a uno.
- **Flecha al inicio**: nueva punta `←` en `FLECHAS`, que invierte la dirección. Al copiar a
  Mermaid se exporta cambiando de sitio los nodos, porque Mermaid no tiene flecha solo al
  inicio.
- **Aviso de multi-selección**: ya no habla del botón `ABAJO`, que ahora es un icono.
- **MCP de la consola en el Explorador**: los servidores que solo existen en el runtime de
  opencode (como `opencode_console`) ya salen en `GLOBAL`, leídos de `GET /api/mcp`, con el
  interruptor sin mando y la marca «consola de opencode». Los de la config no cambian.
- **Límites reales de OpenCode Go**: la tarjeta deja de estimar con las bases y lee el
  consumo de `GET /api/experimental/usage/limits` (porcentajes de 5 h, semana y mes con su
  reposición, y presupuestos en USD si los hay). La estimación local queda solo de
  respaldo, y las reposiciones largas se cuentan en días.

## [0.3.4] - 2026-10-29

- **Lápiz y borrador con `TRAZOS` oculta**: coger cualquiera de los dos enciende la capa
  (con aviso en el pie), así que lo que se pinta se ve. El chivato del pincel se dibuja
  siempre, y si la capa se apaga con la herramienta activa se avisa al empezar a pintar.

## [0.3.3] - 2026-10-29

- **Edición de conectores predecible**: los codos y los tramos se agarran donde se ven, y
  arrastrar un codo desplaza sus dos tramos sin mover el resto de la ruta. Pulsar ya no
  salta a la rejilla.
- **Texto de los nodos encajado**: la etiqueta se ajusta dentro de la silueta (rombo,
  elipse, inicio/fin, icono), siempre centrada, y encoge antes de salirse.
- **Color del texto del nodo**: controles `TEXTO` y `AUTO` (contraste con el relleno) por
  nodo.
- **Chivatos al dibujar**: con un nodo se ve su silueta y su medida; con el lápiz y el
  borrador, el círculo del grosor y el núcleo de la goma.

## [0.3.2] - 2026-10-29

- **Pizarra de workflows**: capa `DIAGRAMA` entre el fondo y las imágenes, para dibujar
  diagramas de flujo. Nodos con seis formas, doce iconos y texto, y conectores ortogonales
  con asas, anclaje automático al lado más cercano, codos arrastrables (`Alt` + clic añade,
  doble clic quita), etiquetas y flechas.
- **Edición del diagrama**: deshacer/rehacer de 50 pasos, multi-selección con alinear y
  distribuir, guías y rejilla, encaje del lienzo al contenido y `COPIAR MERMAID` al
  portapapeles.
- **Escena editable**: además del PNG, la pizarra guarda su escena en `pizarra.json`
  (saneada en el host); al reabrir manda la escena y el PNG solo se usa si no la hay.
- **Dictado**: la frase siguiente ya entra detrás de lo dictado, también cuando el bloc
  acaba en una imagen o un fichero adjunto.

## [0.3.1] - 2026-10-29

- **Bloc de notas del dictado**: botón `COPIAR` en el pie, que copia el texto al
  portapapeles con los adjuntos como rutas, igual que el envío a la terminal.

## [0.3.0] — 2026-10-28

- **Visor Alfred 3D**: editor propio para ficheros `.blend` (doble clic en el Explorador o
  «Abrir en Alfred 3D» en el menú contextual). Vista con three.js y órbitas, `OBJETOS` con
  ocultar y casilla de `TEXTURAS` (materiales reales o arcilla), `CÁMARAS` —la de escena es
  la que usa Blender al renderizar—, `LUCES` con encendido y deslizador de 0 a 200 %,
  animaciones con clip, frames `INICIO`/`FIN` y `PLAY`/`STOP`/`LOOP`. El estado visual
  sobrevive al cambiar de pestaña.
- **Render de un frame o de la tirada** con salida `<base>_frame<####>.png` en la carpeta que
  se elija, cancelable. Selector `MOTOR`: `VISOR` (por defecto, captura desde la propia
  ventana sin necesitar Blender, iluminación aproximada) o `BLENDER` (render fiel con el
  motor, la cámara y la resolución del `.blend`).
- **Blender es opcional y se autodetecta** (ajuste → `PATH` → `C:\Program Files\Blender
  Foundation` → registro de Windows; gana la versión más alta). El pie enseña el Blender en
  uso y `CAMBIAR` lo cambia, limpia la caché y reexporta. Sin Blender siguen abriendo las
  escenas ya cacheadas y las que traen un `<nombre>.glb` junto al `.blend` (sidecar), con su
  `<nombre>.meta.json` opcional.
- **Exportación y caché**: Blender CLI exporta el `.blend` a GLB y `meta.json` en el almacén
  global, cacheado por la fecha del `.blend`. El `.blend` nunca se guarda.
- **Ajuste nuevo** `opencodeAgents.blenderPath`. Los `.blend` de Blender 5.x necesitan
  Blender 5.2 o más nuevo: el 4.4 los rechaza y el aviso del visor enseña el error de Blender.

## [0.2.4] — 2026-10-28

- **Ecualizador de fuego**: la barra pasa a lienzo pixelado 128×72 con paleta de fuego y una
  onda que sale del centro hacia los lados. En reposo consume un solo fotograma, no un bucle.

## [0.2.3] — 2026-10-28

- **Ecualizador de barras pixeladas** en lugar de la esfera anterior.

## [0.2.2] — 2026-10-28

- **Pizarra**: selector de color de fondo, recordado entre sesiones.

## [0.2.1] — 2026-10-28

- **Pizarra**: «NUEVA DESDE PORTAPAPELES» fija el lienzo al tamaño real de la imagen, así que
  el PNG y la copia de trabajo pesan mucho menos.

## [0.2.0] — 2026-10-28

- **Servidor MCP `voz` dentro de la extensión**: viaja en el paquete (`dist/voz-mcp.js`) y el
  instalador lo registra como `node <extensión>/dist/voz-mcp.js`. Ya no depende del paquete
  externo `@sombra/voz-mcp`, que nunca se publicó. La ruta se repara sola al activar si cambia
  la versión instalada.

## [0.1.0] — 2026-10-27

Primera versión.

- **Explorador** de agentes, MCP, skills y plugins de opencode, con selector de agente de
  sesión y una terminal por agente. El `❯` actúa sobre la pestaña de la TUI.
- **Editor de agentes** (permisos por herramienta y por patrón) y **editor de subagentes**
  de Claude Code.
- **Asignación** de agentes a modelos, con grupos de favoritos, precios y pestañas de
  configuraciones que vuelcan el mapa en los `.md` al cambiar de pestaña.
- **Contexto** con desglose de la ventana y compactación.
- **Estadísticas** de agentes y de prompts, con línea de tiempo y subagentes en paralelo.
- **Conectores** de opencode y **límites de consumo** por proveedor.
- **Voz** (SAPI de Windows, Edge, OpenAI, ElevenLabs) y **dictado** (SAPI, Whisper local,
  nube) con bloc de notas y adjuntos.
- **Pizarra** por capas.

Claude Code y Codex están en fase **experimental**: su soporte todavía no funciona del todo
bien y puede cambiar.
