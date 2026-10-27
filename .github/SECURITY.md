# Seguridad

Si encuentras un fallo, **no abras un issue público**. Escríbeme a
**sombrawandax@gmail.com** con los pasos para reproducirlo y la versión de la extensión.

Respondo en unos días. Si quieres, te doy crédito en la nota de la versión.

## Qué es sensible

La extensión no guarda credenciales por su cuenta: las claves de los motores de voz y de
los proveedores viven en `secrets` de VS Code y en la configuración de opencode. Lo que sí
maneja son rutas y ficheros de configuración locales (`opencode.json(c)`, `AGENTS.md`,
`~/.claude/agents`, `config.toml`).

## Alcance

- Versión soportada: la última publicada en `Instalable/` y en Releases.
- Fuera de alcance: fallos del propio opencode, Claude Code, Codex o de los servicios de
  voz de terceros.
