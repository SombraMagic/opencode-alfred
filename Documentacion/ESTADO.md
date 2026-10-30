# Estado del proyecto

Última revisión: 30 de octubre de 2026 · versión **0.6.2**

## Resumen

La extensión está fusionada, compila, empaqueta y se instala. Los tres contenedores
(Explorador + Contexto + Límites de consumo, panel de Voz y panel de Dictado) están
montados y probados en VS Code real. El repositorio se publica en abierto con la
estructura `Codigo_Fuente/` · `Documentacion/` · `Instalable/`.

La **0.6.2** está empaquetada e instalada en local: la pizarra pierde la segunda fila de
ajustes y cada herramienta abre su ventana en un cajón único. Encima de la **INTERFACES** de
la 0.6.1 (estilo por widget y cajón `INTERFAZ` remozado). Sigue sin release publicada en
GitHub.

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
- **Límites de consumo** por proveedor (DeepSeek, OpenAI, GitHub Copilot, OpenCode Go);
  OpenCode Go lee el consumo real de la consola (porcentajes con su reposición) y solo
  estima con las bases si esa ruta no existe.
- **Voz** (SAPI, Edge, OpenAI, ElevenLabs) con ecualizador de barras pixeladas, y **dictado**
  (SAPI, Whisper local, nube) con bloc de notas y adjuntos. Su servidor MCP `mcp_alfred`
  viaja dentro de la extensión (`dist/alfred-mcp.js`), no como paquete externo: cubre la voz
  (`speak`, `list_voices`) y la pizarra (diez herramientas sobre `pizarra.json`, tres de ellas
  para la capa INTERFACES, y el panel recarga solo).
- **Pizarra** por capas con lápiz, imágenes, textos, zoom y envío al prompt. Incluye una
  capa **DIAGRAMA** para dibujar workflows: nodos (formas e iconos) con la etiqueta encajada
  en la silueta y color propio, y conectores ortogonales con asas, codos arrastrables,
  etiquetas y flechas, agarrando lo que se ve; el lápiz y el borrador encienden la capa
  `TRAZOS` si estaba oculta; deshacer/rehacer, multi-selección, guías y
  rejilla, chivatos de dibujo, copia como Mermaid y escena editable persistida en
  `pizarra.json` (además del PNG). La capa **INTERFACES** añade wireframes funcionales: trece
  tipos de widget anidados por contenedor, cajón `INTERFAZ` con paleta e inspector, y clic
  sobre el widget elegido que simula pestañas, acordeón y casillas.
- **Visor Alfred 3D** por fichero `.blend` (doble clic en el Explorador o «Abrir en Alfred
  3D»): vista con three.js y órbita estilo Blender, objetos con ocultar, cámaras (la de
  escena bloquea la vista), luces con deslizador, animaciones con rango de frames editable,
  casilla de texturas y render PNG de un frame o de toda la tirada. Dos motores: `VISOR`,
  por defecto, captura desde la propia webview y no necesita Blender; `BLENDER` renderiza
  con el motor y la cámara del `.blend`. Blender es **opcional** y se autodetecta: sin él
  abren las escenas ya cacheadas y las que traen un `.glb` al lado del `.blend` (sidecar).
  El `.blend` nunca se guarda.

- **Mente local (Ollama)**: pestaña central con el cerebro local del equipo. Detecta la
  instalación y la da de alta o de baja con `winget`; enciende el cerebro (arranca
  `ollama serve` si falta) y lo apaga; el bloque SERVIDOR tiene su propio `ARRANCAR`/`PARAR`,
  independiente del interruptor. Lista los modelos con su tamaño y el espacio libre del
  disco, con filtro, orden, descarga con progreso y cancelación, borrado y modelo preferido.
  Con el cerebro encendido escribe `provider.ollama` en el `opencode.json(c)` global (y lo
  reescribe al descargar o borrar), así que Ollama aparece en `CONECTORES` y en
  `ASIGNAR AGENTES`; al apagar lo retira y al activar la extensión el servidor vuelve solo.
  Revisada (`PASS`), con `typecheck` y `compile` en verde.

## Siguiente

1. **Mente local en vivo**: pulsar `MENTE LOCAL` y recorrer la pestaña con VS Code real
   (instalar, encender, descargar un modelo, apagar) y comprobar que el proveedor `ollama`
   aparece en `CONECTORES` y en `ASIGNAR AGENTES`. Hasta ahora está verificado el código, no
   el recorrido completo.
2. **Probar el alta real de conectores** contra la API (crea credenciales; hasta ahora
   se validaron los formularios y las rutas con datos reales simulados).
3. **Pizarra de workflows en VS Code real**: puntero real de las asas, reenganche de
   conectores al mover el nodo, zoom con arrastre de tramos y la cabecera a poco ancho.
4. **Capa INTERFACES en VS Code real**: abrir el cajón `INTERFAZ` e insertar, anidar y mover
   widgets; pegar una imagen con `Ctrl+V` sobre un widget `image`; y comprobar el aspecto con
   tema claro y oscuro y a escalas de 125 y 150 %. De la tanda de estilo queda por ver el
   aspecto del swatch del selector nativo de color, los iconos de trazo a tamaño real y que el
   PNG salga sin la ayuda de la etiqueta vacía.
5. **Ventanas de herramienta de la pizarra en vivo**: comprobar el cajón de `NODO` a 100 % de
   zoom y el hueco que tapa en la esquina superior izquierda al dibujar con `LÁPIZ`.
6. **Lápiz real**: confirmar que los trazos no se cortan en un dispositivo táctil
   (depende del driver; el manejo de `pointercancel` ya está puesto).
7. **Visor 3D en VS Code real**: el motor `VISOR` de punta a punta (del `.blend` al PNG en
   disco con la extensión instalada) y el sidecar `.glb` junto al `.blend`. Hasta ahora está
   probado con Chrome, Blender 4.4 real y stubs del host, no con la ventana de VS Code.
8. **`modelo1.blend`**: Blender pinta 15 personajes apilados y su mundo anula el sol sobre
   lo visible, mientras el visor solo muestra lo visible. Rareza del `.blend`, no del visor:
   decidir si se documenta o se deja.
9. **Limpieza menor**: el `.vsix` arrastra ~1.6 MB de fuentes C++ de `koffi` que no se
   usan en ejecución.
10. **Claude y Codex en estadísticas de prompts**: hoy solo se miden prompts de opencode.

## Alcance

- **opencode es el objetivo principal**; Claude Code y Codex están en fase experimental.
- Las estadísticas leen las bases de opencode **en estricta solo lectura**.
- La extensión escribe el `model:` del fichero del agente, que opencode aplica a las
  sesiones nuevas; si el agente tocado es el de la sesión viva, también lo activa ahí.
- Las conexiones `env` de opencode no se borran desde el panel de conectores.
