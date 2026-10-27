# Desarrollo

## Requisitos

- Node.js 20 o superior (el host de VS Code necesita 22.5+ para las estadísticas en
  vivo; con menos, esas vistas se degradan solas).
- VS Code 1.90 o superior.
- Git.

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
│  │  ├─ voice/              motores de voz y dictado, MCP
│  │  └─ extension.ts        comandos, sondeo en vivo y reparto a los paneles
│  ├─ media/                 JS, CSS y SVG de las webviews (a mano, sin bundler)
│  ├─ resources/             scripts que la extensión lanza (voz, dictado, pizarra)
│  ├─ dist/                  bundle generado por esbuild (gitignorado, viaja en el .vsix)
│  ├─ package.json           manifiesto de la extensión
│  ├─ esbuild.js             build
│  └─ tsconfig.json          solo para el typecheck
├─ Documentacion/            documentos del proyecto
└─ Instalable/               readme de instalación y el .vsix publicado
```

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
