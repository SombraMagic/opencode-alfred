// @ts-check
/* Resaltado de Markdown para las áreas de texto grandes de la extensión.
   Dos técnicas, según el campo:

   - attachTextarea(ta): envuelve la textarea en un contenedor, pinta un <pre>
     coloreado detrás y deja la textarea encima con el texto transparente (solo
     se ve el caret). Editar sigue siendo editar texto plano: el valor no se toca.
   - attachEditable(el): envuelve los tokens en <span> inline dentro de un
     contenteditable (el bloc de dictado) y devuelve el caret a su sitio.

   Todo el texto pasa por escapeHtml antes de entrar en innerHTML: nunca se
   interpola texto sin escapar. Las funciones de tokenizado (highlight) no tocan
   el DOM, así que se pueden comprobar sin navegador. */
(function () {
  /** El `<pre>` y los `<span>` solo llevan texto y estructura conocida. */
  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
  const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ESCAPES[c]);

  /** Marcadores en tono suave: opacidad, no un color apagado nuevo. */
  const mark = (text) => `<span class="md-mark" data-md="1">${escapeHtml(text)}</span>`;
  /** Contenido de un token, ya escapado. */
  const span = (cls, text) => `<span class="${cls}" data-md="1">${escapeHtml(text)}</span>`;
  /** El mismo span, con HTML propio dentro (para anidar inline). */
  const open = (cls) => `<span class="${cls}" data-md="1">`;

  /** Negrita, cursiva, código inline y enlaces. Lo que no encaja queda plano. */
  const INLINE = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`|\[([^\]\n]*)\]\(([^)\n]*)\)/g;

  /**
   * Una línea, sin prefijo ni valla: devuelve HTML con los tokens envueltos.
   * @param {string} text
   * @returns {string}
   */
  function inlineHtml(text) {
    let out = "";
    let last = 0;
    let m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text)) !== null) {
      out += escapeHtml(text.slice(last, m.index));
      if (m[1] !== undefined) out += mark("**") + span("md-bold", m[1]) + mark("**");
      else if (m[2] !== undefined) out += mark("*") + span("md-it", m[2]) + mark("*");
      else if (m[3] !== undefined) out += mark("`") + span("md-code", m[3]) + mark("`");
      else out += mark("[") + span("md-link", m[4]) + mark("](") + span("md-url", m[5]) + mark(")");
      last = m.index + m[0].length;
    }
    out += escapeHtml(text.slice(last));
    return out;
  }

  /**
   * Una línea completa, con el estado de la valla de código.
   * @param {string} line
   * @param {{ fence: boolean }} state
   * @returns {string}
   */
  function lineHtml(line, state) {
    const fence = /^(\s*)(```|~~~)/.exec(line);
    if (fence) {
      state.fence = !state.fence;
      return mark(fence[1] + fence[2]) + escapeHtml(line.slice(fence[0].length));
    }
    if (state.fence) return span("md-codeblock", line);

    // Título: como mucho un nivel de anidado inline (negrita dentro de un #).
    const head = /^(#{1,6})(?=\s|$)/.exec(line);
    if (head) return mark(head[1]) + open("md-head") + inlineHtml(line.slice(head[1].length)) + "</span>";

    // Lista: el marcador se pinta, el contenido sigue siendo texto normal.
    const li = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(line);
    if (li) {
      return (
        escapeHtml(li[1]) + span("md-li", li[2]) + inlineHtml(line.slice(li[1].length + li[2].length))
      );
    }

    // Cita: el ">" es el marcador; el resto admite inline.
    const quote = /^(\s*)>/.exec(line);
    if (quote) {
      return escapeHtml(quote[1]) + mark(">") + open("md-quote") + inlineHtml(line.slice(quote[1].length + 1)) + "</span>";
    }

    return inlineHtml(line);
  }

  /** Última línea del frontmatter, o -1 si no empieza con `---`. */
  function frontmatterEnd(lines) {
    if (!lines.length || lines[0].trim() !== "---") return -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") return i;
    }
    return -1;
  }

  /** Una línea del frontmatter: `clave: valor` o el delimitador `---`. */
  function frontmatterLine(line, delimiter) {
    if (delimiter) return mark(line);
    const kv = /^(\s*)([^:\s][^:]*)(:)(.*)$/.exec(line);
    if (!kv) return span("md-fm-val", line);
    return escapeHtml(kv[1]) + span("md-fm-key", kv[2]) + mark(":") + span("md-fm-val", kv[4]);
  }

  /**
   * Texto Markdown -> HTML coloreado. El texto sin las etiquetas es idéntico al
   * de entrada (todo va escapado, los saltos se conservan tal cual).
   * @param {string} text
   * @returns {string}
   */
  function highlight(text) {
    const src = String(text == null ? "" : text);
    const lines = src.split("\n");
    const end = frontmatterEnd(lines);
    const state = { fence: false };
    let out = "";
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) out += "\n";
      const line = lines[i];
      // Las dos primeras líneas con `---` delimitan el frontmatter YAML.
      if (end > 0 && i <= end) out += frontmatterLine(line, i === 0 || i === end);
      else out += lineHtml(line, state);
    }
    return out;
  }

  /* ── Overlay para textarea ─────────────────────────────── */

  /** Copia la caja tipográfica de la textarea al `<pre>` (en px). */
  function syncBox(ta, pre) {
    const cs = getComputedStyle(ta);
    pre.style.fontFamily = cs.fontFamily;
    pre.style.fontSize = cs.fontSize;
    pre.style.fontWeight = cs.fontWeight;
    pre.style.fontStyle = cs.fontStyle;
    pre.style.letterSpacing = cs.letterSpacing;
    pre.style.lineHeight = cs.lineHeight;
    pre.style.tabSize = cs.tabSize;
    pre.style.paddingTop = cs.paddingTop;
    pre.style.paddingBottom = cs.paddingBottom;
    pre.style.paddingLeft = cs.paddingLeft;
    // La barra de scroll de la textarea no ocupa sitio en el <pre>: sin sumarla,
    // las líneas que rozan el borde derecho romperían en otro punto.
    const borders = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    const bar = Math.max(0, ta.offsetWidth - ta.clientWidth - borders);
    pre.style.paddingRight = parseFloat(cs.paddingRight) + bar + "px";
    // Mismo borde (transparente) que la textarea: el contenido arranca igual.
    pre.style.border = cs.borderTopWidth + " solid transparent";
    pre.style.background = cs.backgroundColor;
  }

  /**
   * Overlay de color bajo una textarea. Devuelve un repintado manual o null.
   * @param {HTMLTextAreaElement} ta
   */
  function attachTextarea(ta) {
    if (!ta || ta.dataset.mdEditor) return null;
    ta.dataset.mdEditor = "textarea";

    const wrap = document.createElement("div");
    wrap.className = "md-wrap";
    const pre = document.createElement("pre");
    pre.className = "md-hl";
    pre.setAttribute("aria-hidden", "true");
    ta.parentNode.insertBefore(wrap, ta);
    wrap.appendChild(pre);
    wrap.appendChild(ta);
    ta.classList.add("md-input");

    let pending = 0;
    const paint = () => {
      pending = 0;
      syncBox(ta, pre);
      // shortcut: repinta el texto entero en cada tecla; sobra para prompts y
      // notas, con un fichero enorme habría que pintar solo la línea tocada.
      pre.innerHTML = highlight(ta.value);
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    };
    const schedule = () => {
      if (!pending) pending = requestAnimationFrame(paint);
    };
    const mirror = () => {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    };

    ta.addEventListener("input", schedule);
    ta.addEventListener("change", schedule);
    ta.addEventListener("scroll", mirror);
    window.addEventListener("resize", paint);

    // El panel carga el texto con `value = …`, que no dispara "input": se
    // intercepta la propiedad para repintar también entonces.
    const value = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (value) {
      Object.defineProperty(ta, "value", {
        configurable: true,
        get() {
          return value.get.call(ta);
        },
        set(v) {
          value.set.call(ta, v);
          paint();
        },
      });
    }

    paint();
    return { repaint: paint, pre };
  }

  /* ── contenteditable: tokens en <span> ─────────────────── */

  const isChip = (node) =>
    node.nodeType === 1 && !!(node.dataset && (node.dataset.path || node.dataset.file));

  /**
   * Piezas del caret en orden: cada nodo de texto y cada chip, que ocupa un
   * hueco. El interior de los chips (miniatura, nombre) no cuenta.
   */
  function caretItems(root) {
    const out = [];
    const walk = (n) => {
      for (const child of n.childNodes) {
        if (child.nodeType === 3) out.push({ text: child });
        else if (isChip(child)) out.push({ chip: child });
        else if (child.nodeType === 1) walk(child);
      }
    };
    walk(root);
    return out;
  }

  /** Lo que ocupa una pieza en el índice del caret: su texto, o 1 por chip. */
  const itemLength = (item) => (item.text ? item.text.nodeValue.length : 1);

  /**
   * Posición del caret como índice sobre caretItems(root), o null si no está
   * dentro. Entiende también el caret entre nodos, que es el que deja
   * `range.setStartAfter` al insertar: ahí solo cuenta lo que queda antes.
   */
  function caretOffset(root) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const start = range.startContainer;
    if (!root.contains(start)) return null;
    // Punto suelto del caret, solo cuando cae en un contenedor de elemento.
    const point = start.nodeType === 3 ? null : document.createRange();
    if (point) point.setStart(start, range.startOffset);
    let offset = 0;
    for (const item of caretItems(root)) {
      const node = item.text ?? item.chip;
      if (node === start) return offset + (item.text ? range.startOffset : 1);
      // comparePoint devuelve -1 cuando el nodo entero queda antes del caret.
      if (point && point.comparePoint(node, 0) >= 0) break;
      offset += itemLength(item);
    }
    return point ? offset : null;
  }

  /** Devuelve el caret al índice indicado (misma cuenta que caretOffset). */
  function setCaret(root, offset) {
    if (offset == null) return;
    const items = caretItems(root);
    if (!items.length) return;
    let accumulated = 0;
    let range = null;
    for (const item of items) {
      const len = itemLength(item);
      if (offset > accumulated + len) {
        accumulated += len;
        continue;
      }
      const at = offset - accumulated;
      range = document.createRange();
      // El chip ocupa su hueco: el final de su índice deja el caret detrás.
      if (item.text) range.setStart(item.text, at);
      else if (at > 0) range.setStartAfter(item.chip);
      else range.setStartBefore(item.chip);
      break;
    }
    if (!range) {
      const last = items[items.length - 1];
      range = document.createRange();
      if (last.text) range.setStart(last.text, last.text.nodeValue.length);
      else range.setStartAfter(last.chip);
    }
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** Plantilla para pasar de HTML propio a nodos reales (siempre texto escapado). */
  let template;
  function nodesOf(html) {
    if (!template) template = document.createElement("template");
    template.innerHTML = html;
    return template.content.cloneNode(true);
  }

  /**
   * Recolorea el bloc sin tocar chips, `<br>` ni los `<div>` de Chromium:
   * solo se sustituyen nodos de texto, y el caret se devuelve a su índice.
   *
   * shortcut: al sustituir nodos, el deshacer nativo del webview no ve esas
   * mutaciones y una selección de varias palabras se queda en caret. Si algún
   * día molesta, hay que llevar una pila de deshacer propia o pintar solo al
   * soltar el foco.
   * @param {HTMLElement} root
   */
  function paintEditable(root) {
    const caret = caretOffset(root);

    // 1. Deshace el resaltado anterior (solo los spans que pintamos nosotros).
    for (const old of root.querySelectorAll("span[data-md]")) {
      old.replaceWith(...old.childNodes);
    }

    // 2. Recorre texto y <br> en orden: la valla de código depende de la línea.
    const items = [];
    const collect = (n) => {
      for (const child of n.childNodes) {
        if (child.nodeType === 3) items.push({ text: child });
        else if (child.nodeName === "BR") items.push({ br: true });
        else if (isChip(child)) items.push({ chip: true });
        else collect(child);
      }
    };
    collect(root);

    const state = { fence: false };
    let lineStart = true;
    for (const item of items) {
      if (item.br) {
        lineStart = true;
        continue;
      }
      if (item.chip) {
        lineStart = false;
        continue;
      }
      // Un nodo puede llevar varias líneas (pegado, dictado): se parte por \n.
      // shortcut: el frontmatter no se detecta aquí (una valla sí): el bloc es
      // de notas, y adivinar el estado YAML entre nodos no compensa.
      const parts = item.text.nodeValue.split("\n");
      const frag = document.createDocumentFragment();
      parts.forEach((part, index) => {
        if (index > 0) {
          frag.appendChild(document.createTextNode("\n"));
          lineStart = true;
        }
        if (!part) return;
        if (lineStart) frag.appendChild(nodesOf(lineHtml(part, state)));
        else if (state.fence) frag.appendChild(nodesOf(span("md-codeblock", part)));
        else frag.appendChild(nodesOf(inlineHtml(part)));
        lineStart = false;
      });
      item.text.replaceWith(frag);
    }

    setCaret(root, caret);
  }

  /**
   * Resaltado dentro de un contenteditable. Devuelve un repintado manual o null.
   * @param {HTMLElement} root
   */
  function attachEditable(root) {
    if (!root || root.dataset.mdEditor) return null;
    root.dataset.mdEditor = "editable";

    // Durante una composición (acentos, IME) tocar el DOM rompería el caret.
    let composing = false;
    root.addEventListener("compositionstart", () => {
      composing = true;
    });
    root.addEventListener("compositionend", () => {
      composing = false;
    });

    // El bloc cambia por tecleo, dictado, pegado y adjuntos: se pinta ante
    // cualquier mutación. `takeRecords` descarta las que provoca el propio
    // pintado, que si no se repintaría en bucle.
    const observer = new MutationObserver(() => {
      if (composing) return;
      paintEditable(root);
      observer.takeRecords();
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });

    paintEditable(root);
    return { repaint: () => paintEditable(root) };
  }

  window.MdEditor = { highlight, attachTextarea, attachEditable };
})();