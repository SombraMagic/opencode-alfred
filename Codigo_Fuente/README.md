# OpenCode Alfred

Extensión de VS Code que reúne en un solo sitio el control de **opencode**, **Claude Code**
y **Codex**: agentes, MCP, skills, plugins, contexto, consumo, estadísticas, voz y dictado.
El cuerpo de cada fichero de agente es su prompt; la extensión escribe el frontmatter YAML
por ti.

> **opencode es el centro.** La extensión está pensada y orientada a opencode: ahí funciona
> todo. Claude Code y Codex son **experimentales**: su soporte todavía no funciona del todo
> bien y puede cambiar. Cuando el documento dice «los tres CLIs», se refiere a eso.

Antes de instalar, conviene saber dónde escribe: agentes `.md` en
`~/.config/opencode/agent` y `<proyecto>/.opencode/agent`, `opencode.json(c)`,
`AGENTS.md`, los agentes y ajustes de Claude Code, `config.toml` de Codex y el bloc de
adjuntos. Las bases de opencode se abren **en solo lectura** y `~/.claude.json` no se toca
nunca. El detalle está en la tabla del
[README principal](https://github.com/SombraMagic/opencode-alfred#qu%C3%A9-toca-y-qu%C3%A9-no).

## Paneles

### ALFRED — Explorador (barra de actividad)

- **Mando**: `GLOBAL` / `PROYECTO`, el selector del agente de sesión (opencode, Claude o
  Codex), `ACEPTAR TODO` y los botones `CONECTORES`, `ASIGNAR AGENTES` y `PIZARRA`.
- **Explorador**: agentes de proyecto y globales, con su modelo, animación de vuelo cuando
  trabajan y tokens (sesión y total). `VER` abre su formulario.
- **Control**: MCP, skills y plugins de cada proveedor, con interruptor para activar y
  desactivar. Para Claude los MCP de usuario y locales se conmutan inyectando
  `/mcp disable|enable` en la terminal viva; los `.mcp.json` van por
  `disabledMcpjsonServers`.

CLIC en `VER` sobre un integrado con override abre **su `.md`**, no el integrado, así que su
sobrescritura se puede borrar desde el propio formulario.

### Contexto

Una fila con lo gastado y el límite del modelo, el desglose de qué ocupa la ventana
(instrucciones, skills, historial, sin atribuir) y el botón `COMPACTAR`. Mide opencode por
su base SQLite; Claude y Codex por sus ficheros de sesión.

### Límites de consumo

Saldo o topes por proveedor: DeepSeek (saldo), OpenAI (coste del mes), GitHub Copilot
(cuotas del plan) y OpenCode Go (estimación por tokens). Se enciende por proveedor en la
fila de `CONECTORES`; solo sondea con la vista abierta.

### Voz (barra lateral derecha) y Dictado (panel inferior)

- Voz: ecualizador de barras pixeladas y cuatro motores (SAPI de Windows, Edge, OpenAI, ElevenLabs).
  `Ctrl+Alt+V` lee la selección. El ecualizador también reacciona a lo que diga el MCP; el
  servidor MCP de voz viaja dentro del paquete y se registra desde el botón `INSTALAR MCP`.
- Dictado: bloc de notas con adjuntos (imágenes pegadas, ficheros arrastrados o `ADJUNTAR`),
  configuración plegable y tres motores (SAPI, Whisper local, nube compatible con OpenAI).

### Pizarra

Lienzo por capas: fondo (color o imagen), imágenes movibles, trazos con lápiz y goma, y
textos. Zoom con la rueda y paneo con `Espacio` + arrastrar. `SUBIR PIZARRA` la mete en el
bloc del dictado como adjunto.

### Estadísticas de agentes y de prompts

- **Agentes**: tokens (entrada, salida, razonamiento, caché), coste, tiempo de trabajo,
  sesiones y mensajes, con subtotales por scope. `REINICIAR` fija un punto de partida.
- **Prompts**: línea de tiempo por prompt, con cada agente y subagente que intervino, su
  duración, tokens y coste (real o estimado y marcado). Solo opencode, y solo con
  `MONITORIZAR` encendido; el historial se guarda en el almacén global de la extensión.

### Conectores y asignación de modelos

- **Conectores**: catálogo de integraciones, lo ya configurado y sus modelos con precio y
  contexto. Alta por clave, externa, OAuth o comando; apagado por política `provider.use`
  y borrado con confirmación. Los secretos nunca viajan al webview.
- **Asignar agentes**: tablero de tres columnas con cables agente ↔ modelo, grupos de
  favoritos y precios. Conectar escribe `model:` en el `.md` del agente: se aplica a las
  sesiones **nuevas**. Bajo el título hay pestañas de **configuraciones**: cada una guarda
  el mapa completo agente → modelo, y cambiar de pestaña lo vuelca en todos los `.md` (doble
  clic para renombrar, `×` para borrar, `+` para duplicar la activa). El buscador de modelos
  vive en la fila del título MODELOS.

## Los tres proveedores

El selector del mando decide qué config lee y escribe la extensión:

| Proveedor | Agentes | MCP | Skills | Plugins |
| --- | --- | --- | --- | --- |
| opencode | `~/.config/opencode/agent` y `.opencode/agent` | `opencode.json(c)` | sí (conmutables) | sí |
| Claude Code | `~/.claude/agents` y `.claude/agents` | `.mcp.json`, usuario y locales | solo lectura | `enabledPlugins` |
| Codex | `config.toml` | `[mcp_servers.*]` | solo lectura | `[plugins.*]` |

## Dónde escribe

| Qué | Dónde |
| --- | --- |
| Agentes de opencode | `~/.config/opencode/agent/<nombre>.md` y `<proyecto>/.opencode/agent/<nombre>.md` |
| Subagentes de Claude | `~/.claude/agents` y `<proyecto>/.claude/agents` |
| Adjuntos del dictado | `<proyecto>/.alfred/adjuntos` (o el almacén global si no hay carpeta) |

Las bases de datos de opencode se abren **en estricta solo lectura**. Nunca se escribe en
ellas.

## Ajustes

`opencodeAgents.*`: `globalConfigDir`, `defaultModel`, `showBuiltins`, `schemaUrl`,
`dataDir`, `watchLive`, `liveIntervalMs`, `modelsCachePath`, `showAllProviders`,
`limitsProviders`, `goPlan`.

`voz.*`: `engine`, `voice`, `rate`, `pitch`, `volume`, `outputDevice`, y `voz.dictado.*`
(motor, idioma, modelo de Whisper, URL y modelo de la nube, filtro de ruido, umbral y
fondo de ruido).

## Requisitos

VS Code 1.90+ y Node 20+. Las estadísticas en vivo necesitan Node 22.5+ en el host; con
menos, esas vistas se degradan solas. opencode solo es necesario para su parte; la voz y
el dictado funcionan sin él (SAPI sin conexión en Windows).

## Desarrollo

La raíz del paquete es esta carpeta:

```bash
npm install
npm run compile     # build único (esbuild)
npm run watch       # build continuo
npm run typecheck   # tsc --noEmit
npx @vscode/vsce package
```

`F5` lanza *Run Extension* con esta carpeta abierta como espacio de trabajo. VS Code carga
la extensión **instalada**, no el repo: para probar un cambio en tu editor hay que
empaquetar el `.vsix`, instalarlo y recargar la ventana.

## Licencia

MIT. Ver [`LICENSE`](https://github.com/SombraMagic/opencode-alfred/blob/main/LICENSE).
