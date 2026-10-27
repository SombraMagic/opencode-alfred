# MEMORY.md

Memoria de trabajo del repositorio. `AGENTS.md` describe lo estable (comandos,
arquitectura, convenciones y errores fáciles de cometer): es la fuente de verdad.
Aquí va solo lo que cambia con el trabajo y no cabe allí.

## Protocolo

- El orquestador lee este fichero **al empezar** cada petición, antes de planificar.
- Se actualiza **al cerrar** un encargo, y solo si cambió algo de lo de abajo: estado,
  decisión tomada o trampa nueva. Si no cambió nada, se deja como está.
- Si algo se vuelve verdad estable del repo, se mueve a `AGENTS.md` y se borra de aquí.
- Corto: hechos con su consecuencia práctica. Nada de diario de intentos.

## Estado

- Repo git en `main` desde `d39aa64`, remoto `origin` →
  `https://github.com/SombraMagic/Alfred_VS` (**privado**). Nace de copiar
  `AgentesControl_opencode` y añadir `voz` (`src/voice/`,
  `media/{panel,dictado,sphere}.*`, `resources/stt-sapi.ps1`).
- Versión `0.1.0`, VS Code `^1.90.0`, tres contenedores: activitybar `opencodeAgents`
  (Explorador + Contexto + Límites de consumo), secondary sidebar `vozPanel`, panel
  `vozDictado`.
- Fusionado, compilando y empaquetado: `.vsix` `opencode-alfred-0.1.0.vsix` (raíz,
  gitignorado) instalado como `sombra.opencode-alfred@0.1.0`. Las dos extensiones viejas
  (`local.opencode-agents-editor@0.1.7` y `sombra.voz@0.1.0`) están desinstaladas.
- Pendiente: probar en VS Code con la ventana recargada (webviews, TTS, dictado y panel de
  conectores no se han visto en ejecución dentro de VS Code; el panel se probó en Chromium
  con datos reales).
- Panel de conectores de opencode montado (2026-10-25): botón CONECTORES junto a ASIGNAR
  AGENTES en Modelos (solo opencode), pestaña central de tres columnas, alta clave/OAuth/
  externa/comando y borrado con modal. Revisión **PASS**; falta probar un alta real y verlo
  en VS Code. `.vsix` reempaquetado e instalado (`sombra.opencode-alfred@0.1.0`).
- Editor de agentes opencode rediseñado (2026-10-25, commit `835f4c1`): estética HUD con
  `tokens.css` (como el de Claude), permisos con las 15 tools conocidas y reglas de patrón
  ordenadas (al añadir la primera regla con acción plana preexistente se siembra `*` con
  esa acción; el orden de claves del fichero se conserva porque gana la última que
  coincide), chips de color de tema + hex, opciones del proveedor (claves no gestionadas
  editables), contador de prompt y vista previa del frontmatter calculada en el host con
  `serializeAgentFile` (`preview` en init y en cada `validation`). `lsp` y `skill` movidos
  a PATTERN_PERMISSION_TOOLS (doc oficial oct-2026; `catalog.ts` ya los escribía como
  mapa). Efecto lateral buscado: `instructionsPanel` enlaza `tokens.css` y hereda la
  estética HUD. Revisión **PASS** (orden de permission contrastado con `opencode debug
  agents`); humos headless 55/55 + casos de corrección. `.vsix` reempaquetado e instalado;
  falta verlo en VS Code real (popup del combo bajo la cabecera sticky, scanlines, temas).
- Ventana de Contexto rediseñada (2026-10-25, commits `f0b7086` + `9df2097`): una sola
  fila `[pct] used / limit · Libre: X [COMPACTAR]` (pct ~17 px coloreado 70/90; ellipsis
  si no cabe, nunca dos líneas; a <~320 px de barra se recorta la cola del Libre), fuera
  agente·modelo y chip de estado (el error vive solo en el banner). Matriz 20×8 a ancho
  completo; leyenda en `<details>` con UNA línea por entrada (swatch + nombre ellipsis +
  tokens·% a la derecha), colapsado persistente con `vscode.getState()/setState()` del
  webview (VS Code lo conserva entre reinicios; no hace falta globalState del host).
  Revisión **PASS** en las dos rondas; humos headless en Edge (250 px, tema claro,
  limit=0, estimated, ok=false) con alturas medidas (−141 px). `.vsix` reempaquetado e
  instalado; falta el veredicto visual del usuario.
- Panel izquierdo refactorizado (2026-10-25, commit `6cde908`, esquema del usuario en
  `idea.md`): cabecera **MANDO** en ≤2 filas (GLOBAL/PROYECTO + grupo de sesión +
  ACEPTAR TODO; la sección PERMISOS y el hud-header viejo desaparecen), **EXPLORADOR**
  con dos `<details>` (Proyecto / Globales+integrados fusionados) y tarjetas de agente de
  UNA fila `[icono][nombre][modelo][vuelo animado][total/sesión tok][VER→editAgent]` (media
  query ≤340 px oculta modelo y chips), **CONTROL** con MCP y
  plugins en columnas de una línea por entrada y skills en plegables con switch y color
  activo/inactivo. Backend nuevo: `tokensTotal`/`tokensSession` por agente en los 3
  proveedores (opencode vía `latestSessionTokens` filtrado por proyecto; Claude suma
  `.jsonl` con caché por firma SIN tope —medido: cualquier tope degrada porque enumera
  todos los transcripts por pasada—; Codex suma rollouts con caché LRU 100). Alcances
  mezclados a propósito: total = histórico global del agente, sesión = del proyecto
  abierto. Cabos: `byAgent` de Claude solo mira la última sesión (subagente viejo → «—»);
  `[agents.*]` de Codex siempre 0/0 (el rollout no atribuye rol); los transcripts Claude
  se leen dos veces por tick con sesión viva (contexto + tokens). Revisión **PASS** (un
  NEEDS WORK por el acantilado de la caché, corregido y medido); humo headless Edge
  250/730 px. Ajustes vistos por el usuario (commit `e4cdba6`): VER va en un
  `.agent-actions` con `margin-left: auto` (con `.agent-name` en `flex: 0 1 auto` y nombre
  corto se quedaban pegados a los tokens) y el botón de sesión lleva el **svg del icono de
  la app** en vez de `OPEN`/`CLAUDE`/`CODEX` (paths inline en `AGENT_LOGOS`: opencode y
  Claude de simple-icons, Codex de lobehub — no hay svg en los installs locales; `d` de
  opencode también en el HTML para no pintar en blanco antes del primer `render`).
  Segunda ronda del usuario (commit `f14fde4`): `--text-dim` queda **solo** para apagado
  (`:disabled`, `.off`, placeholder) — nombres, rótulos de sección, `summary` y VER van a
  `--text` y lo secundario (modelo, tokens, leyendas) a `--text-soft` (intermedio, en el CSS de
  cada panel, nunca en `tokens.css`); las cabeceras MCP/PLUGINS usan la misma rejilla
  `--cat-cols` que `.cols`, en una sola fila (`GLOBAL` sobre su columna, `+ PLUGIN` empujado a
  la derecha sin desplazarla; a ≤340 px se ocultan el nombre de área y « PLUGIN»).
- Dictado (commit `a2af1f9`): ENVIAR conserva los saltos del bloc — se quitó el aplastamiento
  de `promptText()` (`media/dictado.js`) y de `sendPrompt()`. Multilínea viaja a la terminal
  como pegada con corchetes (`\x1b[200~…\x1b[201~`: sin bracketed paste cada `\n` era un Enter
  que partía el prompt); de una línea va crudo. El Enter final sigue aplazado 100 ms y el
  portapapeles sin terminal conserva los `\n`. Riesgo aceptado: un terminal SIN modo 2004 vería
  los escapes literales en multilínea; los TUI destino (opencode/Claude/Codex) lo soportan.
- Panel de voz (commit `a2af1f9`): los píxeles de cada agente en vuelo usan el `color:` de su
  `.md` (`WorkingAgent.color`, resuelto en `refreshStats`: opencode busca en `agentList.project`
  → `global`; Claude usa `claudeExplorer`, que ahora se calcula UNA vez por tick y se pasa a
  `buildExplorerData(claudeData)`). Tiñen el hex de 6 y los 8 nombres de Claude (`PALETTE` en
  `panel.js` casa `claudeAgent.css:363-370`); los nombres de tema de opencode caen al acento,
  como en el explorador.
- Estadísticas de prompts montadas y verificadas (2026-10-26, desde el commit `77f2140`):
  botón nuevo junto al de estadísticas de agentes, pestaña `PromptStatsPanel` y motor
  `promptFlow.ts`/`promptStats.ts`. V1 solo opencode v2. La monitorización
  (`opencodeAgents.promptMonitor`) está apagada por defecto y persiste; apagada no escanea
  las bases. Cada prompt terminado se guarda por `sesión:time_created` en
  `globalStorage/prompt-stats.json` (tope 500), con una fila por agente, segmentos de trabajo,
  tokens entrada/salida, duración y coste real o estimado. Las bases se abren con
  `openSqliteReadOnly()` estricto. `clear()` fija `clearedAt` para impedir que el escáner
  reimporte cierres anteriores al borrado; un prompt vivo al borrar sí se guardará cuando
  cierre. Revisión final **PASS**; `typecheck`/`compile` verdes. `.vsix` reempaquetado,
  instalado y probado en VS Code real (2026-10-26): monitor encendido, 7 subagentes en
  paralelo, prompt vivo con 8 carriles y colores, cerrado y persistido correctamente
  (74 s, coste estimado, `live:false` en `prompt-stats.json`).
- Reporte «timeline congelada» (2026-10-26, commiteado `8409dd3` y empujado; verificado en VS
  Code por la persona):
  el orquestador se reanuda tras un `idle` sin prompt nuevo, y el cierre en el PRIMER `idle`
  dejaba fuera todo el trabajo posterior. `buildPrompt` cierra ahora en el último `idle` del
  tramo antes del siguiente `user`. Trampas: un turno reanudado que pierde su `idle` final
  queda vivo hasta el siguiente `user`; los registros ya persistidos con cierre errado solo se
  corrigen por upsert si vuelven a escanearse. Verificado contra la BD real (registro 16:28 de
  `ses_e872c47c`: 16:37→17:31, 3→5 lanes) y con fixtures sintéticos. Falta verlo en la pestaña.
- `main` = `origin/main` en `870cc3c`: las estadísticas de prompts y los extras (`idea.md`)
  quedaron commiteados y empujados por orden de la persona (2026-10-26).
- Explorador (2026-10-26): MCP y PLUGINS ya no son dos filas sueltas de la sección de CONTROL.
  Van LOS DOS dentro de un único `<details class="fold" open>` con `<summary>MCP Y PLUGINS</summary>`,
  al final de la sección, debajo de SKILLS PROYECTO (decisión de la persona: un solo contenedor,
  abierto por defecto, SIN contador combinado en el summary; el `+ PLUGIN` se queda en el
  `area-head` de PLUGINS, o sea oculto al plegar). `media/explorer.js` no se toca: solo llena por
  `id`. CSS: `.cols + .fold` sustituida por `.fold > summary + .area-head { margin-top: 7px }`, y
  `.fold summary` pasa a `justify-content: flex-start` — con `space-between` un summary sin
  `.count` (`MCP Y PLUGINS`) desplaza el rótulo al borde derecho; los contadores siguen a la
  derecha por el `margin-left: auto` de `.fold summary .count`. Revisión NEEDS WORK → PASS. Falta
  verlo en VS Code (reempaquetar `.vsix`).
- Lote 2026-10-26 (idea.md, revisión **PASS**, typecheck/compile verdes; falta reempaquetar
  `.vsix` y verlo en VS Code): fuera el botón EDIT de las filas del Explorador (VER ya abre
  la pestaña con todo); fuera la vista Modelos entera (`modelsPanel.ts`, `media/models.*`,
  actions `setModel`/`clearModel`/`setSubagentModel`/`clearSubagentModel` y helpers muertos de
  `providers/claude.ts`/`codex.ts`) — solo sobrevivieron sus botones, CONECTORES y ASIGNAR
  AGENTES, ahora en una fila del mando (`.off` con proveedor ≠ opencode); nuevo componente
  compartido `media/mdEditor.*` que colorea Markdown en `#f-prompt` (editor y subagente
  Claude), `#f-text` (instrucciones) y el bloc del dictado; botón bombilla `#idea` en el pie
  del bloc que abre `idea.md` de la raíz (si no existe, modal → `writeAtomic` vacío → abrir).
  `refreshModels()` sigue poblando `models` para el tablero de asignación. Punto
  «Panel de GitHub simplificado» de idea.md: aplazado por la persona, sin alcance.
- `AGENTS.md` se sincronizó con este lote (vista Modelos fuera, mando con los dos botones,
  `media/mdEditor.*`): viaja en el mismo commit.
- Pizarra (2026-10-26, commit `85862c1`): pestaña central `PizarraPanel` + `media/pizarra.*` —
  lienzo 1024×1024 con 4 capas (fondo color/imagen, trazos lápiz+borrador con dureza,
  imágenes pegadas con mover/escalar/rotar, textos editables), barra [NUEVA EN BLANCO]
  [NUEVA DESDE PORTAPAPELES] [GUARDAR], snapshot debounced 600 ms al host y copia de trabajo
  `.alfred/adjuntos/pizarra-ultima.png` (tmp+rename binario, serializada). Comando
  `opencodeAgents.pizarra`; botón PIZARRA en el mando del Explorador (fila opencode) y dos
  botones en el pie del bloc: `#abrir-pizarra` y `#subir-pizarra` (flecha: `requestPng()` →
  `saveAttachment` como `img-pizarra-*.png` → chip en el cursor; `saveAttachment` ahora
  devuelve `boolean`). Tres rondas de revisión (NEEDS WORK → NEEDS WORK → PASS). Visto en VS
  Code por la persona (2026-10-26): lápiz, inserción de imágenes y pegado al prompt OK; el
  texto estaba roto (arreglado en la ronda 2 de abajo) y zoom/paneo eran petición pendiente.
  Empujado 2026-10-26 por orden de la persona (con `b706767` y las rondas 2-3).
- Panel «Límites de consumo» (2026-10-27, instalado, sin commit): tercera vista del
  contenedor izquierdo (`opencodeAgents.limits`), capa `src/limits/limits.ts`, check ámbar en
  CONECTORES solo si `limitsSupported` (sonda real con la clave, cacheada 10 min; el
  interruptor persiste en `opencodeAgents.limitsProviders`). Sondeo cada 10 min solo con la
  vista abierta y proveedores activos. Datos verificados: DeepSeek `GET /user/balance` (saldo
  USD); OpenAI costes del mes (`/v1/organization/costs`, pide clave admin) con respaldo de
  cabeceras rate-limit; GitHub Copilot: el endpoint personal de billing **no existe (404)** y
  el canje `copilot_internal/v2/token` está **muerto (403 con HTML de ToS)**; lo que funciona
  es lo que hace opencode: `GET /copilot_internal/user` directo con `Bearer <access>` del
  OAuth (scope `read:user`) y leer `quota_snapshots` (`entitlement`, `credits_used`,
  `unlimited`, `quota_reset_date`). Verificado: 2521 de 1500 premium (sobrepasado), chat y
  autocompletado ilimitados → solo se pinta `premium_interactions`. Cualquier cuerpo que
  empiece por `<` se trata como error, nunca como JSON. OpenCode Go **no tiene API con la clave** (el endpoint
  de la consola es interno): límites del plan sacados del bundle de la consola (Go 12/30/60
  USD en 5 h/semana/mes; Go Plus 48/120/240) y consumo **estimado por tokens × tarifa del
  catálogo `kv:models-dev:v2:catalog`**, porque la BD de opencode anota `cost = 0` para
  `opencode-go`.
- Trampas de la capa de límites: el temporizador debe morir con `onDispose` de la vista (y
  el dispose tardío de una vista vieja no debe apagar el de la nueva); el repintado
  asíncrono de Conectores necesita comparar identidad de `data` o pisa formularios abiertos
  con catálogo viejo; `supportsLimits` no puede ir en la ruta del primer pintado (la sonda de
  Copilot tarda hasta 8 s) — se pinta con la caché y se repinta al resolver. Ventanas Go:
  5 h rodante, semana UTC desde el lunes 00:00, mes UTC.
- Ronda 2 de pizarra (2026-10-26, commit `b2cd108`, vista en VS Code por la persona): tras
  el visto bueno del usuario (lápiz/imágenes/pegado OK) — texto arreglado (ver trampa),
  zoom con rueda ×1.15 (z∈[0.15,8]) anclado al cursor y paneo Espacio+arrastrar vía
  `#world` con CSS transform (exportación intacta 1024², zoom/paneo no ensucian la copia de
  trabajo), botón ZOOM 100% en el pie. Doble golpe manual fuera: solo `dblclick` nativo
  (el preventDefault no lo suprime en Chromium). Revisión con Chrome real por CDP: NEEDS
  WORK (foco) → fixes aplicados tal cual. Ronda 3 (misma fecha, commit `b2cd108`):
  «NUEVA DESDE PORTAPAPELES» ya hace lo pedido (un clic: limpia + imagen del portapapeles
  como FONDO vía `resources/pizarra-clipboard.ps1` STA desde el host; Ctrl+V sigue a
  IMÁGENES), orden de capas corregido a fondo→imágenes→trazos→textos (mi brief inicial estaba
  mal contra la spec), y lienzo de ASPECTO DINÁMICO: alto interno fijo 1024, ancho
  `clamp(round(1024*aspect), 256, 4096)` llenando el panel sin letterbox — el PNG exportado y
  `pizarra-ultima.png` ya NO son 1024²; resize conserva píxeles arriba-izquierda (scratch
  antes de reasignar width) y mide por `clientWidth/Height` (el borde de 1px falsearía el
  aspect).

## Decisiones

- Botón **BORRAR** en la cabecera de los tres formularios que tienen `Abrir .md / Cerrar / Guardar`
  (reporte 2026-10-26): `EditorPanel` (agentes opencode), `ClaudeAgentPanel` (subagentes) e
  `InstructionsPanel` (AGENTS.md global/proyecto). Borra el fichero del disco, llama a `onSaved`
  (en `extension.ts` es `refresh`: repinta árbol, modelos, stats y panel de voz) y cierra la pestaña.
  Confirmación modal siempre. Oculto mientras no hay fichero (`filePath` / `data.exists`); sale tras
  el primer guardado. Un `.md` de nombre integrado borrado = quitar la sobrescritura (el mensaje lo
  dice). Reutiliza `deleteAgent` de `store.ts`; `deleteAgentsMd(scope)` es nuevo ahí. Rojo `#e05a5a`
  con variante `body.vscode-light` a `#b3261e` (el criterio de `.banner.error`). **Sin botón** en las
  instrucciones de Claude/Codex y en los agentes de Codex: abren el editor de texto nativo o son
  tablas del `config.toml`, no tienen formulario. La cabecera pasa a 4 botones: sin `flex-wrap` por
  defecto (solo bajo 720 px), así que en un grupo de pestañas estrecho `Borrar` y `Guardar` se
  salen. Arreglado en la 2ª ronda con `flex-wrap: wrap` en `.head-actions` de `editor.css` y
  `claudeAgent.css`.
- **Solo el override, no el sistema** (2ª ronda del mismo reporte, 2026-10-26): `plan`, `build`,
  `general` y `explore` son integrados SIN fichero: no hay nada que borrar y el botón sigue oculto.
  Lo que sí se borra es su `.md` de proyecto o global (la sobrescritura). Antes no había forma de
  llegar a él: `renderAgents` (`media/explorer.js`) mete al integrado con override en la fila del
  INTEGRADO y `sinIntegrados` descarta la fila de fichero del mismo scope, así que el `.md`
  **no salía en ningún sitio**. Resuelto en `findLoadedAgent` (`src/extension.ts`): con
  `scope === "builtin"` devuelve primero el `.md` del proyecto, luego el global y solo si no hay
  ninguno el integrado. Con esto VER/EDIT del integrado con override abre su `.md` (con `Borrar`)
  y la sobrescritura puede eliminarse desde la propia fila. Los nombres se casan **exactos**: un
  `Plan.md` en el proyecto no cases con `plan` (igual que `listAgents`) y su fila queda como fichero
  normal.
- Cabecera de los formularios a **4 botones**: `.head-actions` tenía `flex-shrink: 0`, así que en un
  grupo de pestañas estrecho `Borrar` y `Guardar` desbordaban el contenedor. Ahora `min-width: 0` +
  `flex-wrap: wrap` + `justify-content: flex-end` en `media/editor.css` y `media/claudeAgent.css`
  (se comen a una segunda fila en vez de salirse).
- Plugins auto-cargados (reporte 2026-10-26, commiteado en `e2dffb5`): opencode v2 carga lo inmediato de
  `<globalOpencodeDir()>/plugins/` y `<raíz>/.opencode/plugins/` sin aparecer en la config
  (ficheros `.js`/`.ts` directos y carpetas con `package.json`/`index.*`/`server.*`).
  `loadPlugins` (`catalog.ts`) los descubre con `discovered: true`; las entradas `"-<nombre>"`
  del array son control de apagado (no fila) y `{package:…}` ya se entiende. La fila descubierta
  se casa por nombre de fichero/carpeta, no por el `id` de `Plugin.define` (coinciden en la
  práctica); comodines `*`/`.*` no se evalúan (`shortcut:` en el código). Apagar/encender una fila
  descubierta escribe/quita `"-<nombre>"` en la config del scope (`setDiscoveredPluginEnabled`);
  el globalState `disabledPlugins` solo sigue aplicando a los de config. Faltó comprobar el
  apagado en vivo: `.vsix` reempaquetado e instalado, a la espera del visto bueno.

- Un solo paquete y un solo `extension.ts`; nada de monorepo ni de paquete compartido.
- Se conservan los namespaces de ajustes `opencodeAgents.*` y `voz.*` para no invalidar
  la configuración del usuario; los ids de vista también se conservan.
- `voice/core` se porta dentro de `src/` (se importa estático y esbuild lo empaqueta):
  el proyecto no depende de `@sombra/voz-core` ni del monorepo `VOZ`.
- El MCP `voz` sigue siendo un proceso aparte, instalado globalmente; aquí solo se
  mantiene el comando que lo instala/actualiza en la config de opencode.
- El explorador de la barra izquierda dejó de ser `TreeView` y es un webview
  (`src/panels/explorerPanel.ts` + `media/explorer.*`): hacían falta las dos columnas de
  MCP/plugins, las listas plegables de skills y los botones con iconos propios.
- Se retiraron los comandos `opencodeAgents.*` que solo se invocaban con un nodo del árbol
  (edit, duplicate, rename, delete, openFile, createFromBuiltin, resetStats, clearStats,
  toggleMcp, toggleSkill, removePlugin, resumeSession, openPath). El estado por agente
  (reset/histórico) queda en el panel de estadísticas.
- `media/tokens.css` es la paleta única (HUD de VOZ). Todo panel nuevo enlaza ahí antes
  de su hoja. El estilo de `editor`/`stats` quedó como estaba: no estaban en el encargo.
- `node_modules` ya **no** se excluye del `.vsix`: `koffi`, `mpg123-decoder` y `ws` son
  externos de esbuild y tienen que viajar dentro.
- `▶ SESIÓN` limpia antes de abrir: cierra la pestaña de bienvenida y los `untitled`
  vacíos; nunca toca ficheros ni pestañas sucias. La bienvenida es un editor **custom**
  (`TabInputCustom`, `viewType` `workbench.editors.gettingStartedInput`), no un webview:
  el filtro cubre las dos clases y, de respaldo, la etiqueta `Welcome`/`Bienvenida`.
  Se cierran de una en una y sin preservar foco, porque `closeEmptyGroups` (ajuste, activo
  por defecto) solo actúa si el grupo afectado tiene el foco; después `pruneEmptyGroups()`
  enfoca con `focusLeftGroup`/`focusRightGroup` cada grupo vacío y lo cierra con
  `workbench.action.closeEditorsAndGroup` (con guardia: nunca un grupo con pestañas ni el
  único). Si ya hay una terminal `opencode` viva, la enfoca y no abre otra (sería un
  cliente duplicado sobre la misma sesión). Sin terminal, fuerza `statsService.collect()`
  si el primer sondeo no ha llegado (si no, abría sesión nueva) y lanza `opencode -s <id>`;
  si no hay sesión que case, `opencode -c`. Si el área queda vacía, la terminal se abre en
  `ViewColumn.Active` en vez de `Beside` para no dejar un grupo de más.

- El interruptor `PERMISOS` del explorador escribe `session.permissions` en
  `~/.config/opencode/cli.json` (`autoaccept` / `prompt`): auto-acepta lo que opencode
  pregunta, respeta los `deny`, y el TUI lo recarga sin reiniciar. Es del cliente TUI, no
  del servidor: no va en `opencode.json` ni se puede hacer con reglas `permissions` (las
  reglas del agente se añaden al final y ganarían a cualquier `allow` global).
- Los `ask` que el usuario ve vienen del frontmatter `permission:` (V1) de
  `.opencode/agent/*.md`; se dejan como están.
- La vista de contexto corta el historial en la última `compaction` completada de la
  sesión: solo cuentan los mensajes con `seq` posterior y el `summary` entra como
  conversación. Antes leía el último `assistant` con `tokens`, que es de antes de
  compactar, y el panel se quedaba clavado hasta la petición siguiente. Ojo: la propia
  fila `compaction` lleva `tokens` con el histórico viejo, por eso `usedTokens` sigue
  filtrando `type='assistant'`.
- El botón COMPACTAR de la vista lanza `POST /api/session/<id>/compact` sobre
  **la sesión que el panel está midiendo** (`contextView.currentSessionId()`), no sobre una
  re-elegida: `pickSession` solo acepta sesiones del proyecto abierto y el panel cae a la
  raíz más reciente de cualquier proyecto, así que re-elegir compactaba otra cosa.
  El endpoint **exige cuerpo JSON** (mandar `-d {}`): sin `-d` devuelve 400 «Expected
  object», y con un id inexistente contesta 404 aunque el cuerpo falte, así que probar la
  ruta con un id falso no detecta el cuerpo que falta.
- Trampa medida en opencode v2.1.4: `POST /api/session/<id>/agent` (lo que hace Shift+Tab) cambia
  `agent` en API y BD pero **no toca `model`**, y el `.md` del agente no se escribe: por eso leer
  `session_v2.model` no sigue al TUI. La BD coincide con la API (comprobado en 300 sesiones), así
  que el retraso no era de la BD. `keyOf()` lleva `id`, `agent` y `model` de esa sesión.
- La sesión viva la elige `pickSession()` por `max(time_viewed, time_updated)` de las raíces del
  proyecto (`time_viewed` existe en `session_v2`; en el esquema v1 vale 0): con dos terminales
  abiertas gana la que el usuario tiene delante, antes se fallaba y se actuaba sobre otra sesión.
- La lista que alimenta el tablero de asignación sale de `GET /api/model` (688 aquí), no del
  catálogo models.dev:
  `readConfigInfo` devuelve 822 y cuela vetados (nvidia en `blacklist`) que opencode no
  puede ejecutar. Coste del spawn: ~120 ms; solo en el arranque y al guardar config, nunca
  en el sondeo de 2 s. Cada modelo lleva `free` cuando la tarifa viene a cero en todos los
  tramos (65 de 688); el nombre nunca se usa como pista.
- El botón de sesión del Explorador es un selector de agente (`‹ [logo] ›`: svg con el icono
  de opencode / Claude / Codex en `AGENT_LOGOS` de `media/explorer.js`, antes decía `OPEN` /
  `CLAUDE` / `CODEX`; el nombre legible va en `title`/`aria-label`), acción `cycleAgent`):
  abre una terminal **por agente** y no
  toca las de los otros. Con sesión viva/medida se reanuda por id (`claude --resume <id>`,
  `codex resume <id>`); sin id caen a `claude --continue` / `codex resume --last`. Sin
  historial el CLI avisa y se cierra (decisión del usuario: no encadenar un fallback). Los CLIs se detectan **una vez al activar** (`where`/`which`, `timeout` 5 s,
  en segundo plano, no en `activate` a la espera: un `await` ahí rompe `refresh()` por TDZ);
  `codex` no está instalado aquí, así que el selector tiene dos paradas. Elegido en
  `opencodeAgents.sessionAgent`. Ojo: `runningTerminal` casa por **nombre exacto** de
  terminal, así que adopta también la del comando de paleta `opencodeAgents.newSession`
  (clave `__new__`, que sigue creando una sesión nueva).
- El selector es el **proveedor activo**: Explorador y Contexto leen y escriben
  la config del CLI elegido, no la de opencode. `src/providers/claude.ts` (agentes
  `~/.claude/agents`, MCP de proyecto en `.mcp.json`, skills de solo lectura, plugins en
  `enabledPlugins`, permisos en `permissions.defaultMode`, `CLAUDE.md`), `codex.ts`
  (`[agents.*]`, `[mcp_servers.*]`, skills de solo lectura, `[plugins.*]`,
  `approval_policy`, `AGENTS.md`) y `toml.ts` (editor TOML quirúrgico: conserva comentarios
  y CRLF, no es un parser completo).
- Lo que no se puede escribir: Claude no deja apagar skills (van con `toggleable: false`)
  y Codex tampoco las suyas. Los MCP de usuario/local de Claude no se tocan en
  `~/.claude.json` (solo lectura): se piden con `/mcp disable|enable <servidor>` a la
  sesión viva y el CLI los persiste por proyecto; con diálogo abierto no se inyecta, y sin
  terminal se avisa. Decisión del usuario (2026-10-24): esta vía, no escribir el fichero.
- Modelos: sin la vista, no queda panel de modelos para Claude/Codex ni escritura de su
  `model` desde la extensión. En Claude el modelo con el que arrancan las sesiones nuevas lo
  sigue resolviendo `src/providers/claude.ts` (`ANTHROPIC_MODEL`, entorno o `env` de
  settings.json, tapa a `settings.model`) solo para leerlo: mostrarlo y medir. En opencode la
  única escritura de modelo viva es el `model:` del `.md` que hace el tablero (`setAgentModel`).
- Contexto: Claude mide el `.jsonl` de `~/.claude/projects/<slug>/` (`input + cache_read +
  cache_creation` del último assistant con uso > 0; `limit` 1M si el modelo acaba en
  `[...]`); Codex, el último rollout con `cwd` del proyecto (`last_token_usage.total_tokens`
  y `model_context_window`). Si la sesión más nueva no tiene medición se usa la anterior
  medida; `<synthetic>` y los `token_count` con `info: null` no cuentan.
- COMPACTAR con Claude/Codex escribe `/compact` en su terminal (no hay API local); con
  opencode sigue siendo `POST /api/session/<id>/compact` con cuerpo `{}`.
- En Claude no hay agente «primary»: el orquestador es `CLAUDE.md` (su prompt, con
  `@AGENTS.md` al final para cargar las reglas del repo). Por eso **no** hay
  `.claude/agents/orquestador.md`: se retiró a propósito. Con CLAUDE seleccionado, PROYECTO
  abre UN solo fichero siguiendo la precedencia de Claude Code (`CLAUDE.md`; si no,
   `AGENTS.md`; si no hay ninguno, ofrece crear `CLAUDE.md` en vez de escribirlo en silencio);
   GLOBAL sigue abriendo/creando `~/.claude/CLAUDE.md`. Compartido por el botón y por la fila
   `CLAUDE` en `openClaudeInstructions(scope)`; el `title` nombra el fichero del proveedor
   (`AGENT_FILE` en `media/explorer.js`).
- Las terminales de agente se abren como **pestaña del grupo activo** (`ViewColumn.Active`),
  nunca con `Beside`: se cambia con la pestaña de arriba. `openTerminal` tolera una entrada
  del mapa ya destruida (leer `exitStatus` de una terminal dispose lanza y el clic no hacía
  nada), cierra la pestaña muerta antes de crear y adopta una terminal viva del mismo
  agente. `onDidChangeActiveTerminal` cambia `sessionAgent` y repinta todo: el selector
  sigue a la pestaña, también al cerrar (VS Code activa otra).
- En Claude el Explorador pinta una única fila INTEGRADOS `CLAUDE` (la sesión principal):
  no hay integrados reales y la lista salía vacía. Se marca EN VUELO con el mismo registro
  de sesiones y su clic abre el fichero de instrucciones (`CLAUDE.md`, o `AGENTS.md` si no
  hay), y si no hay ninguno ofrece crear `CLAUDE.md` en vez de escribirlo en silencio.
- Editar o crear un subagente de Claude abre un panel propio (`ClaudeAgentPanel`), no el
  `.md`: identidad, herramientas (omitir = hereda todas), modelo con alias y mapeo, color
  nominal, `permissionMode`/`effort`, avanzado (`maxTurns`, `skills`, `memory`, `isolation`,
  `background`, `omitClaudeMd`) y vista previa del YAML. Las claves no gestionadas
  (`hooks`, `mcpServers`…) se conservan. El nombre solo admite `[a-z0-9._-]`; la
  descripción es obligatoria. Reiniciar Claude solo si la carpeta `agents` del destino no
  existía al arrancar.
- Orden del Explorador (2026-10-26, sustituye al de 2026-10-25): cada bloque `<details>` va
  por su cuenta, SIN subencabezados. PROYECTO: integrados con override en el proyecto →
  primarios → subagentes. GLOBALES: primarios → integrados (los que no son de proyecto) →
  subagentes. El reparto y el orden viven en `renderAgents` de `media/explorer.js`
  (`rankProject`/`rankGlobal`, sort estable con desempate por nombre: el host manda los
  integrados en orden fijo `build, plan, general, explore`). Con `.md` del integrado en el
  proyecto, SU FILA es la del integrado (badge ámbar, clase `mode-builtin-project` en
  `explorer.css`) y la fila de fichero del mismo scope se descarta: antes se pintaban las
  dos duplicadas. Un integrado sobrescrito en proyecto y global sale una vez en PROYECTO y,
  en GLOBALES, solo la fila de fichero global con su chip SOMBRA. `agent.mode` NO se toca
  (va en el `title` del VER): la marca se pasa como `extraClass` a `agentRow`/`fillAgents`.
  Claude/Codex no se enteran: su fila `CLAUDE` (o `builtin: []`) cae en GLOBALES sin badge.
- Ecualizador del panel de voz (2026-10-25): el `color:` del `.md` tiñe también el NOMBRE de
  la tarjeta (variable `--agent-color` puesta en la tarjeta en `makeCard`/`renderAgents` de
  `media/panel.js`; los CSS solo leen `var(--agent-color, ...)` en `media/panel.css`). Antes
  el color solo llegaba al canvas y `.agent.streaming .agent-name` pintaba `--neon` fijo: por
  eso la primera fila (el agente principal, siempre en streaming) se veía celeste. Un agente
  SIN `color:` (p. ej. `orquestador`) o con nombre de tema sigue cayendo al acento: es el
  comportamiento elegido, no un fallo.
- El panel de dictado se rediseñó: bloc a la izquierda, configuración en medio (plegable)
  y controles a la derecha; al plegar, el bloc gana el ancho y el estado se recuerda en
  `globalState` (`voz.dictado.configCollapsed`). El micrófono es cuadrado redondeado, con
  tarjeta de MANOS LIBRES al lado (114×84) y vúmetro de 12 px; un clic en el micro con
  manos libres lo apaga. También acepta ficheros soltados (chip con icono y
  `[[file:ruta]]`) y elegidos con ADJUNTAR. Soltar en una webview exige **Mayús**; sin él
  VS Code intercepta el gesto, así que ADJUNTAR es la vía fiable. La fila URL DE LA API
  (motor nube) edita `voz.dictado.cloudUrl` en caliente: vacía vuelve al endpoint de
  OpenAI y solo acepta `http(s)://`. Visto en Chromium headless; falta verlo en VS Code
  real con la ventana recargada.
- El panel de dictado adjunta imágenes pegadas (Ctrl+V): se escriben en `<raíz>/.alfred/adjuntos`
  (ignorado por `.gitignore` y `.vscodeignore`) o en el almacén global sin carpeta, y el bloc
  `contenteditable` las guarda como `[[img:ruta-escapada]]`. Probado por el usuario en VS Code.
  Pegar **texto** de varias líneas llegaba fundido a ENVIAR porque Chromium lo mete en `<div>`
  y `serialize()` solo entendía `BR`: arreglado y verificado en Chromium headless. Pegar texto
  plano tampoco entraba (Ctrl+V ignorado): la rama usaba `execCommand("insertText")`, poco
  fiable en el webview, y `getData("text/plain")` a veces viene vacío. Ahora inserta por
  Range (`insertPlainText`) con fallback al `item.getAsString`. Commit `255d6f1`.
- Asignación agentes↔modelos es pestaña central (`AssignPanel` + `media/assign.*`), abierta
  desde el botón ASIGNAR AGENTES del mando del Explorador. Conectar escribe
  `model:` en el `.md` (no cambia la sesión viva, solo las nuevas). Los integrados sin
  override piden scope y crean el `.md` que los sobrescribe; el prompt integrado se conserva
  (comprobado con `opencode debug agents`). Favoritos en grupos: ver el punto de abajo. El
  tablero se cierra al cambiar a Claude/Codex. Tres columnas, `media/assign.html` como
  plantilla con marcadores. El buscador y los conectores apagados persisten en
  `assignSearch`/`assignProvidersOff` (debounce de 300 ms en el webview). Clic en un agente
  o en un favorito resalta el cable que los conecta (`hot`/`sel`, estado solo visual del
  webview; otro clic deselecciona).
- Grupos de favoritos en el tablero (2026-10-26, commit `372e221` empujado; probado en VS
  Code, `.vsix` instalado): la lista
  plana pasa a `opencodeAgents.favoriteGroups` (`[{name, ids}]`) con pestañas en
  `media/assign.*` (crear `+`, renombrar a doble clic, borrar con modal) y el grupo activo
  persistido por NOMBRE en `opencodeAgents.assignGroup`. Consecuencias: un modelo puede estar
  en varios grupos; cables y estrellas solo miran el grupo activo; el host emite
  `favoriteGroups` SIN filtrar por catálogo vivo (el modal anuncia lo que de verdad se borra)
  y `opencodeAgents.favoriteModels` se reescribe con la unión deduplicada de todos los grupos
  (compatibilidad de bajón). `ModelEntry.cost` (`{input, output}`, primer tramo de
  `GET /api/model`) pinta `$X in · $Y out`; con ambas tarifas a 0 no pinta nada (vale `FREE`).
  El `click` de pestaña lleva 250 ms de retardo para no comerse el `dblclick` del renombrado.
  Dos rondas de revisión (la primera `NEEDS WORK`). Visto y aprobado por la persona en VS Code.
- Conectores de opencode: pestaña central (`ConnectorsPanel` + `media/connectors.*`) abierta
  con el botón CONECTORES del mando, visible solo con opencode. La izquierda une
  `GET /api/integration`, `GET /api/provider`, `GET /api/model` y el catálogo models.dev
  (`loadRegistry`); el centro lista los configurados y la derecha (la columna más ancha) los
  modelos con precio, descripción y contexto. Apagar escribe una política
  `provider.use` con `deny` en el `opencode.json(c)` global; encender quita la regla exacta y
  añade `allow` (la última gana). Eliminar pide modal y borra credenciales con
  `DELETE /api/credential/<id>` (nunca la BD), `provider`/`providers` de todos los config,
  `disabled_providers` y las reglas exactas; las conexiones `env` no se borran desde aquí. El
  alta usa `connect/key|external|oauth|command`; OAuth con `mode:"code"` **no** se sondea
  (repintaría el campo del código) y el intento conserva URL/instrucciones al fusionar
  estados. La clave no se registra ni viaja al webview. Buscador y selección persisten en
  `connectorsSearch`/`connectorsSelected`; el catálogo en vivo se refresca al abrir, al
  refrescar y tras cada acción, no en el sondeo de 2 s.

## Trampas ya pagadas

- Editar la UI de un panel es tocar dos sitios: la cadena HTML del panel en
  `src/panels/*.ts` **y** el `media/*.js`/`*.css` correspondiente.
- El `pattern` de los formularios de `/api/integration` es una regex **parcial** de opencode
  (p. ej. `\S`), no el `pattern` HTML (que ancla todo el valor): copiarlo al input bloquea
  perfiles/proyectos de más de un carácter. Se valida en el servidor.
- `connections[].status` de `/api/integration` es un objeto `{status,message,url}`, no un
  string; hay que leer el `status` anidado o se pierde un `needs_auth`.
- Al añadir una política a un `policies: []` escrito en una línea, insertar en el inicio de
  la línea rompe el JSONC; hay que insertar antes del `]`.
- `cancelAttempt` distingue OAuth y comando: el `DELETE` de comando va a
  `/connect/command/<attempt>`, no a `/connect/oauth/<attempt>`.
- Verificar `catalog.ts`/`paths.ts` con stubs fuera de la extensión es peligroso: si el stub no
  aplica el ajuste `globalConfigDir`, las escrituras van a la config global REAL de opencode (un
  subagente dejó ahí `"plugin": ["./plugins/caveman"]`; limpiada a mano). Usar `globalConfigDir`
  apuntado a temp en el stub, o no ejercitar rutas de escritura.
- `esbuild --production` minifica: buscar identificadores (`PLUGIN_MARKERS`) en
  `dist/extension.js` instalado da falsos negativos; buscar literales de string (`server.js","server.ts`).
- `npm run compile` no valida tipos: esbuild no typechequea.
- Un panel central nuevo NO debe enlazar `media/panel.css` (es la hoja del panel de voz y
  trae globales: `textarea { min-height:66px }`, `width:100%` en select/input): contamina el
  editor. Base real = `tokens.css` + la hoja propia.
- `capture`/snapshot contra un webview que aún no procesó `init` exporta lienzo EN BLANCO y
  pisa la copia de trabajo: el host debe esperar su promesa de init (`iniciado`) antes de
  poster `capture`, y el webview enlazar la carga de `init` (`cargando`) antes de componer.
- `preventDefault()` en el `pointerdown` del lienzo (necesario para que el foco por defecto
  no robe un blur→close al textarea de texto) deja el foco en el último control (deslizador,
  select): hay que soltarlo con `document.activeElement.blur()` salvo editor/body, o el guard
  de INPUT del keydown mata el paneo con Espacio y el Delete de la selección. Y ojo:
  `preventDefault` NO suprime `click`/`dblclick` en Chromium — verificado con CDP real.
- Lápiz digital / dedo: sin `touch-action: none` en el marco, Chromium se queda el arrastre
  como gesto de scroll y suelta `pointercancel` (que NO dispara `pointerup`): el `drag` queda
  clavado y el trazo persigue al lápiz en el aire (hover). Enlazar `pointercancel` al `onUp`
  además del CSS. Pendiente de confirmar con el lápiz real de la persona.

- VS Code carga la extensión **instalada** (`%USERPROFILE%\.vscode\extensions\…`), no el repo:
  un cambio en `media/*` o `dist/` no se ve hasta reempaquetar el `.vsix`
  (`npx @vscode/vsce package`), reinstalar (`code --install-extension … --force`) y
  recargar la ventana. El usuario probó así un cambio "invisible" por esto.
- Un `.md` de agente con `color:` de nombre (p. ej. `primary`) SÍ se registra en
  opencode v2.1.4, pero `opencode debug agents` no conserva el color (el hex `#rrggbb`
  sí). La doc oficial (oct-2026) documenta los nombres de tema; en la práctica actual
  pulsar un chip de tema es un no-op silencioso. Comprobar con `opencode debug agents`.
- El analizador de prompts usa `openSqliteReadOnly()`, pero `StatsService` y `contextWindow.ts`
  siguen usando `openSqlite()`, que si la apertura readonly falla reintenta en modo escritura.
  No extender ese fallback a ninguna lectura nueva.
- El tool de delegación en opencode v2 se llama `subagent` y su parámetro es `agent`.
- Los `.js` de `src/voice/core` son specifiers de TypeScript (`.js` en el import, `.ts`
  en disco): esbuild los resuelve, `tsc` también con `moduleResolution: Node16`. No los
  "arregles" a `.ts`.
- `mpg123-decoder` es ESM puro: en el bundle CJS se carga con `import()` dinámico dentro
  de `mp3ToPcm`; no lo importes estático (TS1479) ni lo quites de los externos.
- `__filename` sustituye a `import.meta.url` en `voice/core/{player,recorder}.ts`: la
  salida es CJS.
- El panel de voz solo puede recibir tarjetas si `refreshStats` llama a `updateAgents`
  **antes** del corte por `key`; si no, con el snapshot sin cambios las tarjetas se quedan
  congeladas.

## Cabos sueltos conocidos

- El `.vsix` arrastra ~1.6 MB de fuentes C++ de koffi que no hacen falta en runtime:
  recortable con `.vscodeignore` si algún día importa el tamaño.
- `.opencode/agent/*` y el manifiesto siguen llamando al proyecto `opencode-agents-editor`
  en varios textos.
- `src/agents/validate.ts` acepta colores con nombre (la doc los lista); el runtime
  v2.1.4 los ignora. El validador es más permisivo que el runtime.
- `PATTERN_PERMISSION_TOOLS` en `src/agents/types.ts` dice `bash`; la clave real de
  opencode es `shell`.
- `opencode-dev.db` (esquema v1, grande) no aparece en la vista de contexto: `scan` solo
  lee `session_v2`/`session_message`.
- `README.md` todavía describe solo la extensión de agentes.
- Desde el explorador ya no se renombran agentes ni se abre la config de un MCP/skill
  (antes, desde el árbol). `deleteAgent` volvió a tener UI (botón BORRAR de los formularios);
  `duplicateAgent` y `renameAgentFile` siguen sin UI.
- El `.md` del global sombreado se abre desde su fila con VER (`findLoadedAgent` resuelve por
  nombre+scope; el `openAgentFile` del Explorador se retiró con el botón EDIT).
- Conectores: los formularios con varias condiciones `when` solo usan la primera (hoy no hay
  ninguno con más de una). `minItems`/`maxItems`/`format`/`custom` se mapean y no se aplican.
  Borrar deja a veces `"provider": { }` o `"disabled_providers": []` (válido).
- El alta real de clave/OAuth no se ha probado contra la API (crea credenciales): se probaron
  los formularios y las rutas con mocks y lecturas reales. El panel tampoco se ha abierto en
  VS Code, solo en Chromium con datos vivos.
- `opencode api ... -d` lleva la clave en los argumentos del proceso: visible un instante en
  la lista de procesos del sistema.
- mdEditor: en el bloc del dictado el deshacer nativo y la selección múltiple quedan degradados
  (declarado `shortcut:`); el overlay de las textarea no repinta al cambiar de tema (solo en
  input/scroll/resize). Nada visto en VS Code: falta reempaquetar el `.vsix` y ver la fila del
  mando, los colores, el bloc y el botón bombilla.
- Claves muertas sin limpiar: `opencodeAgents.recentModels` en `globalState` de quien la tuviera
  y la vista «Modelos» en layouts guardados (VS Code avisa de la vista eliminada; no hay acción
  desde el código).
