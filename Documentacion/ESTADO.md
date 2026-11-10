# Estado del proyecto

Última revisión: 10 de noviembre de 2026 · versión **0.9.8**

La **0.9.8** (2026-11-10) está empaquetada en `Instalable/opencode-alfred-0.9.8.vsix` (el único
`.vsix` de la carpeta) e instalada en el VS Code de este equipo. Incluye el radar de noticias, los
chips de filtro del Explorador del proyecto (CAMBIOS, CONFLICTO, APARTE) y el arreglo de fechas
del Radar. Tag `v0.9.8`.

## Resumen

La extensión está fusionada, compila, empaqueta y se instala. Los tres contenedores
(Explorador + Contexto + Límites de consumo, panel de Voz y panel de Dictado) están
montados y probados en VS Code real. El repositorio se publica en abierto con la
estructura `Codigo_Fuente/` · `Documentacion/` · `Instalable/`.

**0.8.16** (2026-11-05): empaquetada en `Instalable/` (`opencode-alfred-0.8.16.vsix`). Es la
última versión con número del repositorio.

Desde la última revisión de este fichero llegó lo que aquí no estaba recogido: el
**comparador de modelos con BenchLM**, los **temas visuales** (Alfred, Manoli, Steampunk), el
**chatbot de Mente local** y el **generador de imágenes IA** compartido con los agentes, reunidos
en el CHANGELOG bajo las versiones previas. Y entre la **0.8.13** y la **0.8.16**: los **límites de
consumo del plan de Claude** con Claude de agente de sesión, el **tablero de asignación con
Claude**, el **contexto de 1M** de los Claude nuevos y las **estadísticas de prompts de Claude
Code y Codex**, además del reapunte automático del MCP `mcp_alfred`.

Detalle por versión: [`CHANGELOG.md`](CHANGELOG.md). Por decisión de la persona, ESTADO deja de
duplicar el CHANGELOG: este fichero solo cubre el estado actual y lo pendiente.

**opencode es el centro del producto.** La extensión está pensada y orientada a opencode.
Claude Code y Codex son **experimentales**: se exploran y se manejan en parte, pero su
soporte todavía no funciona del todo bien y puede cambiar sin aviso.

## Qué está hecho

- **Explorador** de agentes, MCP, skills y plugins para opencode, Claude Code y Codex, con
  selector de proveedor activo, y **vista Control** con el lanzador de sesión, los conectores
  y Mente local (hoy también con los módulos de imágenes y chatbot encendidos).
- **Editor de agentes** de opencode (permisos por herramienta y patrón) y **editor de
  subagentes** de Claude con su propio formulario.
- **Tablero de asignación** agentes ↔ modelos, con grupos de favoritos, precios y
  configuraciones guardadas (cambiar de pestaña vuelca el mapa en los `.md`). Con Claude de agente
  de sesión es tablero propio: los subagentes de `.claude/agents` y la sesión principal `CLAUDE` a
  la izquierda, los alias, el catálogo `anthropic` de models.dev y los modelos en uso a la
  derecha; sin favoritos ni configuraciones.
- **Panel de conectores** de opencode: catálogo, configurados, alta (clave, externa,
  OAuth, comando), apagado por política y borrado.
- **Contexto** con desglose de la ventana, compactación y medición para los tres CLIs. En Claude
  el límite sale del sufijo `[1m]` o de la familia y la versión: 1M en las familias nuevas (Fable
  y Mythos, Opus y Sonnet desde 4.6, Haiku desde 5), 200k en los 4.5, `claude-3-*` y los de proxy.
- **Estadísticas de agentes** (tokens, coste, tiempo, sesiones) y **de prompts** (lista
  multiselección con borrado por fila, agregado de la selección, línea de tiempo concatenada
  agrupada por agente y barras de tokens y coste por agente). Las de prompts leen el agente de
  sesión activo: las bases de opencode o los registros de Claude Code y Codex, con los subagentes
  de Claude como carriles y el coste siempre estimado en esos dos CLIs.
- **Límites de consumo** por proveedor (DeepSeek, OpenAI, GitHub Copilot, OpenCode Go), con el
  despliegue de cada tarjeta recordado entre sesiones; OpenCode Go lee el consumo real de la
  consola (porcentajes con su reposición) y solo estima con las bases si esa ruta no existe. Con
  Claude de agente de sesión la vista enseña solo su tarjeta del plan (ventanas de 5 h y semana),
  leída con el token OAuth de Claude Code en estricta solo lectura.
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
  árboles sin sobrescribir. Los filtros git mandan en chips: `TODO`, `CAMBIOS` (van dentro los
  sin seguimiento, en magenta), `STAGED`, `SIN PUSH` y `CONFLICTO` —los reales y los previstos
  con `merge-tree` tras un `fetch`—; y `APARTE`, que lista los stashes que crea Alfred al apartar
  un conflicto previsto, con Ver, Recuperar, Recuperar sobrescribiendo y Borrar. Estado en
  `workspaceState`. **Sin ver en VS Code real**: los chips `CAMBIOS`, `CONFLICTO` y `APARTE`, ni
  la predicción contra una remota auténtica.

- **Mente local (Ollama)**: pestaña central con el cerebro local del equipo. Detecta la
  instalación y la da de alta o de baja con `winget`; enciende el cerebro (arranca
  `ollama serve` si falta) y lo apaga; el bloque SERVIDOR tiene su propio `ARRANCAR`/`PARAR`,
  independiente del interruptor. Lista los modelos con su tamaño y el espacio libre del
  disco, con filtro, orden, descarga con progreso y cancelación, borrado y modelo preferido.
  Con el cerebro encendido escribe `provider.ollama` en el `opencode.json(c)` global (y lo
  reescribe al descargar o borrar), así que Ollama aparece en `CONECTORES` y en
  `ASIGNAR AGENTES`; al apagar lo retira y al activar la extensión el servidor vuelve solo.
  Revisada (`PASS`), con `typecheck` y `compile` en verde.

- **Comparador de modelos** (`A↔B` en `Control`, solo con opencode): favoritos a la izquierda,
  dos fichas de arrastrar-y-soltar con la ficha completa (límites de contexto y salida, tarifas,
  capacidades, fechas y estado) y caché en `globalState`. **Puntuaciones de BenchLM** —global y
  por categoría, con los exámenes— en la ficha y en las tarjetas de Conectores y Asignación, solo
  con lo ya cacheado: la clave en el almacén seguro, fila de **alias** cuando el nombre no casa y
  atribución «Datos de BenchLM.ai».

- **Temas visuales propios**: Alfred (oscuro, el por defecto), Manoli (claro, grises y pastel) y
  Steampunk (latón y cobre), elegibles con el comando **Alfred: Estilo visual** y el ajuste
  `opencodeAgents.theme`, compartidos por todos los paneles.

- **Generador de imágenes IA**: pestaña central con ComfyUI (texto a imagen e imagen a imagen,
  con los checkpoints y LoRAs del servidor) y OpenAI o cualquier servicio compatible con URL
  propia; historial en `.alfred/imagenes`, semilla fijable o aleatoria y **compartir con ALFRED**
  para que los agentes generen por el MCP (`generar_imagen` y `consultar_estado`).

- **Chatbot de Mente local**: pestaña central para probar los modelos de Ollama sin arnés de
  opencode, con streaming, bloque de pensamiento, imágenes adjuntas si el modelo tiene visión,
  historial, exportar y lectura en voz; y herramienta `generar_imagen` que usa la configuración
  ya establecida del generador.

- **Radar de noticias**: lee cinco feeds públicos (Hugging Face, arXiv cs.AI, Hacker News,
  GitHub blog y Simon Willison), los guarda en MariaDB (`alfred_radar`, con el perfil del panel
  de Bases de datos y la contraseña en el almacén), filtra con reglas por tema y un LLM
  configurable (Ollama local, OpenAI o DeepSeek), purga a los 3 días y escribe
  `.alfred/radar/ultimas.md` con las 30 mejores para que cualquier agente lo lea. Con la casilla
  «TRADUCIR TITULARES Y CUERPOS» el mismo modelo devuelve en la misma llamada el titular y el
  cuerpo en español (`titulo_es`/`resumen_es`), sin tocar el original ni la deduplicación, y el
  buscador mira también las traducciones. Pestaña
  central con **NOTICIAS** y **CONFIGURACIÓN**, botón en Control y los comandos
  *Radar de noticias* y *Radar — actualizar ahora*. Fuera de esta versión: la herramienta MCP
  `radar_buscar` y el boletín hablado.

## Siguiente

0. **Radar en VS Code real** con MariaDB encendido: abrir la pestaña, encender una fuente,
   actualizar y comprobar `alfred_radar.items`, el `ultimas.md` y que dos pasadas no duplican;
   después apagar MariaDB y ver el estado «sin conexión». Falta también probar la CSP del panel,
   los tres temas y el interruptor de pasada automática. La cuenta `root` del XAMPP de este
   equipo usa GSSAPI y **no vale** para el radar: hace falta una con `mysql_native_password` o
   `ed25519`.
1. **Bases de datos en VS Code real** (0.8.0): abrir la pestaña desde `Control` y recorrer alta de
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
10. **Chips del Explorador en VS Code real** (`ac57034`, dentro del `.vsix` 0.8.16 sin subir
    versión): ver `CAMBIOS`,
    `CONFLICTO` y `APARTE` con repos de verdad —colores, insignias y el menú de ver, recuperar y
    borrar los stashes— y probar la predicción de conflictos contra una remota auténtica.
11. **`.jsonl` vivo de Claude en estadísticas de prompts**: se reparsea entero en cada tick del
    sondeo, y `cliPromptColorOf` relee `.claude/agents` cada vuelta; medir el coste real con
    sesiones largas.
12. **0.7.3 a 0.7.9 sin ver en vivo**: abrir la vista `Control` y comprobar la fila elástica de
    la 0.7.7 —grupo de sesión como botón principal, la fila de
    iconos con el enchufe y el cerebro `OLLAMA` con su brillo, ya con los módulos de imágenes y
    chatbot encendidos— sin barra de desplazamiento a 300/380/480 px (verificado en navegador
    headless, falta VS Code real), y la 0.7.9 sin el rótulo `CONTROLES`, con la fila ocupando
    todo el alto y los 6 px de margen; que `CONECTORES` desaparezca de `Control` con cualquier
    agente que no sea opencode y `ASIGNAR AGENTES` se encienda con Claude (así es desde la
    0.8.14);
    la matriz de Contexto a 10 × 10 achatada en panel estrecho y ancho (verificado en
    navegador a 450/500/640 px, falta VS Code real), el corte de 300 px de la 0.7.5 (matriz y
    leyenda en horizontal a 360/400/430/500/640 px, apiladas solo por debajo de 300), la barra
    de una línea por ventana de la 0.7.6 (verificada en navegador a 380 y 470 px, falta VS Code
    real) y que
    `COMPACTAR` vive dentro de la
    cabecera de la leyenda, a la derecha, sin desbordarla a 450/500/640 px; y que las tarjetas
    plegadas de Límites de consumo siguen plegadas tras recargar la ventana.
13. **Generador de imágenes en VS Code real**: el botón de foto de `Control` y su pestaña, la
    CSP de la webview, los diálogos nativos y el portapapeles, y un trabajo de punta a punta con
    ComfyUI y con OpenAI. ComfyUI se levantó a mano para probar el código
    (`main.py --port 8188`), pero la vista no se ha abierto en VS Code.

## Alcance

- **opencode es el objetivo principal**; Claude Code y Codex están en fase experimental.
- Las estadísticas leen las bases de opencode **en estricta solo lectura**.
- La extensión escribe el `model:` del fichero del agente, que opencode aplica a las
  sesiones nuevas; si el agente tocado es el de la sesión viva, también lo activa ahí.
- Las conexiones `env` de opencode no se borran desde el panel de conectores.

