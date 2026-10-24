# opencode Agents Editor

Extensión de VS Code para **crear, editar y gestionar agentes y subagentes de
[opencode](https://opencode.ai)** a nivel **usuario (global)** y a nivel
**proyecto**, desde una interfaz con formulario en lugar de editar YAML a mano.

## Características

- **Árbol lateral** con tres grupos: `Proyecto`, `Usuario` e `Integrados`
  (build, plan, general, explore).
- **Formulario completo**: nombre, `description`, `mode` (primary / subagent /
  all), `model` (con autocompletado que combina los modelos declarados en tus
  `opencode.json`, los proveedores autenticados en `auth.json` y el registro
  `models.dev` que cachea opencode — así aparecen DeepSeek, GitHub Copilot,
  etc.), `variant`, `temperature`, `top_p`, `steps`, `color` (con selector de
  color; el icono del agente en el árbol se pinta con él),
  `hidden`, `disable` y el **prompt**.
- **Editor de permisos** por herramienta y por patrón (`allow` / `ask` /
  `deny`), con vista previa del YAML resultante.
- **Validación** en vivo (nombre, `mode`, `model`, rangos de `temperature`,
  `top_p`, `steps`, formato de `permission`, campos desconocidos…).
- **CRUD**: crear, editar, duplicar (entre scopes), renombrar y eliminar.
- **Overrides de integrados**: crea un `build.md`, etc. para sobreescribir un
  agente integrado.
- **Skills y MCP en el árbol**: lista las skills y los servidores MCP globales y
  de proyecto, con una casilla para **activar/desactivar** cada uno.
- Detecta **shadowing**: un agente de proyecto con el mismo nombre que uno de
  usuario se marca como sombreado (gana el de proyecto, por el _deep-merge_ de
  opencode).
- Guardado **atómico** de los `.md`.

## Dónde escribe

| Scope   | Ruta                                                     |
| ------- | -------------------------------------------------------- |
| Usuario | `~/.config/opencode/agent/<nombre>.md`                   |
| Proyecto| `<proyecto>/.opencode/agent/<nombre>.md`                 |

(opencode también acepta la carpeta en plural `agents/`; la extensión usa la que
ya exista y, si no existe, crea `agent/`.)

El formato es Markdown con **frontmatter YAML**; el **cuerpo del fichero es el
`prompt`**. No se escribe `prompt:` en el frontmatter.

## Uso

1. Pulsa el icono **opencode Agents** en la barra de actividad.
2. Usa los botones de la cabecera para **+ agente (primary)** o **+ subagente**,
   o el menú contextual de cada nodo para editar / duplicar / renombrar /
   eliminar.
3. En el formulario, guarda con el botón **Guardar** o `Ctrl/Cmd + S`.

> opencode **no recarga en caliente** la configuración: tras guardar, **reinicia
> opencode** para que los cambios surtan efecto.

## Estadísticas de agentes (en vivo)

La extensión lee las **bases de datos de opencode** (SQLite, solo lectura: no
escribe nada) para mostrar, por agente, en el **árbol** y en un **panel**
dedicado (`opencode: Ver estadísticas de agentes`):

- **Qué agente está trabajando ahora mismo**: el nodo del agente gira
  (icono `sync~spin`) y muestra la etiqueta `working`. Aparece también un grupo
  **⟳ Trabajando ahora** al principio del árbol. Se detecta a partir de las
  partes de herramienta en estado `running`/`pending` y de mensajes del
  asistente sin terminar.
- **Tokens** (entrada, salida, razonamiento y caché lectura/escritura),
  **coste**, **tiempo de trabajo** (suma de las duraciones de generación),
  número de **sesiones** y **mensajes**, y **última actividad**.
- **Subtotales** por scope (Proyecto / Usuario / Integrados).

En el panel puedes ordenar por cualquier columna, filtrar por agente y:

- **Reiniciar**: guarda un *punto de partida* por agente; el contador vuelve a
  `0` y sigue sumando a partir de ahí.
- **Ver histórico**: borra ese punto de partida y muestra el total completo.
- **Reiniciar todo** / **Ver histórico** (global) para todos los agentes.

Todo se guarda en el `globalState` de la extensión, así que reiniciar es
persistente entre sesiones de VS Code.

## Skills y MCP

El árbol incluye dos secciones nuevas, con las de **nivel global (usuario)** y de
**proyecto**, y cada elemento tiene una **casilla para activar/desactivar**:

- **MCP**: lee los servidores de `opencode.json`/`.jsonc` (global y de proyecto).
  Acepta las dos formas (`mcp.<nombre>` y `mcp.servers.<nombre>`). Activar/
  desactivar escribe `enabled: true/false` en el fichero donde está definido el
  servidor. Clic en el elemento abre ese fichero.
- **Skills**: descubre `SKILL.md` en `~/.config/opencode/skills`,
  `~/.claude/skills`, `~/.agents/skills` y sus equivalentes del proyecto
  (subiendo hasta la raíz del repo), además de las rutas de `skills.paths` y de
  las que traen los **plugins** del caché de opencode. Activar/desactivar escribe
  `permission.skill.<nombre>` (`allow`/`deny`) en el config del scope
  correspondiente. Clic en el elemento abre el `SKILL.md`.

Las ediciones preservan comentarios y formato (se hacen con `jsonc-parser`). Tras
cambiar algo, **reinicia opencode** para que surta efecto.

## Ajustes

- `opencodeAgents.globalConfigDir`: ruta al directorio global de opencode
  (por defecto `~/.config/opencode`).
- `opencodeAgents.defaultModel`: modelo con el que se pre-rellenan los agentes
  nuevos (`provider/model-id`).
- `opencodeAgents.showBuiltins`: mostrar/ocultar los integrados.
- `opencodeAgents.schemaUrl`: URL del JSON Schema de referencia.
- `opencodeAgents.dataDir`: directorio de datos de opencode donde están
  `opencode.db` / `opencode-dev.db` (por defecto `~/.local/share/opencode`).
- `opencodeAgents.watchLive`: activar el seguimiento en vivo (por defecto `true`).
- `opencodeAgents.liveIntervalMs`: intervalo de sondeo en ms (por defecto `2000`).
- `opencodeAgents.modelsCachePath`: ruta al registro de modelos de opencode
  (por defecto `~/.cache/opencode/models.json`).
- `opencodeAgents.showAllProviders`: incluir también el resto de proveedores del
  registro `models.dev` en el selector de modelos (por defecto `false`: solo los
  configurados en `opencode.json` y los autenticados en `auth.json`). El selector
  es buscable y muestra los configurados primero.

## Desarrollo

```bash
npm install
npm run compile     # build único
npm run watch       # build continuo
npm run typecheck   # tsc --noEmit
```

Pulsa `F5` en VS Code (configuración **Run Extension** de `.vscode/launch.json`)
para abrir una ventana *Extension Development Host*.

## Empaquetar

```bash
npx @vscode/vsce package
```

Genera un `.vsix` instalable con `code --install-extension opencode-agents-editor-*.vsix`.

## Instalación desde el .vsix (para pruebas)

Consigue el fichero `opencode-agents-editor-0.1.2.vsix` e instálalo de una de estas dos formas:

- En VS Code, abre el panel **Extensiones** → menú `...` → **Install from VSIX...** y elige el fichero.
- O desde una terminal: `code --install-extension opencode-agents-editor-0.1.2.vsix`.

Después **recarga la ventana** de VS Code (paleta de comandos → *Developer: Reload Window*).

Requisitos: tener **opencode** instalado. Las estadísticas en vivo necesitan un VS Code con Node 22.5+; en hosts más antiguos la extensión funciona igual, pero las estadísticas degradan solas sin romper nada.


