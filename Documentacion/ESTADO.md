# Estado del proyecto

Última revisión: 2 de noviembre de 2026 · versión **0.8.0**

## Resumen

La extensión está fusionada, compila, empaqueta y se instala. Los tres contenedores
(Explorador + Contexto + Límites de consumo, panel de Voz y panel de Dictado) están
montados y probados en VS Code real. El repositorio se publica en abierto con la
estructura `Codigo_Fuente/` · `Documentacion/` · `Instalable/`.

La **0.8.0** está empaquetada en `Instalable/` (`opencode-alfred-0.8.0.vsix`), **sin release en GitHub
ni tag**, y entra la pestaña central **Bases de datos (MariaDB)** (`opencodeAgents.databases`, botón
de cilindro en la segunda fila de `Control`). Con `typecheck` y `compile` en verde y revisión **PASS**.

**Verificado**: `typecheck` y `compile` en verde; el núcleo (`src/databases/`: conexión, túnel SSH,
introspección, CRUD, buscador, DDL, consola, volcado y exportación) probado contra un MariaDB
desechable. El `.vsix` contiene `dist/extension.js`, `dist/alfred-mcp.js`, `media/databases.*`,
`resources/stt-sapi.ps1` y `node_modules/mysql2` + `node_modules/ssh2`.

**Sin verificar en VS Code real**: la webview de la pestaña (rejilla, consola, diálogos y el aspecto),
los diálogos nativos (contraseña en el almacén, confirmación de borrado y de escritura), el túnel SSH
contra un servidor real (solo con pruebas de núcleo) y el volcado con `mariadb-dump` lanzado desde la
extensión (el respaldo JS sí está probado).

**Nuevo ajuste**: `opencodeAgents.mariadbDumpPath` (vacío = buscar en `PATH` y `C:\xampp`).

**Dependencias nuevas**: `mysql2` y `ssh2` (externas de esbuild, en `dependencies`). El `.vsix` pasa de
~2,3 MB a ~8,1 MB por sus dependencias transitivas.

La **0.7.25** quedó empaquetada e instalada en local, **sin release en GitHub**: el
campo `version` subió solo para poder instalar con VS Code abierto. Entraron el **Explorador del proyecto**
(descrito debajo) con su menú contextual, los **tramos por agente** en la línea de tiempo de las
estadísticas de prompts y el **UAC de la temperatura de la CPU al pulsar**, no al arrancar. Con
`typecheck` y `compile` en verde.

**Línea de tiempo de las estadísticas de prompts**: cada agente guarda varios tramos en su fila. Si
el agente para mientras otro trabaja, el hueco queda vacío; si vuelve, se dibuja un tramo nuevo.
`workMs` no cuenta las esperas.

**Monitor del equipo**: al arrancar VS Code no se pide elevación: ni UAC ni ventana de PowerShell
(la consola del helper se oculta con `ShowWindow`). La temperatura de la CPU sale en `—` hasta que
se pulsa ese dato en el monitor (subrayado punteado); ese clic es el único que abre el UAC y,
mientras espera, se pinta `…`. Si se cancela, vuelve `—` con un aviso de que el resto del monitor
sigue, y el uso de CPU, la RAM, la GPU, la VRAM y la temperatura de la GPU se leen igual sin
permisos. Sustituye al aviso al arranque que traía la 0.7.24.

**Sin verificar en vivo**: el UAC real aceptado y cancelado desde ese clic y el proceso elevado
escribiendo y muriendo con VS Code. **Sin ver en VS Code**: la webview real del explorador —los dos
árboles, el arrastre entre columnas, el menú contextual y los diálogos de borrado y de push— y los
huecos del timeline con dos agentes alternando. El aspecto del bloque a ~300 px de barra lateral y
dos ventanas a la vez (mutex) siguen pendientes desde la 0.7.24.

El **Explorador del proyecto** de esta 0.7.25 es una pestaña central
(`opencodeAgents.projectExplorer`) que abre el icono nuevo de carpeta de la vista `Control`
(`btn-project`). Una o dos columnas, cada árbol con raíz independiente. Lista ficheros y carpetas
con su tamaño lógico (`stat.size`), barra y porcentaje respecto al padre, tamaños redondeados,
iconos SVG por tipo y `.md` resaltados. Busca por nombre o carpeta y por contenido en texto (tope
1 MB por fichero, sin binarios; omite `.git`, `node_modules`, `dist` y `build`) y muestra el
resultado en un árbol podado con sus ancestros. Chips de filtro git —`TODO`, `CAMBIOS`, `STAGED`,
`NUEVOS`, `SIN PUSH`, `LIMPIOS`— con insignias `M`/`S`/`?`/`D`/`R`/`↑` y `+N −M`. Git por CLI:
rama, `fetch`, `pull --ff-only`, `push` (con `-u` si no hay upstream y con confirmación), commit
de lo staged, `ADD ALL`, `checkout` y rama nueva. Borra a la papelera con confirmación
(permanente tras segundo aviso); copiar y mover por arrastre (`Ctrl` = copiar) y por menú
contextual Copiar/Cortar/Pegar, dentro del mismo árbol y entre árboles, sin sobrescribir. **Sin
menú nativo sobre el árbol**: el menú contextual de la webview trae comparar con Git
(`vscode.diff`), stage/unstage, descartar cambios (solo modificados, con confirmación), renombrar y
crear fichero. Git recibe pathspec literal y los watchers de las carpetas expandidas se cierran
antes de renombrar o borrar. Las rutas
van relativas y el host las valida dentro de la raíz de su árbol: sin symlinks, `.git` y la
raíz protegidos, raíces anidadas entre columnas bloqueadas. El estado vive en `workspaceState`
(`opencodeAgents.projectExplorer.layout`, `.roots`, `.expanded`, `.hidden`, `.split`). Escaneo
con tope de 150.000 entradas y profundidad 64, filas virtualizadas y watchers no recursivos de la
raíz más las carpetas expandidas. El explorador quedó revisado (`PASS`).

Va sobre la **0.7.24**, empaquetada e instalada en local (`--force`) y **sin release en GitHub** —su
`.vsix` ya no está en `Instalable/`, sustituido por el de la 0.7.25—: el panel de VOZ gana un
**monitor del equipo** de dos filas encima del ecualizador (`CPU` con temperatura y uso, `RAM` y
`VRAM` con total y uso, `GPU` con temperatura y uso), con barra de bloques y sondeo cada 2 s solo
con la vista visible y sin repintado si la muestra no cambia. Los datos los lee
**LibreHardwareMonitorLib** (0.9.4, MPL-2.0, en `resources/lhm/`) desde un proceso de PowerShell
persistente (`resources/sysmon-lhm.ps1`, en `src/sysmon/`), uno por sesión y uno solo aunque haya
dos ventanas, que escribe `sysmon.json` en el almacenamiento global y muere con el host. La
temperatura de la CPU exigía administrador: el UAC se pedía una vez por sesión con un aviso previo
en VS Code; si se cancelaba, o no llegaba la primera muestra en 20 s, se arrancaba sin elevar y esa
temperatura quedaba en `—` hasta reiniciar VS Code.

Va sobre la **0.7.23**, empaquetada, instalada (`--force`) y **publicada** (tag `v0.7.23` y
release en GitHub con el `.vsix` adjunto): el panel de **estadísticas de prompts** queda
reordenado. La lista
de la izquierda es estrecha (224 px), multiselección, con casilla, texto en una línea y papelera
por prompt; el agregado de la selección suma prompts, trabajo, tokens, coste y agentes. La línea
de tiempo va concatenada sin huecos y agrupada por agente, y a su lado hay dos gráficas de barras
por agente: tokens y coste. Probado en VS Code con sesiones reales. Va sobre la **0.7.22**,
empaquetada e instalada (`--force`), sin release en GitHub: el
chatbot de Mente local con herramienta de imagen, `ASIGNAR AGENTES` como icono de Control con su
segunda fila de módulos, los arreglos del dictado (soltar no deja el panel mudo, fin de habla en
manos libres con detector de pausa) y la recarga del historial del generador de imágenes. Va
sobre la **0.7.21**, empaquetada e instalada (`--force`), sin release en GitHub, en la que el
**generador de imágenes IA** recuerda entre sesiones el modelo de cada proveedor, el tamaño, los
pasos, la guía, la semilla y si es aleatoria (`opencodeAgents.imageGen`). Al abrir la pestaña se
comprueba el enlace con ComfyUI y se recarga el catálogo sin pulsar `CONECTAR`, hay un botón de
recargar junto a `MODELO` (y `CONECTAR` sigue recargando la lista), y `PASOS` y `GUÍA` (CFG)
comparten fila con `SEMILLA` y viajan al `KSampler` del servidor, con 20 y 7 por defecto.
**Sin ver en VS Code**: la webview real con un ComfyUI vivo, la persistencia tras recargar la
ventana y el aspecto de la fila nueva. Va sobre la **0.7.20**, empaquetada e instalada
(`--force`), sin release en GitHub: en el
**generador de imágenes IA**, la columna izquierda (ajustes) se estira y ocupa el hueco que
quedaba entre el formulario y la vista previa, mientras la derecha conserva su tope por alto y
sigue pegada a la derecha. **Sin ver en VS Code**: la webview real a distintos anchos. Va sobre
la **0.7.19**, empaquetada e instalada (`--force`), sin release en GitHub: en el
**generador de imágenes IA**, la columna derecha (vista previa e historial) se limita al alto
libre de la ventana, así que una pestaña ancha ya no fuerza scroll vertical, y sigue pegada a la
derecha. El ancho lo topa el alto que queda (`max-width: max(280px, calc((100vh - 280px) * 1.6))`,
`margin-left: auto`); en ventanas bajas (≤680 px y ≤580 px de alto) el formulario se aprieta —el
prompt más bajo y los campos compactos— sin ocultar controles. **Sin ver en VS Code**: la
webview real a distintos altos. Va sobre la **0.7.18**, empaquetada e instalada (`--force`), sin
release en GitHub, en la que el panel de VOZ
suma a los agentes en vuelo tres **actividades que no son agentes** —generar una imagen,
transcribir voz y cargar, instalar o borrar modelos de Ollama—, incluida la imagen que lanza
el MCP (deja `imagen-trabajando.json` en `%APPDATA%\voz` y la extensión lo vigila, con caducidad
de 15 min). Se pintan como una tarjeta más del mapa de `src/panels/activity.ts`, con **borde
discontinuo e icono** delante del nombre para no confundirlas con un agente de verdad, y
desaparecen al terminar. **Sin ver en VS Code**: el repintado real del panel con las tres
actividades encendidas a la vez y el camino MCP → tarjeta con el panel de voz abierto. Va sobre
la **0.7.17**, empaquetada e instalada, sin release en GitHub: el generador de
imágenes se puede **compartir con los agentes** con la casilla de su cabecera. Solo se enciende
si ComfyUI responde con modelos o si hay clave de OpenAI; mientras está compartido se revalida
cada 5 s y se apaga solo al primer fallo (la clave de OpenAI viaja al fichero compartido porque
el proceso MCP no ve `secrets`, y se borra al apagar). El botón del generador en `CONTROL`
brilla mientras está compartido. El MCP `mcp_alfred` publica dos herramientas nuevas,
`generar_imagen` (prompt, negativo y tamaño 64..2048) y `consultar_estado`; lo que genera un
agente cae en el historial y sus dos prompts aparecen en el panel. **Sin ver en VS Code**: la
webview real, la comprobación cada 5 s contra un ComfyUI vivo y el bucle completo MCP → panel.
Va sobre la **0.7.16**, empaquetada e instalada, en la que la pizarra y el **generador de
imágenes** dejan de pintar las scanlines del tema (las capturas salen limpias), el generador de
ComfyUI tiene **semilla fijable o aleatoria** (la usada queda en el campo), el historial se
**borra** imagen a imagen o entero con confirmación —solo dentro de `.alfred/imagenes`— y el
motor **OpenAI** admite cualquier servicio compatible con **URL base propia** y modelo escrito a
mano. Esa versión tampoco se vio en VS Code: la webview real y los diálogos nativos de borrado.
Va sobre la **0.7.15**, instalada, sin release, en la que nació la pestaña
central **Generador de imágenes IA**, que abre el botón de foto de la vista `Control` (antes
apagado). Dos motores: **ComfyUI** por su API HTTP (texto a imagen e imagen a imagen, con los
checkpoints y las LoRAs que tenga el servidor) y **OpenAI** (texto a imagen, con la clave en
`secrets`; al webview solo vuelve si hay clave o no). Las imágenes se guardan en
`.alfred/imagenes` —sin proyecto, en el almacén global— y el historial es esa carpeta: las 20
últimas. Los lados se recortan a 2048 px y a múltiplos de 8 en el host, con aviso, y el progreso
de un trabajo va en mensaje aparte para no reenviar la imagen de partida en cada tick. Esa
versión tampoco se vio en VS Code: la webview real, la CSP, los diálogos nativos y el
portapapeles. Va sobre la **0.7.14**, instalada, sin release, en la que los widgets de
`INTERFACES` se
**ajustan a la rejilla en absoluto**, no a la coordenada relativa de su contenedor. Como el
widget guarda su `x`/`y` relativos a la caja útil del padre (la barra de 28 px de una ventana,
la tira de 26 de las pestañas, los 110 de las pestañas verticales), el ajuste aplicado sobre esa
coordenada dejaba los textos, botones y campos de dentro fuera de la cuadrícula, y el fantasma de
la paleta no caía donde acababa el widget. El ajuste nuevo (`ajustaWidget`) encaja en el lienzo y
vuelve a relativo, y vale en los cuatro caminos que colocan o mueven un widget: soltar desde la
paleta, arrastrar, las flechas y duplicar. Un hijo nunca se sale de la caja útil de su padre; una
raíz sí puede irse a negativo, como antes. Las flechas ajustan solo el eje que mueven y pulsar
hacia fuera del borde no deja entrada de historial ni escribe la copia de trabajo; sin rejilla no
se redondea nada. Va sobre la **0.7.13**, empaquetada, sin instalar y sin release, en la que la
rejilla de la pizarra tiene
**paso configurable** y el ajuste se hace por la **esquina superior izquierda**. Junto al botón
`REJILLA` hay un campo numérico (`#grid-step`) que lleva el paso de 1 a 64 px, siempre cuadrado:
vacío o `0` vuelve a 8 y lo que sale del rango se acota; el encendido y el paso se recuerdan al
reabrir la pestaña. Con pasos pequeños la cuadrícula no desaparece —pinta una línea de cada `n`
hasta que se distinguen— y el ajuste sigue usando el paso fino. Mover un texto o una imagen
encaja su esquina (antes iba libre), mover varios nodos encaja la caja entera de la selección
(antes la del primer nodo), dibujar un nodo encaja sus dos esquinas y la silueta previa enseña
esa misma caja, `TEXTO` nace en la rejilla y las flechas mueven una celda (con `Mayús`, diez) en
vez de 1 px. Encendida, manda la rejilla y las guías inteligentes no desplazan nada; apagada
vuelven las guías y el movimiento de 1/10 px. Un temblor dentro de la misma celda ya no deja
entrada de historial. Va sobre la **0.7.12**, empaquetada, sin instalar y sin release, en la
que el `Campo` de la capa `INTERFACES`
puede verse como desplegable. El flag booleano `dropdown` (apagado por defecto) solo cambia el
aspecto —el mismo marco y la misma caja, con una flecha al final y el texto 20 px más corto para
no pisarla—; no hay lista de opciones ni comportamiento de lista. Se enciende con la casilla
**DESPLEGABLE** del inspector del cajón `INTERFAZ`, que solo sale para ese tipo: con el widget
apagado la flecha va en gris y en cajas de menos de 24 px no se pinta, para no salirse del marco.
Viaja en `pizarra.json` y en el saneado (`sanitizeUi`), así que sobrevive a guardar, cargar e
`init`, y las escenas anteriores quedan en `false`. Va sobre la **0.7.11**, que está empaquetada, sin
instalar y sin release: la pizarra se puede **guardar y
cargar con nombre**. Dos botones de icono en la tira de pizarras, junto al `+` y el `−`:
`GUARDAR` (`#btn-board-save`, disquete) pide un nombre y escribe la pizarra activa —cualquier
pestaña, también la 1— en `<raíz>/.alfred/.pizarras/<Nombre>/` con `pizarra.json` (escena
completa) y `pizarra.png` (aplanado), o en el almacén global sin carpeta de proyecto; el nombre
se valida (sin `\ / : * ? " < > |`, sin punto inicial ni final, hasta 60, sin reservados de
Windows) y si ya existe un modal confirma antes de sobrescribir, y si el PNG no llega se borra
el anterior y se avisa. `CARGAR` (`#btn-board-load`, carpeta) lista las guardadas en un
`showQuickPick` y sustituye **todo** lo que hay en la pizarra activa (lienzo, fondo, capas,
diagrama, imágenes, `INTERFACES`, trazos y textos), dejando una entrada de historial para
deshacer y escribiendo el resultado en la pizarra activa; la barra de estado dice la ruta real.
Va sobre la **0.7.10**, que está empaquetada, sin instalar y sin release: los widgets de `INTERFACES` se
anidan (soltar uno de la paleta sobre un contenedor —`container`, `window`, `tabs-h`, `tabs-v`,
`accordion`— lo mete dentro con coordenadas relativas a su caja útil; arrastrar uno colocado lo
reanida y, sacado fuera, vuelve a la raíz sin saltar de sitio; la caja útil del destino se marca
con un marco discontinuo cian y hay tope de 8 niveles, el del saneado) y encajar (`#btn-fit`)
mide también esa capa: `ajustarLienzo()` suma la caja absoluta de cada widget y desplaza solo
las raíces, así que una pizarra solo de widgets se encaja y el PNG de `requestPng` los incluye.
Va sobre la **0.7.9**, que está empaquetada, sin instalar y sin release: la vista **Control**
pierde el plegado `CONTROLES` (fuera `<details>`/`<summary>`) y la fila de botones ocupa toda la vista, con borde
transparente y 6 px de margen arriba, izquierda y derecha (abajo, 0), sin scroll. Va sobre la
**0.7.8**, que está empaquetada, sin instalar y sin release: la vista `Límites de consumo` lee la
clave de DeepSeek y de OpenAI de la tabla `credential` de las bases de opencode (`active = 1`,
la fila más reciente) y solo cae a `~/.local/share/opencode/auth.json` si no hay. opencode v2 ya
no actualiza ese fichero al cambiar la clave, así que el saldo se quedaba clavado en el de la
primera clave (55,38 USD en vez de 5,74 USD, comprobado en vivo). Va sobre la **0.7.7**,
paquete sin instalar y sin release, que pasó la vista **Control** a una sola
fila elástica (`flex-wrap`) con el grupo de sesión `‹ [terminal] ›` como botón principal —más
grande, relleno cian y halo— y cuatro botones de módulo **solo icono** al lado: el enchufe de
los conectores, el cerebro de `OLLAMA` y los dos apagados (generador de imágenes y chatbot). Al
estrechar, la fila salta a más líneas y los botones se estiran; debajo no queda nada, así que
el panel no saca barra de desplazamiento. `MENTE GLOBAL` pasa a llamarse `OLLAMA` en el
título y el `aria-label` de esa vista. Va sobre la **0.7.6**, que empaquetó los **Límites de
consumo** con el sello «hace X min» fuera de su propia línea: pasa a la cabecera, a la izquierda
de `REFRESCAR`, y cada ventana ocupa **una sola línea** —rótulo, barra y `%` a la derecha—; las
de peticiones (Copilot) añaden `hechas / tope` antes del `%`, la ventana al tope cambia la barra
por el
tiempo de reanudación en rojo y las que no tienen tope (saldo o gasto) se quedan igual. Se
borran las reglas huérfanas del CSS (`.win-top`, `.win-foot`, `.win-rest`) y `fmtCorto` de
`media/limits.js`. Va sobre la **0.7.5**, que bajó el apilado de Contexto de
460 a 300 px, así que entre 300 y 500 px la matriz y la leyenda siguen en horizontal y
encogen juntas (`.ctx-body` a `minmax(0, 1.2fr)` / `minmax(110px, 1fr)`) en vez de apilarse
con la matriz a todo lo ancho. El resto de la 0.7.4 se mantiene: `COMPACTAR` en la cabecera
de la leyenda, matriz de Contexto 10 × 10 achatada (casillas `16 / 9`), cabecera apretada y
leyenda repartiendo su alto. Va sobre la **0.7.4**, que devolvió `COMPACTAR` a la caja de la
leyenda y `.ctx-body` a dos columnas, y sobre la **0.7.3**, que aplana
la matriz de Contexto
(casillas anchas y bajas, 10 × 10, la caja baja de ~335 px a ~135-160 px), mueve `COMPACTAR`
a la derecha de la leyenda y aprieta la cabecera del HUD. Y sobre la **0.7.2**, que corrigió
la matriz a 10 × 10 (100 casillas de un 1 %, más baja y cuadrada, sin tocar el ancho de la
caja) sobre la **0.7.1**, que estrenó la vista **Control** con el lanzador de sesión, los
conectores y Mente local, dejó al Explorador con `GLOBAL` · `PROYECTO` · `ASIGNAR AGENTES` y
el interruptor de permisos, y recordó las tarjetas plegadas de Límites de consumo. Encima de
la **0.7.0**, que arregló el doble clic de la pizarra, la colocación armada de widgets, el
copiar/pegar del panel, el widget `LISTA`, la maqueta de Contexto y el pegado del dictado.
Sigue sin release publicada en GitHub.

**opencode es el centro del producto.** La extensión está pensada y orientada a opencode.
Claude Code y Codex son **experimentales**: se exploran y se manejan en parte, pero su
soporte todavía no funciona del todo bien y puede cambiar sin aviso.

## Qué está hecho

- **Explorador** de agentes, MCP, skills y plugins para opencode, Claude Code y Codex, con
  selector de proveedor activo, y **vista Control** con el lanzador de sesión, los conectores
  y Mente local (más dos huecos apagados para imágenes y chatbot).
- **Editor de agentes** de opencode (permisos por herramienta y patrón) y **editor de
  subagentes** de Claude con su propio formulario.
- **Tablero de asignación** agentes ↔ modelos, con grupos de favoritos, precios y
  configuraciones guardadas (cambiar de pestaña vuelca el mapa en los `.md`).
- **Panel de conectores** de opencode: catálogo, configurados, alta (clave, externa,
  OAuth, comando), apagado por política y borrado.
- **Contexto** con desglose de la ventana, compactación y medición para los tres CLIs.
- **Estadísticas de agentes** (tokens, coste, tiempo, sesiones) y **de prompts** (lista
  multiselección con borrado por fila, agregado de la selección, línea de tiempo concatenada
  agrupada por agente y barras de tokens y coste por agente).
- **Límites de consumo** por proveedor (DeepSeek, OpenAI, GitHub Copilot, OpenCode Go), con el
  despliegue de cada tarjeta recordado entre sesiones; OpenCode Go lee el consumo real de la
  consola (porcentajes con su reposición) y solo estima con las bases si esa ruta no existe.
- **Voz** (SAPI, Edge, OpenAI, ElevenLabs) con ecualizador de barras pixeladas, y **dictado**
  (SAPI, Whisper local, nube) con bloc de notas y adjuntos. Su servidor MCP `mcp_alfred`
  viaja dentro de la extensión (`dist/alfred-mcp.js`), no como paquete externo: cubre la voz
  (`speak`, `list_voices`) y la pizarra (diez herramientas sobre `pizarra.json`, tres de ellas
  para la capa INTERFACES, y el panel recarga solo).
- **Pizarra** por capas con lápiz, imágenes, textos, zoom y envío al prompt. Incluye una
  capa **DIAGRAMA** para dibujar workflows: nodos (formas e iconos) con la etiqueta encajada
  en la silueta y color propio, y conectores ortogonales con asas, codos arrastrables,
  etiquetas y flechas, agarrando lo que se ve; el lápiz y el borrador encienden la capa
  `TRAZOS` si estaba oculta; deshacer/rehacer, multi-selección, guías y
  rejilla, chivatos de dibujo, copia como Mermaid y escena editable persistida en
  `pizarra.json` (además del PNG); `Ctrl+C`/`Ctrl+V` copian dentro del panel nodos con sus
  conectores, conectores sueltos, widgets con su subárbol, textos e imágenes. La capa
  **INTERFACES** añade wireframes funcionales: catorce tipos de widget anidados por contenedor
  (el último, `LISTA`, con filas, fila resaltada, icono y barra de desplazamiento opcionales),
  cajón `INTERFAZ` con paleta e inspector, colocación armada al clic con fantasma bajo el
  puntero (`Esc` o cerrar la paleta cancela), edición de la etiqueta con doble clic y clic
  sobre el widget elegido que simula pestañas, acordeón y casillas.
- **Visor Alfred 3D** por fichero `.blend` (doble clic en el Explorador o «Abrir en Alfred
  3D»): vista con three.js y órbita estilo Blender, objetos con ocultar, cámaras (la de
  escena bloquea la vista), luces con deslizador, animaciones con rango de frames editable,
  casilla de texturas y render PNG de un frame o de toda la tirada. Dos motores: `VISOR`,
  por defecto, captura desde la propia webview y no necesita Blender; `BLENDER` renderiza
  con el motor y la cámara del `.blend`. Blender es **opcional** y se autodetecta: sin él
  abren las escenas ya cacheadas y las que traen un `.glb` al lado del `.blend` (sidecar).
  El `.blend` nunca se guarda.

- **Explorador del proyecto**: pestaña central de una o dos columnas con árboles de ficheros de
  raíz independiente, tamaño con barra y porcentaje respecto al padre, búsqueda por nombre y por
  contenido (texto, sin binarios), filtros git con insignias y `+N −M`, operaciones de git por
  CLI (fetch, pull `--ff-only`, push, commit, ramas) y borrar a papelera, copiar o mover entre
  árboles sin sobrescribir. Estado en `workspaceState`. **Sin ver en VS Code real.**

- **Mente local (Ollama)**: pestaña central con el cerebro local del equipo. Detecta la
  instalación y la da de alta o de baja con `winget`; enciende el cerebro (arranca
  `ollama serve` si falta) y lo apaga; el bloque SERVIDOR tiene su propio `ARRANCAR`/`PARAR`,
  independiente del interruptor. Lista los modelos con su tamaño y el espacio libre del
  disco, con filtro, orden, descarga con progreso y cancelación, borrado y modelo preferido.
  Con el cerebro encendido escribe `provider.ollama` en el `opencode.json(c)` global (y lo
  reescribe al descargar o borrar), así que Ollama aparece en `CONECTORES` y en
  `ASIGNAR AGENTES`; al apagar lo retira y al activar la extensión el servidor vuelve solo.
  Revisada (`PASS`), con `typecheck` y `compile` en verde.

## Siguiente

0. **Bases de datos en VS Code real** (0.8.0): abrir la pestaña desde `Control` y recorrer alta de
   conexión con contraseña en el almacén, túnel SSH (contraseña, clave y agente), huella
   recordada, explorador, rejilla con buscador y edición, consola con confirmación escrita y la
   copia `.sql`. Comprobar el volcado con `mariadb-dump` desde la extensión.
   - **La cuenta `root` del XAMPP de este equipo usa GSSAPI y no vale**: crear una cuenta con
     `mysql_native_password` o `ed25519` para las pruebas en vivo.
1. **Mente local en vivo**: pulsar `MENTE LOCAL` y recorrer la pestaña con VS Code real
   (instalar, encender, descargar un modelo, apagar) y comprobar que el proveedor `ollama`
   aparece en `CONECTORES` y en `ASIGNAR AGENTES`. Hasta ahora está verificado el código, no
   el recorrido completo.
2. **Probar el alta real de conectores** contra la API (crea credenciales; hasta ahora
   se validaron los formularios y las rutas con datos reales simulados).
3. **Pizarra de workflows en VS Code real**: puntero real de las asas, reenganche de
   conectores al mover el nodo, zoom con arrastre de tramos y la cabecera a poco ancho.
4. **Capa INTERFACES en VS Code real**: abrir el cajón `INTERFAZ` e insertar, anidar y mover
   widgets; pegar una imagen con `Ctrl+V` sobre un widget `image`; y comprobar el aspecto con
   tema claro y oscuro y a escalas de 125 y 150 %. De la tanda de estilo queda por ver el
   aspecto del swatch del selector nativo de color, los iconos de trazo a tamaño real y que el
   PNG salga sin la ayuda de la etiqueta vacía.
5. **Ventanas de herramienta de la pizarra en vivo**: comprobar el cajón de `NODO` a 100 % de
   zoom y el hueco que tapa en la esquina superior izquierda al dibujar con `LÁPIZ`.
6. **Lápiz real**: confirmar que los trazos no se cortan en un dispositivo táctil
   (depende del driver; el manejo de `pointercancel` ya está puesto).
7. **Visor 3D en VS Code real**: el motor `VISOR` de punta a punta (del `.blend` al PNG en
   disco con la extensión instalada) y el sidecar `.glb` junto al `.blend`. Hasta ahora está
   probado con Chrome, Blender 4.4 real y stubs del host, no con la ventana de VS Code.
8. **`modelo1.blend`**: Blender pinta 15 personajes apilados y su mundo anula el sol sobre
   lo visible, mientras el visor solo muestra lo visible. Rareza del `.blend`, no del visor:
   decidir si se documenta o se deja.
9. **Limpieza menor**: el `.vsix` arrastra ~1.6 MB de fuentes C++ de `koffi` que no se
   usan en ejecución.
10. **Claude y Codex en estadísticas de prompts**: hoy solo se miden prompts de opencode.
11. **0.7.3 a 0.7.9 sin ver en vivo**: abrir la vista `Control` y comprobar la fila elástica de
    la 0.7.7 —grupo de sesión como botón principal, la fila de
    iconos con el enchufe (apagado fuera de opencode), el cerebro `OLLAMA` con su brillo y los
    dos módulos apagados— sin barra de desplazamiento a 300/380/480 px (verificado en navegador
    headless, falta VS Code real), y la 0.7.9 sin el rótulo `CONTROLES`, con la fila ocupando
    todo el alto y los 6 px de margen; que `ASIGNAR AGENTES` se apaga con Claude o Codex;
    la matriz de Contexto a 10 × 10 achatada en panel estrecho y ancho (verificado en
    navegador a 450/500/640 px, falta VS Code real), el corte de 300 px de la 0.7.5 (matriz y
    leyenda en horizontal a 360/400/430/500/640 px, apiladas solo por debajo de 300), la barra
    de una línea por ventana de la 0.7.6 (verificada en navegador a 380 y 470 px, falta VS Code
    real) y que
    `COMPACTAR` vive dentro de la
    cabecera de la leyenda, a la derecha, sin desbordarla a 450/500/640 px; y que las tarjetas
    plegadas de Límites de consumo siguen plegadas tras recargar la ventana.
12. **Generador de imágenes en VS Code real**: el botón de foto de `Control` y su pestaña, la
    CSP de la webview, los diálogos nativos y el portapapeles, y un trabajo de punta a punta con
    ComfyUI y con OpenAI. ComfyUI se levantó a mano para probar el código
    (`main.py --port 8188`), pero la vista no se ha abierto en VS Code.

## Alcance

- **opencode es el objetivo principal**; Claude Code y Codex están en fase experimental.
- Las estadísticas leen las bases de opencode **en estricta solo lectura**.
- La extensión escribe el `model:` del fichero del agente, que opencode aplica a las
  sesiones nuevas; si el agente tocado es el de la sesión viva, también lo activa ahí.
- Las conexiones `env` de opencode no se borran desde el panel de conectores.
