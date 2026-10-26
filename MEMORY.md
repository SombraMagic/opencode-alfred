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
  (Explorador + Modelos + Contexto), secondary sidebar `vozPanel`, panel `vozDictado`.
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
  UNA fila `[icono][nombre][modelo][vuelo animado][total/sesión tok][VER→editAgent][EDIT→
  openAgentFile]` (media query ≤340 px oculta modelo y chips), **CONTROL** con MCP y
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
  250/730 px. Ajustes vistos por el usuario (commit `e4cdba6`): VER/EDIT van en un
  `.agent-actions` con `margin-left: auto` (con `.agent-name` en `flex: 0 1 auto` y nombre
  corto se quedaban pegados a los tokens) y el botón de sesión lleva el **svg del icono de
  la app** en vez de `OPEN`/`CLAUDE`/`CODEX` (paths inline en `AGENT_LOGOS`: opencode y
  Claude de simple-icons, Codex de lobehub — no hay svg en los installs locales; `d` de
  opencode también en el HTML para no pintar en blanco antes del primer `render`).
  Segunda ronda del usuario (commit `f14fde4`): `--text-dim` queda **solo** para apagado
  (`:disabled`, `.off`, placeholder) — nombres, rótulos de sección, `summary` y VER/EDIT van a
  `--text` y lo secundario (modelo, tokens, leyendas) a `--text-soft` (intermedio, en el CSS de
  cada panel, nunca en `tokens.css`); las cabeceras MCP/PLUGINS usan la misma rejilla
  `--cat-cols` que `.cols`, en una sola fila (`GLOBAL` sobre su columna, `+ PLUGIN` empujado a
  la derecha sin desplazarla; a ≤340 px se ocultan el nombre de área y « PLUGIN»). Modelos
  reordenado y luego compactado a UNA línea (commit `a2af1f9`, esquema del usuario): dos botones
  arriba y fila ACTUAL `[etiqueta][nombre][recientes][buscar]`; RECIENTES y BUSCADOR ya no son
  `<details>`: desplegables ABSOLUTOS bajo la fila, excluyentes, que cierran con clic fuera /
  Escape / elegir (mandan la misma acción al host). El de recientes solo lista los 5 (sin
  título; oculto en el modo agrupado de Claude); el del buscador lleva `#search` + `#total`
  fijos arriba (`flex:none`) y `#all`/`#groups` scrollean dentro (`max-height: 45vh`). `#note`
  debajo, solo con texto. Revisión PASS (1ª ronda NEEDS WORK: se cayó la clave `el.recent` y
  el render petaba sin `groups` — opencode/Codex). Falta verlo en VS Code (reempaquetar el
  `.vsix` para ello).
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
- `main` = `origin/main` en `e2dffb5` (commiteado y empujado por orden de la persona: plugins
  autodescubiertos + los cambios pendientes de otros encargos). Sin commitear ahora:
  el reordenado del Explorador (`media/explorer.*`) y este fichero.
- Cambios locales de la persona sin commitear: `AGENTS.md` (nota sobre idea.md) e
  `idea.md` (esquemas nuevos al final). No commitearlos salvo orden.

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
- El bloque MODELOS es vista propia (`opencodeAgents.models`, `src/panels/modelsPanel.ts` +
  `media/models.*`), entre Explorador y Contexto. Orden (2026-10-25): los dos botones, ACTUAL,
  RECIENTES y BUSCADOR como `<details>` plegables (dentro del segundo: input, `#all` o
  `#groups` en Claude, y `#total`). Guarda los 5 últimos elegidos en
  `opencodeAgents.recentModels` (`globalState`).
- Modelo ACTUAL del bloque (2026-10-26): el **efectivo**, no el de la sesión — `model:` del
  `.md` del agente de la sesión viva (project > global, sin `#variant`) y, si el agente no fija,
  `session.model`; el origen se dice en `note`. Elegir un modelo hace `POST /api/session/<id>/model`
  **y**, si ese agente fija `model:` en su `.md`, reescribe también el `.md` con `setAgentModel`
  (decisión de la persona: prefiere que el TUI lo aplique de verdad a que respete la asignación;
  con los agentes que no fijan modelo solo se toca la sesión, sin crear la clave).
- Trampa medida en opencode v2.1.4: `POST /api/session/<id>/agent` (lo que hace Shift+Tab) cambia
  `agent` en API y BD pero **no toca `model`**, y el `.md` del agente no se escribe: por eso leer
  `session_v2.model` no sigue al TUI. La BD coincide con la API (comprobado en 300 sesiones), así
  que el retraso no era de la BD. `keyOf()` lleva `id`, `agent` y `model` de esa sesión.
- La sesión viva la elige `pickSession()` por `max(time_viewed, time_updated)` de las raíces del
  proyecto (`time_viewed` existe en `session_v2`; en el esquema v1 vale 0): con dos terminales
  abiertas gana la que el usuario tiene delante, antes se fallaba y el POST se iba a otra sesión.
- La lista del bloque sale de `GET /api/model` (688 aquí), no del catálogo models.dev:
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
- El selector es el **proveedor activo**: Explorador, Modelos y Contexto leen y escriben
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
- Modelos: opencode mantiene `GET /api/model` y cambia la sesión viva por API. Claude no
  tiene catálogo local: el panel pinta los alias oficiales con su mapeo, los modelos del
  endpoint configurado (`GET <base>/v1/models` o `GET <origin>/models`, caché 5 min, solo
  https, token nunca guardado) y los vistos en los 5 `.jsonl` más recientes; Codex usa
  `~/.codex/models_cache.json`. En los dos, cambiar escribe `model` en su config y **no**
  toca la sesión viva (en el TUI, `/model`). El chip SUBAGENTES escribe
  `env.CLAUDE_CODE_SUBAGENT_MODEL`; «SIN FIJAR» borra lo del fichero y el entorno del
  sistema puede seguir mandando (la nota del panel lo dice).
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
  desde el botón de la vista Modelos (`opencodeAgents.assignModels`). Conectar escribe
  `model:` en el `.md` (no cambia la sesión viva, solo las nuevas). Los integrados sin
  override piden scope y crean el `.md` que los sobrescribe; el prompt integrado se conserva
  (comprobado con `opencode debug agents`). Favoritos en `opencodeAgents.favoriteModels`. El
  tablero se cierra al cambiar a Claude/Codex. Tres columnas, `media/assign.html` como
  plantilla con marcadores. El buscador y los conectores apagados persisten en
  `assignSearch`/`assignProvidersOff` (debounce de 300 ms en el webview). Clic en un agente
  o en un favorito resalta el cable que los conecta (`hot`/`sel`, estado solo visual del
  webview; otro clic deselecciona).
- Conectores de opencode: pestaña central (`ConnectorsPanel` + `media/connectors.*`) abierta
  con el botón CONECTORES de Modelos, visible solo con opencode. La izquierda une
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

- VS Code carga la extensión **instalada** (`%USERPROFILE%\.vscode\extensions\…`), no el repo:
  un cambio en `media/*` o `dist/` no se ve hasta reempaquetar el `.vsix`
  (`npx @vscode/vsce package`), reinstalar (`code --install-extension … --force`) y
  recargar la ventana. El usuario probó así un cambio "invisible" por esto.
- Un `.md` de agente con `color:` de nombre (p. ej. `primary`) SÍ se registra en
  opencode v2.1.4, pero `opencode debug agents` no conserva el color (el hex `#rrggbb`
  sí). La doc oficial (oct-2026) documenta los nombres de tema; en la práctica actual
  pulsar un chip de tema es un no-op silencioso. Comprobar con `opencode debug agents`.
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
- `openAgentFile` resuelve por nombre+scope, así que el `.md` del global sombreado se abre
  desde su fila.
- Conectores: los formularios con varias condiciones `when` solo usan la primera (hoy no hay
  ninguno con más de una). `minItems`/`maxItems`/`format`/`custom` se mapean y no se aplican.
  Borrar deja a veces `"provider": { }` o `"disabled_providers": []` (válido).
- El alta real de clave/OAuth no se ha probado contra la API (crea credenciales): se probaron
  los formularios y las rutas con mocks y lecturas reales. El panel tampoco se ha abierto en
  VS Code, solo en Chromium con datos vivos.
- `opencode api ... -d` lleva la clave en los argumentos del proceso: visible un instante en
  la lista de procesos del sistema.
