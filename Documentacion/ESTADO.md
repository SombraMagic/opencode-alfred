# Estado del proyecto

Última revisión: 31 de octubre de 2026 · versión **0.7.12**

## Resumen

La extensión está fusionada, compila, empaqueta y se instala. Los tres contenedores
(Explorador + Contexto + Límites de consumo, panel de Voz y panel de Dictado) están
montados y probados en VS Code real. El repositorio se publica en abierto con la
estructura `Codigo_Fuente/` · `Documentacion/` · `Instalable/`.

La **0.7.12** está empaquetada, sin instalar y sin release: el `Campo` de la capa `INTERFACES`
puede verse como desplegable. El flag booleano `dropdown` (apagado por defecto) solo cambia el
aspecto —el mismo marco y la misma caja, con una flecha al final y el texto 20 px más corto para
no pisarla—; no hay lista de opciones ni comportamiento de lista. Se enciende con la casilla
**DESPLEGABLE** del inspector del cajón `INTERFAZ`, que solo sale para ese tipo: con el widget
apagado la flecha va en gris y en cajas de menos de 24 px no se pinta, para no salirse del marco.
Viaja en `pizarra.json` y en el saneado (`sanitizeUi`), así que sobrevive a guardar, cargar e
`init`, y las escenas anteriores quedan en `false`. Va sobre la **0.7.11**, que está empaquetada, sin
instalar y sin release: la pizarra se puede **guardar y
cargar con nombre**. Dos botones de icono en la tira de pizarras, junto al `+` y el `−`:
`GUARDAR` (`#btn-board-save`, disquete) pide un nombre y escribe la pizarra activa —cualquier
pestaña, también la 1— en `<raíz>/.alfred/.pizarras/<Nombre>/` con `pizarra.json` (escena
completa) y `pizarra.png` (aplanado), o en el almacén global sin carpeta de proyecto; el nombre
se valida (sin `\ / : * ? " < > |`, sin punto inicial ni final, hasta 60, sin reservados de
Windows) y si ya existe un modal confirma antes de sobrescribir, y si el PNG no llega se borra
el anterior y se avisa. `CARGAR` (`#btn-board-load`, carpeta) lista las guardadas en un
`showQuickPick` y sustituye **todo** lo que hay en la pizarra activa (lienzo, fondo, capas,
diagrama, imágenes, `INTERFACES`, trazos y textos), dejando una entrada de historial para
deshacer y escribiendo el resultado en la pizarra activa; la barra de estado dice la ruta real.
Va sobre la **0.7.10**, que está empaquetada, sin instalar y sin release: los widgets de `INTERFACES` se
anidan (soltar uno de la paleta sobre un contenedor —`container`, `window`, `tabs-h`, `tabs-v`,
`accordion`— lo mete dentro con coordenadas relativas a su caja útil; arrastrar uno colocado lo
reanida y, sacado fuera, vuelve a la raíz sin saltar de sitio; la caja útil del destino se marca
con un marco discontinuo cian y hay tope de 8 niveles, el del saneado) y encajar (`#btn-fit`)
mide también esa capa: `ajustarLienzo()` suma la caja absoluta de cada widget y desplaza solo
las raíces, así que una pizarra solo de widgets se encaja y el PNG de `requestPng` los incluye.
Va sobre la **0.7.9**, que está empaquetada, sin instalar y sin release: la vista **Control**
pierde el plegado `CONTROLES` (fuera `<details>`/`<summary>`) y la fila de botones ocupa toda la vista, con borde
transparente y 6 px de margen arriba, izquierda y derecha (abajo, 0), sin scroll. Va sobre la
**0.7.8**, que está empaquetada, sin instalar y sin release: la vista `Límites de consumo` lee la
clave de DeepSeek y de OpenAI de la tabla `credential` de las bases de opencode (`active = 1`,
la fila más reciente) y solo cae a `~/.local/share/opencode/auth.json` si no hay. opencode v2 ya
no actualiza ese fichero al cambiar la clave, así que el saldo se quedaba clavado en el de la
primera clave (55,38 USD en vez de 5,74 USD, comprobado en vivo). Va sobre la **0.7.7**,
paquete sin instalar y sin release, que pasó la vista **Control** a una sola
fila elástica (`flex-wrap`) con el grupo de sesión `‹ [terminal] ›` como botón principal —más
grande, relleno cian y halo— y cuatro botones de módulo **solo icono** al lado: el enchufe de
los conectores, el cerebro de `OLLAMA` y los dos apagados (generador de imágenes y chatbot). Al
estrechar, la fila salta a más líneas y los botones se estiran; debajo no queda nada, así que
el panel no saca barra de desplazamiento. `MENTE GLOBAL` pasa a llamarse `OLLAMA` en el
título y el `aria-label` de esa vista. Va sobre la **0.7.6**, que empaquetó los **Límites de
consumo** con el sello «hace X min» fuera de su propia línea: pasa a la cabecera, a la izquierda
de `REFRESCAR`, y cada ventana ocupa **una sola línea** —rótulo, barra y `%` a la derecha—; las
de peticiones (Copilot) añaden `hechas / tope` antes del `%`, la ventana al tope cambia la barra
por el
tiempo de reanudación en rojo y las que no tienen tope (saldo o gasto) se quedan igual. Se
borran las reglas huérfanas del CSS (`.win-top`, `.win-foot`, `.win-rest`) y `fmtCorto` de
`media/limits.js`. Va sobre la **0.7.5**, que bajó el apilado de Contexto de
460 a 300 px, así que entre 300 y 500 px la matriz y la leyenda siguen en horizontal y
encogen juntas (`.ctx-body` a `minmax(0, 1.2fr)` / `minmax(110px, 1fr)`) en vez de apilarse
con la matriz a todo lo ancho. El resto de la 0.7.4 se mantiene: `COMPACTAR` en la cabecera
de la leyenda, matriz de Contexto 10 × 10 achatada (casillas `16 / 9`), cabecera apretada y
leyenda repartiendo su alto. Va sobre la **0.7.4**, que devolvió `COMPACTAR` a la caja de la
leyenda y `.ctx-body` a dos columnas, y sobre la **0.7.3**, que aplana
la matriz de Contexto
(casillas anchas y bajas, 10 × 10, la caja baja de ~335 px a ~135-160 px), mueve `COMPACTAR`
a la derecha de la leyenda y aprieta la cabecera del HUD. Y sobre la **0.7.2**, que corrigió
la matriz a 10 × 10 (100 casillas de un 1 %, más baja y cuadrada, sin tocar el ancho de la
caja) sobre la **0.7.1**, que estrenó la vista **Control** con el lanzador de sesión, los
conectores y Mente local, dejó al Explorador con `GLOBAL` · `PROYECTO` · `ASIGNAR AGENTES` y
el interruptor de permisos, y recordó las tarjetas plegadas de Límites de consumo. Encima de
la **0.7.0**, que arregló el doble clic de la pizarra, la colocación armada de widgets, el
copiar/pegar del panel, el widget `LISTA`, la maqueta de Contexto y el pegado del dictado.
Sigue sin release publicada en GitHub.

**opencode es el centro del producto.** La extensión está pensada y orientada a opencode.
Claude Code y Codex son **experimentales**: se exploran y se manejan en parte, pero su
soporte todavía no funciona del todo bien y puede cambiar sin aviso.

## Qué está hecho

- **Explorador** de agentes, MCP, skills y plugins para opencode, Claude Code y Codex, con
  selector de proveedor activo, y **vista Control** con el lanzador de sesión, los conectores
  y Mente local (más dos huecos apagados para imágenes y chatbot).
- **Editor de agentes** de opencode (permisos por herramienta y patrón) y **editor de
  subagentes** de Claude con su propio formulario.
- **Tablero de asignación** agentes ↔ modelos, con grupos de favoritos, precios y
  configuraciones guardadas (cambiar de pestaña vuelca el mapa en los `.md`).
- **Panel de conectores** de opencode: catálogo, configurados, alta (clave, externa,
  OAuth, comando), apagado por política y borrado.
- **Contexto** con desglose de la ventana, compactación y medición para los tres CLIs.
- **Estadísticas de agentes** (tokens, coste, tiempo, sesiones) y **de prompts**
  (línea de tiempo por prompt, con subagentes en paralelo).
- **Límites de consumo** por proveedor (DeepSeek, OpenAI, GitHub Copilot, OpenCode Go), con el
  despliegue de cada tarjeta recordado entre sesiones; OpenCode Go lee el consumo real de la
  consola (porcentajes con su reposición) y solo estima con las bases si esa ruta no existe.
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
  `pizarra.json` (además del PNG); `Ctrl+C`/`Ctrl+V` copian dentro del panel nodos con sus
  conectores, conectores sueltos, widgets con su subárbol, textos e imágenes. La capa
  **INTERFACES** añade wireframes funcionales: catorce tipos de widget anidados por contenedor
  (el último, `LISTA`, con filas, fila resaltada, icono y barra de desplazamiento opcionales),
  cajón `INTERFAZ` con paleta e inspector, colocación armada al clic con fantasma bajo el
  puntero (`Esc` o cerrar la paleta cancela), edición de la etiqueta con doble clic y clic
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
11. **0.7.3 a 0.7.9 sin ver en vivo**: abrir la vista `Control` y comprobar la fila elástica de
    la 0.7.7 —grupo de sesión como botón principal, la fila de
    iconos con el enchufe (apagado fuera de opencode), el cerebro `OLLAMA` con su brillo y los
    dos módulos apagados— sin barra de desplazamiento a 300/380/480 px (verificado en navegador
    headless, falta VS Code real), y la 0.7.9 sin el rótulo `CONTROLES`, con la fila ocupando
    todo el alto y los 6 px de margen; que `ASIGNAR AGENTES` se apaga con Claude o Codex;
    la matriz de Contexto a 10 × 10 achatada en panel estrecho y ancho (verificado en
    navegador a 450/500/640 px, falta VS Code real), el corte de 300 px de la 0.7.5 (matriz y
    leyenda en horizontal a 360/400/430/500/640 px, apiladas solo por debajo de 300), la barra
    de una línea por ventana de la 0.7.6 (verificada en navegador a 380 y 470 px, falta VS Code
    real) y que
    `COMPACTAR` vive dentro de la
    cabecera de la leyenda, a la derecha, sin desbordarla a 450/500/640 px; y que las tarjetas
    plegadas de Límites de consumo siguen plegadas tras recargar la ventana.

## Alcance

- **opencode es el objetivo principal**; Claude Code y Codex están en fase experimental.
- Las estadísticas leen las bases de opencode **en estricta solo lectura**.
- La extensión escribe el `model:` del fichero del agente, que opencode aplica a las
  sesiones nuevas; si el agente tocado es el de la sesión viva, también lo activa ahí.
- Las conexiones `env` de opencode no se borran desde el panel de conectores.
