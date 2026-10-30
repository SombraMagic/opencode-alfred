# OpenCode Alfred

**Tu centro de control de agentes de IA, dentro de VS Code.**
Gestiona opencode, Claude Code y Codex desde un mismo panel: agentes, MCP, skills,
plugins, contexto, consumo… y háblale al ordenador, o dítale lo que quieres pedir.

Sin editar YAML a mano. Sin cambiar de ventana.

> **opencode es el centro.** La extensión está pensada y orientada a opencode: ahí funciona
> todo. Claude Code y Codex son **experimentales**: se pueden explorar y manejar en parte,
> pero su soporte todavía no funciona del todo bien y puede cambiar.

---

## Manifiesto

Desde siempre he sido un apasionado de los IDE. Todavía echo de menos a Delphi, aunque está
claro que los tiempos han cambiado: ahora lo llaman *vibe coding*, el código abierto empieza
a imponerse al cerrado, los IDE parecen estar perdiendo su sentido y, para colmo, cada vez
cuesta más encontrar juegos en formato físico.

A veces me siento como un viejo sentado en una hamaca, mirando al horizonte y criticando a
la juventud XD.

Pero uno no abandona sus costumbres tan fácilmente.

Aquí os dejo mi herramienta de trabajo habitual. La he bautizado como **Alfred**. (Taii sabe
por qué.)

Quizá los tiempos cambien, las herramientas evolucionen y la forma de programar sea otra,
pero siempre quedará ese pequeño placer de tener tu propio entorno de trabajo, a tu manera.

Bienvenidos a Alfred.

---

## Qué hace

- **Agentes con formulario.** Crea, edita, duplica y borra agentes y subagentes de
  opencode (global o proyecto) sin tocar frontmatter. Permisos por herramienta y por
  patrón, con vista previa del YAML.
- **Un explorador para tres CLIs.** opencode, Claude Code y Codex en la misma barra:
  agentes, MCP, skills y plugins de cada uno, con interruptores para activar y
  desactivar. Y una terminal por agente, con la sesión que toca.
- **Contexto bajo control.** Cuánto has gastado de la ventana del modelo, qué parte es
  prompt fijo, y un botón para compactar antes de que reviente.
- **Estadísticas de verdad.** Tokens, coste, tiempo y sesiones por agente, leídos en
  solo lectura de la base de opencode. Y una línea de tiempo por prompt, con sus
  subagentes en paralelo.
- **Consumo de proveedores.** Saldo y topes de DeepSeek, OpenAI, GitHub Copilot y
  OpenCode Go, sin salir del editor.
- **Voz.** Lee en voz alta lo que selecciones y dicta en un bloc con adjuntos,
  imágenes, pegar y arrastrar. Cuatro motores de voz y tres de dictado; funciona sin
  conexión con lo que ya trae Windows.
- **Mente local.** El cerebro Ollama, en su pestaña: instalar o desinstalar con `winget`,
  modelos con su tamaño y el espacio del disco, descargar, borrar y encender o apagar. Al
  encender, Ollama aparece en los conectores y en la asignación de modelos de opencode.
- **Pizarra.** Dibuja, pega imágenes y mándalo al prompt como si fuera un adjunto. Tiene una
  capa de diagrama para dibujar workflows con nodos y conectores, y exporta el diagrama como
  Mermaid. Varias pizarras en pestañas: la primera es la que ven los agentes.
- **Visor Alfred 3D.** Abre ficheros `.blend` como pestaña de edición: órbita, objetos,
  cámaras, luces, animaciones y render de un frame o de toda la tirada. Con Blender o sin él.

Todo en español, en una sola extensión.

## Qué toca y qué no

Las bases de opencode se abren en **solo lectura**. Todo lo demás se escribe con el
formato que el CLI espera, sin pisar comentarios ni claves que no gestiona la extensión.

| Dónde | Qué hace |
| --- | --- |
| `~/.local/share/opencode/*.db` | Solo lectura: sesiones, mensajes y tokens |
| `~/.cache/opencode/models.json` y el catálogo de models.dev | Solo lectura: límites de contexto y precios |
| `~/.config/opencode/agent/*.md`, `<proyecto>/.opencode/agent/*.md` | Crea y edita agentes y subagentes |
| `opencode.json` / `opencode.jsonc` | MCP, skills, plugins, permisos y políticas de conectores |
| `AGENTS.md` global y de proyecto | Instrucciones |
| `~/.claude/agents`, `.claude/agents`, `.claude/settings.local.json`, `.mcp.json` | Solo si usas Claude Code (experimental) |
| `config.toml` de Codex | Solo si usas Codex (experimental) |
| `%APPDATA%\voz\config.json` | Ajustes de voz para que el MCP los vea |
| `<raíz>/.alfred/adjuntos` | Adjuntos del dictado; sin proyecto, en el almacenamiento global |
| `<almacén global>/alfred3d/` y `<nombre>.glb` junto al `.blend` | Caché del visor 3D y sidecar que se lee cuando no hay Blender; el `.blend` nunca se guarda |

No escribe `~/.claude.json` (las conmutaciones de MCP pasan por el propio CLI) y nunca
manda credenciales al webview: las claves viven en `secrets` de VS Code. Solo sale a la
red si lo pides, al consultar límites de consumo o al elegir un motor de voz o dictado en
la nube.

## Instalación

Descarga el `.vsix` de [`Instalable/`](Instalable/) y sigue la
[guía de instalación](Instalable/README.md). Tarda menos de un minuto y no necesita
compilar nada.

## Documentación

| Documento | Qué cuenta |
| --- | --- |
| [`Documentacion/ESTADO.md`](Documentacion/ESTADO.md) | En qué punto está el proyecto y qué viene después |
| [`Documentacion/DESARROLLO.md`](Documentacion/DESARROLLO.md) | Estructura de carpetas, compilar, depurar y empaquetar |
| [`Codigo_Fuente/README.md`](Codigo_Fuente/README.md) | Guía completa: cada panel, cada ajuste, con detalle |
| [`Codigo_Fuente/CHANGELOG.md`](Codigo_Fuente/CHANGELOG.md) | Qué trajo cada versión publicada |
| [`Instalable/README.md`](Instalable/README.md) | Instalar el `.vsix` paso a paso |

## Requisitos

- VS Code 1.90 o superior.
- [opencode](https://opencode.ai) instalado si quieres usar el centro de control de
  agentes (la voz y el dictado funcionan sin él).
- Windows para la voz y el dictado sin conexión (SAPI). En otros sistemas, los motores
  en la nube y Whisper siguen disponibles.
- [Blender](https://www.blender.org), **opcional**: es el motor de render del visor 3D y
  el que exporta los `.blend`. Sin él abren las escenas ya exportadas y las que traigan su
  `.glb` al lado; ver [requisitos de la guía](Codigo_Fuente/README.md#requisitos).

## Invítame a un café

Si esto te ahorra tiempo, puedes invitarme a un café por PayPal. Se agradece, y se
invierte en seguir puliéndolo.

**PayPal:** [paypal.me/sombrawandax](https://www.paypal.com/paypalme/sombrawandax)

## Licencia

MIT. Haz lo que quieras con ello; solo pido que conserves el aviso de copyright.
Ver [LICENSE](LICENSE).
