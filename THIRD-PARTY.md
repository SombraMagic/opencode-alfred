# Aviso de terceros

OpenCode Alfred se distribuye bajo licencia MIT (ver [LICENSE](LICENSE)). Incluye o usa
los siguientes componentes de terceros.

## Dependencias que viajan en el `.vsix`

| Paquete | Versión | Licencia | Para qué |
| --- | --- | --- | --- |
| [js-yaml](https://github.com/nodeca/js-yaml) | 4 | MIT | Leer y escribir el frontmatter YAML de los agentes |
| [jsonc-parser](https://github.com/microsoft/node-jsonc-parser) | 3 | MIT | Editar `opencode.json(c)` conservando comentarios |
| [koffi](https://koffi.dev) | 3 | MIT | Llamar a la voz nativa de Windows desde Node |
| [mpg123-decoder](https://github.com/eshaz/mpg123-decoder) | 1 | MIT | Decodificar audio MP3 |
| [ws](https://github.com/websockets/ws) | 8 | MIT | WebSocket del motor Edge |
| [three](https://threejs.org) | 0.169 | MIT | Visor 3D de ficheros `.blend` |

## Solo en la compilación (no se empaquetan)

| Paquete | Versión | Licencia |
| --- | --- | --- |
| [esbuild](https://esbuild.github.io) | 0.24 | MIT |
| [TypeScript](https://www.typescriptlang.org) | 5.9 | Apache-2.0 |

## Iconos

| Icono | Origen | Licencia |
| --- | --- | --- |
| opencode, Claude | [simple-icons](https://simpleicons.org) | CC0 1.0 |
| Codex | [LobeHub Icons](https://github.com/lobehub/lobe-icons) | MIT |

## No se distribuye con la extensión

[Blender](https://www.blender.org) es un **programa externo** que la extensión invoca por
línea de órdenes para exportar y renderizar los `.blend`. **No se empaqueta ni se
redistribuye**: lo instala el usuario aparte. Blender es GPL; aquí solo se le llama, no se
incluye nada suyo. `resources/alfred3d-export.py` es propio de este proyecto (MIT): se
escribió para este visor y no proviene de Blender ni de terceros.

## Marcas y servicios

Los nombres y logotipos de opencode, Claude Code, Codex, opencode, Microsoft, OpenAI,
ElevenLabs, DeepSeek y Blender pertenecen a sus respectivos dueños. Se usan aquí solo para
identificar cada herramienta.

Los motores de voz y dictado en la nube (Edge, OpenAI, ElevenLabs, Whisper) se consumen a
través de sus servicios, con la clave que ponga el usuario. No se redistribuye ninguna voz,
modelo ni binario de terceros.
