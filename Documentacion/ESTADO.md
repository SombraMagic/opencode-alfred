# Estado del proyecto

Última revisión: 28 de octubre de 2026 · versión **0.2.1**

## Resumen

La extensión está fusionada, compila, empaqueta y se instala. Los tres contenedores
(Explorador + Contexto + Límites de consumo, panel de Voz y panel de Dictado) están
montados y probados en VS Code real. El repositorio se publica en abierto con la
estructura `Codigo_Fuente/` · `Documentacion/` · `Instalable/`.

**opencode es el centro del producto.** La extensión está pensada y orientada a opencode.
Claude Code y Codex son **experimentales**: se exploran y se manejan en parte, pero su
soporte todavía no funciona del todo bien y puede cambiar sin aviso.

## Qué está hecho

- **Explorador** de agentes, MCP, skills y plugins para opencode, Claude Code y Codex,
  con selector de proveedor activo y una terminal por agente.
- **Editor de agentes** de opencode (permisos por herramienta y patrón) y **editor de
  subagentes** de Claude con su propio formulario.
- **Tablero de asignación** agentes ↔ modelos, con grupos de favoritos, precios y
  configuraciones guardadas (cambiar de pestaña vuelca el mapa en los `.md`).
- **Panel de conectores** de opencode: catálogo, configurados, alta (clave, externa,
  OAuth, comando), apagado por política y borrado.
- **Contexto** con desglose de la ventana, compactación y medición para los tres CLIs.
- **Estadísticas de agentes** (tokens, coste, tiempo, sesiones) y **de prompts**
  (línea de tiempo por prompt, con subagentes en paralelo).
- **Límites de consumo** por proveedor (DeepSeek, OpenAI, GitHub Copilot, OpenCode Go).
- **Voz** (SAPI, Edge, OpenAI, ElevenLabs) con esfera y ecualizador, y **dictado**
  (SAPI, Whisper local, nube) con bloc de notas y adjuntos. Su servidor MCP viaja dentro
  de la extensión (`dist/voz-mcp.js`), no como paquete externo.
- **Pizarra** por capas con lápiz, imágenes, textos, zoom y envío al prompt.

## Siguiente

1. **Probar el alta real de conectores** contra la API (crea credenciales; hasta ahora
   se validaron los formularios y las rutas con datos reales simulados).
2. **Lápiz real**: confirmar que los trazos no se cortan en un dispositivo táctil
   (depende del driver; el manejo de `pointercancel` ya está puesto).
3. **Publicación**: repositorio público, README de presentación y `.vsix` en
   `Instalable/`. El paso a público se hace a mano.
4. **Limpieza menor**: el `.vsix` arrastra ~1.6 MB de fuentes C++ de `koffi` que no se
   usan en ejecución.
5. **Claude y Codex en estadísticas de prompts**: hoy solo se miden prompts de opencode.

## Alcance

- **opencode es el objetivo principal**; Claude Code y Codex están en fase experimental.
- Las estadísticas leen las bases de opencode **en estricta solo lectura**.
- La extensión escribe el `model:` del fichero del agente, que opencode aplica a las
  sesiones nuevas; si el agente tocado es el de la sesión viva, también lo activa ahí.
- Las conexiones `env` de opencode no se borran desde el panel de conectores.
