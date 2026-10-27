# Documentación

Documentos del proyecto OpenCode Alfred.

La extensión está pensada y orientada a **opencode**. Claude Code y Codex son
**experimentales**: su soporte todavía no funciona del todo bien.

| Documento | Contenido |
| --- | --- |
| [ESTADO.md](ESTADO.md) | Estado actual, qué está probado y próximos pasos |
| [DESARROLLO.md](DESARROLLO.md) | Estructura del repositorio, comandos, depuración y empaquetado |
| [../LICENSE](../LICENSE) | Licencia MIT |
| [../Codigo_Fuente/README.md](../Codigo_Fuente/README.md) | Guía de uso completa: paneles y ajustes |
| [../Instalable/README.md](../Instalable/README.md) | Instalación del `.vsix` |

## Cómo se organiza el repositorio

```
/
├─ Codigo_Fuente/   código, recursos y compilación (aquí se trabaja y se construye)
├─ Documentacion/   documentos del proyecto (este índice, estado y desarrollo)
├─ Instalable/      readme de instalación y el .vsix listo para instalar
├─ README.md        presentación del proyecto
└─ LICENSE          licencia MIT
```

`Codigo_Fuente/` es la raíz del paquete de la extensión (`package.json`, `media/`,
`resources/`, `dist/`). Todo lo demás queda fuera del `.vsix`.
