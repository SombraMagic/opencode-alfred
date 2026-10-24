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
- El botón COMPACTAR de la vista lanza `POST /api/session/<id>/compact` (sin cuerpo) sobre
  **la sesión que el panel está midiendo** (`contextView.currentSessionId()`), no sobre una
  re-elegida: `pickSession` solo acepta sesiones del proyecto abierto y el panel cae a la
  raíz más reciente de cualquier proyecto, así que re-elegir compactaba otra cosa.
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
