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
- Pendiente: probar en VS Code con la ventana recargada (webviews, TTS y dictado no se han
  visto en ejecución).
- `main` sincronizado con `origin/main` (`757d85f`); sin commits pendientes de subir.

## Decisiones

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
  `media/models.*`), entre Explorador y Contexto, **siempre desplegada**: sin `<details>`,
  el buscador y los tres grupos se ven de entrada. No toca la config: cambia la sesión viva
  con `opencode api` (ver `AGENTS.md`) y guarda los 5 últimos elegidos en
  `opencodeAgents.recentModels` (`globalState`). El modelo en uso sale de la última sesión
  raíz del proyecto en `session_v2`, no del TUI; si se cambia desde el TUI, la vista lo
  sigue porque `keyOf()` incluye id y modelo de esa sesión.
- La lista del bloque sale de `GET /api/model` (688 aquí), no del catálogo models.dev:
  `readConfigInfo` devuelve 822 y cuela vetados (nvidia en `blacklist`) que opencode no
  puede ejecutar. Coste del spawn: ~120 ms; solo en el arranque y al guardar config, nunca
  en el sondeo de 2 s. Cada modelo lleva `free` cuando la tarifa viene a cero en todos los
  tramos (65 de 688); el nombre nunca se usa como pista.
- El botón de sesión del Explorador es un selector de agente (`‹ ▶ OPEN ›`,
  `‹ ▶ CLAUDE ›`, `‹ ▶ CODEX ›`, acción `cycleAgent`): abre una terminal **por agente** y no
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
  `.claude/agents/orquestador.md`: se retiró a propósito. Con CLAUDE seleccionado, LOCAL
  abre `AGENTS.md` y `CLAUDE.md`; GLOBAL sigue abriendo `~/.claude/CLAUDE.md`.
- Las terminales de agente se abren como **pestaña del grupo activo** (`ViewColumn.Active`),
  nunca con `Beside`: se cambia con la pestaña de arriba. `openTerminal` tolera una entrada
  del mapa ya destruida (leer `exitStatus` de una terminal dispose lanza y el clic no hacía
  nada), cierra la pestaña muerta antes de crear y adopta una terminal viva del mismo
  agente. `onDidChangeActiveTerminal` cambia `sessionAgent` y repinta todo: el selector
  sigue a la pestaña, también al cerrar (VS Code activa otra).
- En Claude el Explorador pinta una única fila INTEGRADOS `CLAUDE` (la sesión principal):
  no hay integrados reales y la lista salía vacía. Se marca EN VUELO con el mismo registro
  de sesiones y su clic abre el fichero de instrucciones (`CLAUDE.md`, o `AGENTS.md` si no
  hay), creado vacío si falta.
- Editar o crear un subagente de Claude abre un panel propio (`ClaudeAgentPanel`), no el
  `.md`: identidad, herramientas (omitir = hereda todas), modelo con alias y mapeo, color
  nominal, `permissionMode`/`effort`, avanzado (`maxTurns`, `skills`, `memory`, `isolation`,
  `background`, `omitClaudeMd`) y vista previa del YAML. Las claves no gestionadas
  (`hooks`, `mcpServers`…) se conservan. El nombre solo admite `[a-z0-9._-]`; la
  descripción es obligatoria. Reiniciar Claude solo si la carpeta `agents` del destino no
  existía al arrancar.
- El panel de dictado adjunta imágenes pegadas (Ctrl+V): se escriben en `<raíz>/.alfred/adjuntos`
  (ignorado por `.gitignore` y `.vscodeignore`) o en el almacén global sin carpeta, y el bloc
  `contenteditable` las guarda como `[[img:ruta-escapada]]`. Probado por el usuario en VS Code.
  Pegar **texto** de varias líneas llegaba fundido a ENVIAR porque Chromium lo mete en `<div>`
  y `serialize()` solo entendía `BR`: arreglado y verificado en Chromium headless.
- Asignación agentes↔modelos es pestaña central (`AssignPanel` + `media/assign.*`), abierta
  desde el botón de la vista Modelos (`opencodeAgents.assignModels`). Conectar escribe
  `model:` en el `.md` (no cambia la sesión viva, solo las nuevas). Los integrados sin
  override piden scope y crean el `.md` que los sobrescribe; el prompt integrado se conserva
  (comprobado con `opencode debug agents`). Favoritos en `opencodeAgents.favoriteModels`. El
  tablero se cierra al cambiar a Claude/Codex. Tres columnas, `media/assign.html` como
  plantilla con marcadores. El buscador y los conectores apagados persisten en
  `assignSearch`/`assignProvidersOff` (debounce de 300 ms en el webview).

## Trampas ya pagadas

- Editar la UI de un panel es tocar dos sitios: la cadena HTML del panel en
  `src/panels/*.ts` **y** el `media/*.js`/`*.css` correspondiente.
- `npm run compile` no valida tipos: esbuild no typechequea.
- opencode v2 descarta en silencio un `.md` de agente cuyo `color:` no sea un hex
  `#rrggbb`: con un color con nombre y sin bloque `permission:`, el agente no se
  registra y `subagent` responde "Agent not found". Comprobar con `opencode debug agents`.
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
- `src/agents/validate.ts` acepta colores con nombre; opencode no. El validador es más
  permisivo que el runtime.
- `PATTERN_PERMISSION_TOOLS` en `src/agents/types.ts` dice `bash`; la clave real de
  opencode es `shell`.
- `opencode-dev.db` (esquema v1, grande) no aparece en la vista de contexto: `scan` solo
  lee `session_v2`/`session_message`.
- `README.md` todavía describe solo la extensión de agentes.
- Desde el explorador ya no se renombran agentes ni se abre la config de un MCP/skill
  (antes, desde el árbol). `store.ts` conserva `deleteAgent`/`duplicateAgent` sin UI.
- `openAgentFile` resuelve por nombre+scope, así que el `.md` del global sombreado se abre
  desde su fila.
