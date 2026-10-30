# Desarrollo

## Requisitos

- Node.js 20 o superior (el host de VS Code necesita 22.5+ para las estadísticas en
  vivo; con menos, esas vistas se degradan solas).
- VS Code 1.90 o superior.
- Git.
- **Blender, opcional**: solo lo necesita el Visor Alfred 3D para exportar los `.blend` y
  para renderizar con su motor. Se busca por este orden: el ajuste `opencodeAgents.blenderPath`
  (si apunta a un `.exe` que existe, manda), el `PATH`, `C:\Program Files\Blender Foundation`
  y el registro de Windows; entre los autodetectados gana la versión más alta. Sin Blender
  siguen abriendo las escenas cacheadas y las que traen un `.glb` al lado del `.blend`. Para
  `.blend` de Blender 5.x hace falta 5.2 o más nuevo.

## Estructura

```
/
├─ Codigo_Fuente/            raíz del paquete de la extensión
│  ├─ src/                   TypeScript
│  │  ├─ agents/             modelo, parser, store, rutas, catálogo, validación
│  │  ├─ stats/              lectura en solo lectura de las SQLite de opencode
│  │  ├─ limits/             consumo por proveedor
│  │  ├─ panels/             webviews (el HTML vive en el .ts de cada panel)
│  │  ├─ providers/          lectores de config de Claude Code y Codex
│  │  ├─ blender/            puente con la CLI de Blender: export a GLB y renders
│  │  ├─ pizarra/            escena y ficheros de la pizarra (sin `vscode`)
│  │  ├─ ollama/             mente local: `client`, `process`, `provider` y `service`
│  │  ├─ mcp/                servidor `mcp_alfred` (voz y pizarra) → `dist/alfred-mcp.js`
│  │  ├─ voice/              motores de voz y dictado
│  │  └─ extension.ts        comandos, sondeo en vivo y reparto a los paneles
│  ├─ media/                 JS, CSS y SVG de las webviews (a mano, sin bundler)
│  │  └─ three/              three.js r0.169 vendorizado para el visor 3D (no va por npm)
│  ├─ resources/             scripts que la extensión lanza (voz, dictado, pizarra y el
│  │                         exportador `alfred3d-export.py` del visor 3D)
│  ├─ dist/                  bundle generado por esbuild (gitignorado, viaja en el .vsix)
│  ├─ package.json           manifiesto de la extensión
│  ├─ esbuild.js             build
│  └─ tsconfig.json          solo para el typecheck
├─ Documentacion/            documentos del proyecto
└─ Instalable/               readme de instalación y el .vsix publicado
```

El panel de Mente local es `src/panels/menteLocalPanel.ts` con `media/menteLocal.js` y
`media/menteLocal.css`. En `src/ollama/*` solo `service.ts` importa `vscode` (`client`,
`process` y `provider` no); el alta de `provider.ollama` va al config global con
`jsonc-parser` y `writeAtomic`.

## Comandos

Todos se ejecutan **dentro de `Codigo_Fuente/`**:

```bash
cd Codigo_Fuente
npm install
npm run compile     # build único (esbuild)
npm run watch       # build continuo
npm run typecheck   # tsc --noEmit (esbuild no comprueba tipos)
```

## Depurar

Abre la carpeta **`Codigo_Fuente`** en VS Code y pulsa `F5`: se lanza *Run Extension*
con `preLaunchTask` `npm: compile` y se abre una ventana de desarrollo con la extensión
cargada desde el repo.

VS Code carga la extensión **instalada**, no el repo: para ver un cambio en tu propio
VS Code hay que empaquetar e instalar el `.vsix` (abajo) y recargar la ventana.

## Empaquetar

```bash
cd Codigo_Fuente
npx @vscode/vsce package
```

Genera `Codigo_Fuente/opencode-alfred-<versión>.vsix`. Muévelo a `Instalable/` con ese
mismo nombre y actualiza el número de versión en `Instalable/README.md`. El `.vsix` de
`Instalable/` es el que se descarga desde GitHub.

Instalar el paquete en local:

```bash
code --install-extension Instalable/opencode-alfred-<versión>.vsix --force
```

## Convenciones

- Textos de UI, mensajes y comentarios en **español**.
- Cambio mínimo: nada de abstracciones, opciones ni código «para luego».
- Los ajustes conservan el namespace `opencodeAgents.*` y `voz.*`.
- La UI de un panel vive en dos sitios y se tocan juntos: la cadena HTML del panel en
  `src/panels/*.ts` y su `media/*.js` / `media/*.css`.
- `opencode.json` / `.jsonc` se editan con `jsonc-parser` conservando comentarios, y toda
  escritura es atómica (temporal + renombrar). Nunca `JSON.parse` + `stringify`.
- Las bases de datos de opencode se abren en estricta solo lectura.
- No hay tests, linter, formatter ni CI: la puerta de calidad es `typecheck` + `compile`.
