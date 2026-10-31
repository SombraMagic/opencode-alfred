# Instalar OpenCode Alfred

Paquete listo para usar: **`opencode-alfred-0.7.13.vsix`** (en esta misma carpeta).
No hace falta compilar nada ni instalar Node.

## Antes de empezar

| Requisito | Detalle |
| --- | --- |
| VS Code | 1.90 o superior |
| opencode | opcional, pero sin él no hay explorador de agentes ni estadísticas |
| Windows | necesario para la voz y el dictado sin conexión (SAPI) |
| Blender | opcional: solo lo usa el Visor Alfred 3D para exportar y renderizar. Sin él, el visor abre lo ya exportado (caché o `.glb` al lado) y renderiza con el motor `VISOR` |
| Ollama | opcional: es el cerebro de **Mente local**. Se instala desde el propio panel con `winget` |

La extensión está pensada y orientada a **opencode**. Claude Code y Codex son
**experimentales**: su soporte todavía no funciona del todo bien.

## Novedades de la 0.7.13

- **La rejilla tiene paso configurable**: junto al botón `REJILLA` hay un campo numérico que lo
  lleva de 1 a 64 px, siempre cuadrado. Vacío o `0` vuelve a 8; fuera de rango se acota. El
  encendido y el paso se recuerdan al reabrir la pestaña. Con pasos pequeños la cuadrícula pinta
  una línea de cada `n` para distinguirse, y el ajuste sigue usando el paso fino.
- **El ajuste va por la esquina superior izquierda**: textos e imágenes se encajan al moverlos,
  una selección de varios nodos encaja su caja entera y el nodo nuevo encaja sus dos esquinas.
  Las flechas mueven una celda (con `Mayús`, diez), `TEXTO` nace en la rejilla y, con la rejilla
  encendida, las guías inteligentes no desplazan nada; apagada vuelven las guías y el 1/10 px.

## Novedades de la 0.7.12

- **El `Campo` de interfaces puede verse como desplegable**: una casilla `DESPLEGABLE` en el
  inspector del cajón `INTERFAZ` le pone una flecha al final y acorta el texto para no pisarla.
  Es solo el aspecto: no hay lista de opciones. Con el widget apagado la flecha va en gris y en
  cajas muy estrechas no se pinta.

## Novedades de la 0.7.11

- **Guardar y cargar pizarras con nombre**: dos botones de icono en la tira de pizarras, junto
  al `+` y el `−`. El disquete guarda la pizarra activa con un nombre y la carpeta se queda con
  la escena completa (`pizarra.json`) y el aplanado (`pizarra.png`); la carpeta o los ficheros
  piden confirmación antes de pisar una guardada. La carpeta lista las guardadas y sustituye
  todo lo que hay en la pizarra activa, con deshacer.
- Se guardan en `<raíz>/.alfred/.pizarras/<Nombre>/` (sin proyecto, en el almacén global).

## Novedades de la 0.7.10

- **Los widgets de interfaces se anidan**: suelta uno de la paleta sobre un contenedor y entra
  dentro; arrastra uno ya colocado y cambia de contenedor, o sale a la raíz sin moverse de donde
  se ve. Un marco discontinuo cian marca la caja útil que lo va a recibir. Tope de 8 niveles.
- **`Encajar` cuenta los widgets**: el lienzo se ajusta también a la capa de interfaces, así que
  una pizarra solo de widgets se encaja y el PNG que se pega en el bloc los incluye.

## Novedades de la 0.7.9

- **La vista `Control` se queda sin el plegado `CONTROLES`**: la fila de botones ocupa ahora
  toda la vista, con 6 px de aire arriba y a los lados y sin borde, así que no deja franja
  muerta ni barra de desplazamiento.

## Novedades de la 0.7.8

- **El saldo de DeepSeek y el coste de OpenAI ya no se quedan en el de la primera clave**: la
  vista `Límites de consumo` lee la clave de la tabla `credential` de las bases de opencode (la
  fila activa más reciente) y solo cae a `auth.json` si no hay. opencode v2 ya no actualiza ese
  fichero al cambiar la clave, que era la causa. De 55,38 USD a los 5,74 USD reales, comprobado
  en vivo.
- Un proveedor cuya clave solo viva en `credential` deja de salir como no soportado por los
  límites.

## Novedades de la 0.7.7

- **Vista `Control` en una sola fila elástica**: el grupo de sesión (`‹ [terminal] ›`) pasa a
  ser el botón principal —más grande, con relleno cian y halo— y a su lado van cuatro botones
  de módulo **solo icono**: el enchufe de los conectores, el cerebro de `OLLAMA` y los dos
  apagados del generador de imágenes y el chatbot. Al estrechar, la fila salta a más líneas y
  los botones se estiran; por debajo no queda nada, así que no sale barra de desplazamiento.
- **`MENTE GLOBAL` ahora se llama `OLLAMA`** en esa vista, título y `aria-label`.

## Novedades de la 0.7.6

- **Límites de consumo, una línea por ventana**: cada ventana muestra rótulo, barra y `%` en la
  misma fila. Las de peticiones (Copilot) añaden `hechas / tope` antes del `%`; con la ventana al
  tope, la barra deja su sitio al tiempo de reanudación en rojo. El saldo o el gasto (DeepSeek,
  OpenAI) se queda como estaba.
- **Sello del último sondeo en la cabecera**: «hace X min» deja su línea y pasa a la izquierda de
  `REFRESCAR`, así que las tarjetas ganan ese alto.

## Novedades de la 0.7.5

- **Contexto en barra estrecha**: matriz y leyenda se apilan solo por debajo de 300 px. Entre
  300 y 500 px siguen lado a lado y encogen juntas, así que al estrechar el panel la matriz no
  se estira a todo lo ancho ni se come la vista.
- El resto de la 0.7.4 se mantiene: `COMPACTAR` en la cabecera de `Leyenda`, matriz de
  Contexto 10 × 10 achatada, cabecera apretada y leyenda repartiendo su alto.

## Novedades de la 0.7.4

- **`COMPACTAR` dentro de la leyenda**: deja de ser una tercera columna fuera de la caja y
  vive en la cabecera de `Leyenda`, justificado a la derecha y más pequeño (8 px). La maqueta
  vuelve a dos columnas.
- El resto de la 0.7.3 se mantiene: matriz de Contexto 10 × 10 achatada, cabecera apretada y
  leyenda repartiendo su alto.

## Novedades de la 0.7.3

- **Matriz de Contexto achatada**: sigue en 10 × 10 casillas, pero cada casilla es ancha y
  baja, así que la caja baja de ~335 px a ~135-160 px de alto.
- **`COMPACTAR` a la derecha de la leyenda**, alineado con su parte alta; en barra estrecha
  (≤ 460 px) se apila debajo, alineado a la derecha.
- **Menos alto**: la cabecera del HUD va más apretada y la leyenda reparte sus filas por el
  alto de su caja en vez de dejar hueco.

## Novedades de la 0.7.2

- **Matriz de Contexto cuadrada**: pasa a 10 × 10 (100 casillas, cada una vale un 1 %), más
  baja y sin cambiar el ancho de la caja; corrige el 10 × 16 de la 0.7.1.

## Novedades de la 0.7.1

- **Vista `Control`** en la barra ALFRED: `‹ [terminal] ›` para abrir
  la sesión y cambiar de agente, los conectores y Ollama (hoy, una fila de iconos: enchufe,
  cerebro de `OLLAMA` y los dos módulos apagados, generador de imágenes y chatbot, con su hueco
  «Próximamente»).
- **Explorador más corto**: el lanzador de terminales, los conectores y Ollama se mudan a
  `Control`. Queda `GLOBAL` · `PROYECTO` · `ASIGNAR AGENTES` y, debajo, `ACEPTAR TODOS LOS
  PERMISOS`. `ASIGNAR AGENTES` se apaga cuando el proveedor activo no es opencode.
- **Contexto**: la matriz pasa de 20 × 8 a 10 × 16, las mismas 160 celdas con casillas más
  grandes.
- **Límites de consumo**: cada tarjeta recuerda si estaba plegada entre sesiones.

## Instalar

**Desde VS Code**

1. Abre el panel **Extensiones** (`Ctrl+Shift+X`).
2. Menú `...` → **Install from VSIX...**.
3. Elige `opencode-alfred-0.7.13.vsix`.
4. Paleta de comandos (`Ctrl+Shift+P`) → **Developer: Reload Window**.

**Desde la terminal**

```bash
code --install-extension opencode-alfred-0.7.13.vsix
```

Si ya tenías una versión anterior, añade `--force` para reemplazarla:

```bash
code --install-extension opencode-alfred-0.7.13.vsix --force
```

## Ya instalado, ¿por dónde empiezo?

- **ALFRED** en la barra de actividad (izquierda): el centro de control. Explorador de
  agentes, MCP, skills y plugins, con `GLOBAL` · `PROYECTO` · `ASIGNAR AGENTES` y el
  interruptor de permisos arriba; **Control**, con la sesión, los conectores y Mente local;
  Contexto y Límites de consumo.
- **VOZ** en la barra lateral derecha: ecualizador de barras y ajustes de voz.
- **DICTADO** en el panel inferior: bloc de notas, configuración y micrófono.
- **Visor Alfred 3D**: haz doble clic en un `.blend` desde el Explorador (o menú contextual →
  **Abrir en Alfred 3D**). Gira la escena, oculta objetos, mueve cámaras y luces y pulsa `FOTO`.
  Con Blender instalado también renderiza con su motor; sin él, elige `MOTOR → VISOR`.

Los ajustes viven en `Ajustes → OpenCode Alfred` (`opencodeAgents.*`) y
`Ajustes → Voz` (`voz.*`).

## Desinstalar

Panel **Extensiones** → busca **OpenCode Alfred** → **Uninstall** → recarga la ventana.
Tus agentes, MCP y ajustes de opencode no se tocan: la extensión nunca escribe en las
bases de datos.

## Si algo no sale

- **No aparece el icono ALFRED**: recarga la ventana. Si sigue sin salir, comprueba que
  la versión de VS Code es 1.90 o superior.
- **Las estadísticas están vacías**: necesitan que opencode haya ejecutado alguna sesión
  y un VS Code con Node 22.5+. Con menos, el resto de la extensión funciona igual.
- **No hay voz**: en Windows usa SAPI (sin conexión). En otros sistemas, elige Edge,
  OpenAI o ElevenLabs en los ajustes de voz; OpenAI y ElevenLabs piden clave API.
- **El explorador sale vacío**: instala y arranca [opencode](https://opencode.ai) al
  menos una vez para que exista su configuración.
- **«No encuentro Blender»** al abrir un `.blend` o al renderizar: instala
  [Blender](https://www.blender.org) o indica la ruta en el ajuste
  `opencodeAgents.blenderPath`. La autodetección mira el `PATH`,
  `C:\Program Files\Blender Foundation` y el registro de Windows. Mientras tanto siguen
  abriendo las escenas ya exportadas y las que traen un `.glb` al lado del `.blend`, y el
  motor `VISOR` no necesita Blender para pintar.
- **El `.blend` no abre sin Blender**: o no está en la caché o el `<nombre>.glb` de al lado
  es **más viejo** que el `.blend`, así que hace falta Blender para reexportar. Copia un
  `.glb` más nuevo que el `.blend` junto a él (y su `<nombre>.meta.json`, si lo tienes). Y
  si el `.blend` es de Blender 5.x, el 4.4 lo rechaza con `incomplete header`: usa 5.2 o
  más nuevo.

## ¿Te ha servido?

Invítame a un café por PayPal: [paypal.me/sombrawandax](https://www.paypal.com/paypalme/sombrawandax)

Licencia MIT. Ver [../LICENSE](../LICENSE).
