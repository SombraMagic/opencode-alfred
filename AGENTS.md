# AGENTS.md

## Qué es

Extensión de VS Code `opencode-alfred` ("OpenCode Alfred"): fusión de dos extensiones
propias — `opencode-agents-editor` (GUI de agentes/MCP/skills/plugins de opencode,
estadísticas de solo lectura y ventana de contexto) y `voz` (texto a voz con
ecualizador esférico y dictado). Un solo paquete, sin monorepo. Entrada:
`src/extension.ts`; esbuild lo empaqueta en `dist/extension.js` (el `main`).

## Comandos

- `npm install`
- `npm run compile` — bundle de esbuild a `dist/extension.js`. Hace falta antes de F5 o de empaquetar.
- `npm run watch` — esbuild en watch.
- `npm run package` — bundle de producción (también lo lanza `vscode:prepublish`).
- `npm run typecheck` — `tsc --noEmit`. esbuild NO typechequea: ejecútalo aparte.
- F5 lanza "Run Extension" (`.vscode/launch.json`), preLaunchTask `npm: compile`.
- Empaquetar: `npx @vscode/vsce package`.

No hay tests, linter, formatter ni CI. No inventes comandos para ello.

## Build

- esbuild (no `tsc`) produce el build; `tsconfig.json` solo sirve para `typecheck`.
- Externos en esbuild: `vscode`, `node:sqlite`, `koffi`, `mpg123-decoder`, `ws`. Los tres
  últimos son nativos/WASM y se resuelven en runtime desde `node_modules` (van en
  `dependencies` para que `vsce` los empaquete).
- `node:sqlite` se carga con `require("node:sqlite")` en `src/stats/opencodeStats.ts`;
  las estadísticas degradan con elegancia si el Node del host es viejo (necesita 22.5+/24).
- `dist/` está gitignorado pero viaja en el `.vsix` (`!dist/**` en `.vscodeignore`).
  Recompila antes de empaquetar.
- `media/*.js` y `media/*.css` son assets escritos a mano que el webview carga por URI:
  no pasan por el bundle. Tocar la UI de un panel es tocar el HTML del panel en
  `src/panels/*.ts` **y** el `media/*` correspondiente.
- `resources/stt-sapi.ps1` es el puente con el reconocedor de Windows (dictado SAPI).
  Viaja en el `.vsix`; `src/voice/stt.ts` lo lanza por ruta.

## Arquitectura (`src/`)

- `agents/` — núcleo de dominio: `types.ts` (modelo de agente, listas de tools/permisos),
  `parser.ts` (markdown + frontmatter YAML), `store.ts` (CRUD, escrituras atómicas),
  `paths.ts` (scopes y rutas XDG), `config.ts` (registro de modelos), `connectors.ts`
  (integraciones de opencode, catálogo models.dev, políticas y alta de conectores),
  `catalog.ts` (descubrimiento y activado/desactivado de MCP, skills y plugins), `validate.ts`.
- `stats/` — lee las bases SQLite de opencode en solo lectura: `baseline.ts` (deltas de
  reinicio), `format.ts`, `contextWindow.ts` (desglose de la ventana de contexto),
  `opencodeStats.ts` (actividad por agente y sesiones).
- `voice/core/` — portado de `voz-core`: motores TTS (`sapi`, `edge`, `openai`,
  `elevenlabs`), PCM/envolvente, reproductor por dispositivo, grabadora, filtro de ruido
  y estado compartido con el MCP. Se importa de forma estática; esbuild lo incluye.
- `voice/` — `stt.ts` (dentro: puente SAPI, Whisper local bajo demanda, nube),
  `mcpInstaller.ts` (instala/actualiza el MCP `voz` en la config de opencode).
- `panels/` — vistas webview: `explorerPanel.ts` (barra lateral izquierda: agentes, MCP,
  skills, plugins), `modelsPanel.ts` (bloque MODELOS: modelo de la sesión viva),
  `contextPanel.ts` (ventana de contexto), `editorPanel.ts` (editor de
  agentes), `assignPanel.ts` (pestaña central de asignación agentes↔modelos),
  `connectorsPanel.ts` (pestaña central de conectores de opencode),
  `statsPanel.ts`, `instructionsPanel.ts` (AGENTS.md global y local),
  `voicePanel.ts` (barra lateral derecha: esfera y ecualizador) y `dictadoPanel.ts` (zona
  inferior). Los tres contenedores conservan su sitio en el manifiesto.
- `extension.ts` — registra comandos, sondeo en vivo, watchers y reparte datos a los paneles.

## Hechos de dominio fáciles de equivocar

- Los ficheros de agente son Markdown con frontmatter YAML; **el cuerpo del fichero ES el
  prompt**. Nunca emitir una clave `prompt:`.
- Rutas: global `~/.config/opencode/agent/<nombre>.md`; proyecto
  `<raíz>/.opencode/agent/<nombre>.md`. Si ya existe un directorio plural `agents/`, se
  prefiere.
- Precedencia: proyecto > global > integrados (`build`, `plan`, `general`, `explore`). Un
  integrado queda "sobrescrito" por un `.md` con su nombre; un global queda "sombreado"
  por un agente de proyecto con su nombre. Los dos casos se muestran.
- El panel de asignación escribe `model:` en el `.md` con `saveAgent` (no toca la sesión
  viva): es lo que opencode aplica al recargar. Conectar un integrado sin override pide
  scope y crea `<nombre>.md` con solo el frontmatter; el prompt integrado se conserva
  (verificado con `opencode debug agents`). Los favoritos viven en
  `opencodeAgents.favoriteModels` (`globalState`); al abrir el tablero se siembran con los
  modelos que ya tienen los agentes, si están en el catálogo vivo. El buscador y los
  conectores apagados también persisten (`assignSearch`, `assignProvidersOff`).
- El botón CONECTORES del bloque MODELOS (solo opencode) abre `ConnectorsPanel` +
  `media/connectors.*`: la izquierda es el catálogo completo (`GET /api/integration` +
  `GET /api/provider` + `GET /api/model` + models.dev), el centro los configurados y la
  derecha los modelos del seleccionado. `configured` = conexiones, `provider`/`providers` en
  config o `activation:"enabled"`. Apagar escribe una política `provider.use` con `deny` en
  el `opencode.json(c)` global (encender añade `allow`; gana la última) y no toca
  credenciales. Eliminar pide confirmación y borra credenciales con
  `DELETE /api/credential/<id>` (nunca la BD), las entradas `provider`/`providers` de todos
  los config y sus reglas exactas; las conexiones `env` no se pueden borrar desde aquí. El
  alta usa `connect/key|external|oauth|command`; la clave no se registra ni se manda al
  webview, y el sondeo OAuth en modo `code` no repinta el campo del código. Nunca enviar
  ids de credencial ni secretos al webview.
- opencode v2 **sí recarga en caliente**: vigila `opencode.json(c)` y `cli.json` y reaplica
  agentes, MCP, skills, plugins y ajustes del TUI al guardar (`/reload` fuerza). Solo los
  flags de arranque (`--auto`) y los procesos ya lanzados necesitan relanzarse. Los
  mensajes de "reinicia opencode" que quedan en el código vienen de la etapa V1.
- Editar `opencode.json` / `.jsonc` con `jsonc-parser` (`modify`/`applyEdits`) conservando
  comentarios; nunca `JSON.parse` + `stringify`. Toda escritura pasa por el helper atómico
  tmp+rename.
- Los MCP viven bajo `mcp` en opencode.json. Dos formas: v1 lista servidores
  (`mcp.<nombre>`, desactiva con `enabled: false`); v2 los anida (`mcp.servers.<nombre>`,
  desactiva con `disabled: true`). v2 no honra `enabled`: escribe `disabled`
  (`usesDisabledFlag` en `src/agents/catalog.ts`).
- Los permisos se parten en tools planas y tools con patrón (`FLAT_PERMISSION_TOOLS` /
  `PATTERN_PERMISSION_TOOLS` en `types.ts`). En los mapas con patrón gana la **última**
  regla que coincide (reglas amplias primero, específicas después).
- Las estadísticas son estrictamente de solo lectura sobre `opencode*.db` en
  `~/.local/share/opencode` (configurable). Nunca escribir en esas bases.
- La vista de contexto mide la última petición del mensaje assistant más reciente
  (`session_message.tokens`: `input + cache.read + cache.write`) y estima las partes fijas
  del prompt desde `instruction_state`/`instruction_blob` (`core/instructions`,
  `core/skill-guidance`, `core/codemode`, ...), chars/4. Los esquemas de MCP/tools no se
  persisten: su bulto cae en "Sin atribuir"; no presentes esos trozos como exactos.
- `/compact` inserta un mensaje `type='compaction'` en `session_message` y desde ahí el
  historial anterior ya no viaja al modelo: la vista solo cuenta los mensajes con `seq`
  posterior y suma el `summary` a la conversación. Si tras compactar aún no hay petición
  medida, el total es una estimación (`estimated`, se pinta con `~`). Sin compactación el
  cálculo es el de siempre.
- El límite de contexto del modelo, por este orden: lo declarado en `opencode.json(c)`
  (`provider.<id>.models.<modelo>.limit.context`, que es lo único que tienen los
  proveedores propios: no están en models.dev), el catálogo vivo de models.dev que opencode
  guarda en su tabla `kv` (`models-dev:catalog`, el JSON en `body`) y, al final,
  `~/.cache/opencode/models.json`, que se queda viejo. `collect()` mete el mtime de esos
  ficheros en la clave de caché para que cambiar el límite repinte sin esperar actividad.
- Cambiar el modelo de la sesión en marcha (vista `opencodeAgents.models`) se hace con
  `opencode api POST /api/session/<id>/model` y cuerpo
  `{"model":{"id":"<modelo>","providerID":"<conector>"}}` (`Model.Ref`). El `model` de
  `opencode.json` solo es el modelo por defecto de las sesiones nuevas: no cambia la viva.
  El CLI descubre él solo la URL y la auth del servidor en segundo plano (`service.json`).
  Ese endpoint no valida nada: escribir un `providerID` inventado deja la sesión rota, así
  que solo se envían ids de la lista viva `GET /api/model` (los que opencode da por
  `enabled`). No uses `readConfigInfo()` para esa lista: incluye modelos vetados o
  deshabilitados (nvidia en lista negra, etc.).
- El botón de sesión del Explorador lanza tres CLIs (`SESSION_AGENTS` en
  `src/extension.ts`): opencode (`-s <id>` o `-c`), Claude Code (`claude --continue`) y
  Codex (`codex resume --last`), una terminal por agente y sin cerrar las demás. La
  detección (`where`/`which`) se hace **una vez, en segundo plano** al activar: no metas un
  `await` en la prosa síncrona de `activate` ni esperes ahí, porque `refresh()` corre en
  cuanto el webview dice `ready` y `display`/`agentList` aún no existirían (TDZ). El
  elegido vive en `opencodeAgents.sessionAgent`; `runningTerminal` casa por nombre exacto
  de terminal, así que adopta también la abierta a mano. Es el **proveedor activo**:
  Explorador, Modelos y Contexto salen de `src/providers/claude.ts`, `codex.ts` y
  `toml.ts` (TOML quirúrgico, no parser completo). Claude no deja apagar skills (van con
  `toggleable: false`) y Codex tampoco las suyas. Los MCP de Claude se leen de tres
  sitios: usuario (`~/.claude.json` raíz `mcpServers`), locales del proyecto
  (`projects[<ruta>].mcpServers`) y compartidos (`<raíz>/.mcp.json`); la lista
  `projects[<ruta>].disabledMcpServers` marca los desactivados en ese proyecto. Las
  claves de `projects` pueden repetir la carpeta cambiando la caja de la unidad: se casan
  con `isSamePath` y sus datos se unen. El interruptor de las filas de usuario y locales
  no escribe `~/.claude.json`: inyecta `/mcp disable|enable <servidor>` en la terminal viva
  (`claudeTerminal()`, con el mismo guard de diálogo abierto que los permisos) y el CLI lo
  persiste por proyecto; sin terminal se avisa. Los `.mcp.json` siguen por
  `disabledMcpjsonServers` en `.claude/settings.local.json`. Modelos y Contexto de Claude/Codex no
  cambian la sesión viva: escriben su `model` en la config y miden sus ficheros de
  sesión. En Claude el modelo efectivo es `ANTHROPIC_MODEL` (entorno o `env` de
  settings.json) y tapa a `settings.model`; al cambiar de modelo se escribe también
  `env.ANTHROPIC_MODEL` si estaba puesta (el `env` del fichero gana al del sistema).
  El panel de Modelos de Claude tiene tres grupos: alias oficiales (`fable`, `opus`,
  `sonnet`, `haiku`, `opusplan`, con el mapeo `ANTHROPIC_DEFAULT_*_MODEL` como pista), los
  modelos que publica `GET <base>/v1/models` o `GET <origin>/models` del endpoint
  configurado (caché de 5 min, timeout 4 s, solo https, sin guardar ni loguear el token) y
  los vistos en las sesiones. Los chips PRINCIPAL/SUBAGENTES cambian a qué modelo se
  aplica el clic; `CLAUDE_CODE_SUBAGENT_MODEL` se escribe en `env` y «SIN FIJAR» borra lo
  del fichero (el entorno del sistema puede seguir mandando: la nota lo dice).
  Auto-aceptar escribe `permissions.defaultMode: "auto"` y, al apagarlo,
  `"default"` (manual): desde 2.1.283 el CLI arranca en `auto` por su cuenta, así que
  borrar la clave no lo apagaría. `acceptEdits` solo acepta ediciones y no es el modo
  automático. En settings el valor es `default`; `manual` es el alias del flag. El modo
  se fija al arrancar y no hay API para cambiarlo: al alternarlo se inyecta Shift+Tab
  (`\x1b[Z`) en la terminal viva, que es el ciclo del propio CLI
  (`auto → default → acceptEdits → plan → auto`). Con un diálogo abierto
  (`status: "waiting"` en el registro de sesiones) no se inyecta: ahí Shift+Tab cicla
  las opciones del diálogo, no el modo. La actividad en vivo sale del mismo registro:
  `status` `busy`/`waiting` marca la sesión principal como `CLAUDE`, y cada
  `<sesión>/subagents/agent-*.meta.json` sin `finished` es un subagente en marcha (el CLI
  escribe el meta al lanzarlo y lo completa al acabar); `streaming` = su `.jsonl` tocado
  en los últimos 3 s. Alimenta las filas del Explorador, el contador del HUD y las
  tarjetas del panel de voz. Claude no publica agentes integrados, así que el Explorador
  pinta siempre una única fila INTEGRADOS llamada `CLAUDE` (la sesión principal); al
  pulsarla se abre el fichero de instrucciones que Claude carga (CLAUDE.md del proyecto,
  AGENTS.md si no hay, o el global sin proyecto; si no existe ninguno ofrece crear
  `CLAUDE.md` en vez de escribirlo en silencio).
- El editor de subagentes de Claude (`ClaudeAgentPanel` + `media/claudeAgent.*`) es propio:
  `EditorPanel` es de opencode (permisos por patrón, `variant`, `temperature`). Gestiona
  `name`/`description`, `tools` (omitir = hereda todas), `model` (alias, `inherit` o id),
  `color` (solo nombres: `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`,
  `cyan`), `permissionMode`, `effort`, `maxTurns`, `skills`, `memory`, `isolation`,
  `background` y `omitClaudeMd`. `hooks`, `mcpServers`, `disallowedTools` y demás claves
  no gestionadas se conservan al guardar. El nombre acepta `[a-z0-9._-]`; la descripción es
  obligatoria (sin ella Claude omite el agente). Crear puede ser en `~/.claude/agents` o
  `.claude/agents`, y editar permite renombrar o mover de scope. El aviso de reiniciar
  Claude solo sale si la carpeta `agents` del destino es nueva; si ya existía, Claude
  recarga solo.
- opencode migró su esquema: builds actuales usan `session_v2` + `session_message`
  (mensajes en JSON en `data`, `type` = `assistant`/`user`/`idle`/...; las tool calls van
  dentro del `content[]` del assistant, `state.status` = `running`/`pending`/`completed`/
  `error`). Builds viejos usaban `session` + `message` + `part`. `scanV2`/`scanV1`
  prefieren v2. "Trabajando" = mensaje assistant sin `time.completed` (sigue en streaming)
  o una tool en `running`/`pending`, dentro de las ventanas de recencia. Una base puede
  tener los dos juegos de tablas: no se unen (se cuenta doble), se elige uno.
- Voz: el MCP corre en otro proceso y solo ve los ajustes si la extensión los copia a
  `%APPDATA%\voz\config.json` (`syncSharedConfig`). Cada reproducción se publica en
  `now.json` (misma carpeta): el panel la vigila para ecualizar también lo que dice el MCP.
- Voz: `voice/core` es ESM en su origen; aquí se compila como CJS (requisito de VS Code) y
  se importa de forma estática. No metas `import()` dinámico de `@sombra/voz-core`: ese
  paquete ya no es dependencia.
- Voz: INSTALAR MCP del panel deja elegir opencode, Claude Code, Claude Desktop, Cursor o
  «Otro agente». En Claude Code usa su CLI (`claude mcp add --scope user voz -- <node>
  <voz-mcp>`), quitando antes la entrada para que reinstalar no falle, y confirma con
  `claude mcp get voz`; `~/.claude.json` no se escribe a mano porque guarda credenciales.
- Voz: el panel de dictado tiene tres columnas en este orden: bloc de notas, configuración
  (plegable) y controles. Plegar la configuración deja una tira de 28 px y el ancho lo gana
  el bloc; el estado vive en `globalState` (`voz.dictado.configCollapsed`), así que se
  recuerda entre sesiones. Los valores de configuración son settings globales
  `voz.dictado.*` y la clave API va a `secrets`.
- Voz: el bloc del panel de dictado es `contenteditable` para pegar imágenes y soltar
  ficheros. Se guardan en `<raíz>/.alfred/adjuntos` (o en `globalStorageUri/adjuntos` sin
  carpeta, y los dos valen al leer) con tope de 20 MiB; las imágenes pegadas usan
  `img-*.(png|jpg|gif|webp)` y los ficheros soltados desde el sistema se copian como
  `file-*.<ext>` (los arrastrados desde el Explorador conservan su ruta original). El texto
  del bloc viaja como `[[img:ruta]]` y `[[file:ruta]]` con la ruta escapada; al enviar,
  `[[file:…]]` se convierte en `[fichero: "ruta"]`. `serialize()` tiene que entender `BR`
  **y** los `<div>`/`<p>` que Chromium mete al pegar texto: si no, funde las líneas. Soltar
  ficheros en una webview exige **Mayús** (sin él VS Code intercepta el gesto); por eso el
  pie del bloc tiene ADJUNTAR, que pide los ficheros con `showOpenDialog` y los adjunta por
  ruta.

## Convenciones

- Los textos de UI, mensajes y comentarios van en **español**.
- Ajustes: `opencodeAgents.*` y `voz.*` conservan el namespace de las dos extensiones.
- La UI de los paneles se reparte siempre entre `src/panels/*.ts` y `media/*`; las dos
  mitades van en la misma mano.
- En el HUD, `--text-dim` es **solo** para estado apagado (`:disabled`, `.off`, placeholder,
  `—`): los rótulos y botones normales van en `--text` y lo secundario en un intermedio
  `--text-soft` definido en el CSS de cada panel (no en `tokens.css`). El cian `--neon` de los
  rótulos de grupo no es un color apagado: se conserva.
- Identificadores de vista: `opencodeAgents.view`, `opencodeAgents.models`,
  `opencodeAgents.context`, `voz.panel`, `voz.dictado`. Comandos: prefijos
  `opencodeAgents.` y `voz.`.

## No es guía

- `idea.md` es la petición original, notas agregadas,apuntes, no guía del proyecto.
