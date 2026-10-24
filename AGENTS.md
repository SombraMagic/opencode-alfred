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
  `paths.ts` (scopes y rutas XDG), `config.ts` (registro de modelos), `catalog.ts`
  (descubrimiento y activado/desactivado de MCP, skills y plugins), `validate.ts`.
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
  agentes), `statsPanel.ts`, `instructionsPanel.ts` (AGENTS.md global y local),
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
- El límite de contexto del modelo sale del catálogo vivo de models.dev que opencode
  guarda en su tabla `kv` (`models-dev:catalog`, el JSON en `body`). `~/.cache/opencode/
  models.json` se queda viejo: solo es respaldo.
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
  `toml.ts` (TOML quirúrgico, no parser completo). Claude no deja apagar skills ni MCP
  globales (`~/.claude.json` guarda credenciales: solo lectura) y Codex tampoco sus
  skills: esas filas van con `toggleable: false`. Modelos y Contexto de Claude/Codex no
  cambian la sesión viva: escriben su `model` en la config y miden sus ficheros de
  sesión. En Claude el modelo efectivo es `ANTHROPIC_MODEL` (entorno o `env` de
  settings.json) y tapa a `settings.model`; el catálogo sale de ahí, del `modelPicker` y
  de las sesiones, y al cambiar de modelo se escribe también `env.ANTHROPIC_MODEL` si
  estaba puesta. Auto-aceptar escribe `permissions.defaultMode: "auto"` y, al apagarlo,
  `"default"` (manual): desde 2.1.283 el CLI arranca en `auto` por su cuenta, así que
  borrar la clave no lo apagaría. `acceptEdits` solo acepta ediciones y no es el modo
  automático. En settings el valor es `default`; `manual` es el alias del flag. El modo
  se fija al arrancar y no hay API para cambiarlo: al alternarlo se inyecta Shift+Tab
  (`\x1b[Z`) en la terminal viva, que es el ciclo del propio CLI
  (`auto → default → acceptEdits → plan → auto`). Con un diálogo abierto
  (`status: "waiting"` en el registro de sesiones) no se inyecta: ahí Shift+Tab cicla
  las opciones del diálogo, no el modo. La actividad en vivo sale del mismo registro:
  `status` `busy`/`waiting` marca la sesión principal como `claude`, y cada
  `<sesión>/subagents/agent-*.meta.json` sin `finished` es un subagente en marcha (el CLI
  escribe el meta al lanzarlo y lo completa al acabar); `streaming` = su `.jsonl` tocado
  en los últimos 3 s. Alimenta las filas del Explorador, el contador del HUD y las
  tarjetas del panel de voz.
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

## Convenciones

- Los textos de UI, mensajes y comentarios van en **español**.
- Ajustes: `opencodeAgents.*` y `voz.*` conservan el namespace de las dos extensiones.
- La UI de los paneles se reparte siempre entre `src/panels/*.ts` y `media/*`; las dos
  mitades van en la misma mano.
- Identificadores de vista: `opencodeAgents.view`, `opencodeAgents.models`,
  `opencodeAgents.context`, `voz.panel`, `voz.dictado`. Comandos: prefijos
  `opencodeAgents.` y `voz.`.

## No es guía

- `idea.md` es la petición original, no guía del proyecto.
