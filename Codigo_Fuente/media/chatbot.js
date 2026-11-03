/* ALFRED // CHATBOT: webview del panel central. Sin frameworks. */
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const MAX_FILES = 4;
  const MAX_BYTES = 10 * 1024 * 1024;
  const OK_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  const SUGGESTIONS = [
    "Preséntate y dime qué puedes hacer.",
    "Explícame la recursión con un ejemplo en TypeScript.",
    "Genera una imagen de un gato astronauta en pixel art.",
    "Resume en tres puntos las ventajas de un modelo local.",
  ];

  const el = {
    app: $("app"), side: $("side"), btnSide: $("btn-side"), model: $("model"), caps: $("caps"),
    autospeak: $("autospeak"), btnExport: $("btn-export"), btnNew: $("btn-new"), btnSettings: $("btn-settings"),
    lock: $("lock"), lockReason: $("lock-reason"), chats: $("chats"), chatsEmpty: $("chats-empty"),
    scroll: $("scroll"), empty: $("empty"), sugs: $("sugs"), msgs: $("msgs"), bottom: $("btn-bottom"),
    compose: $("compose"), thumbs: $("thumbs"), inputErr: $("input-err"), attach: $("btn-attach"),
    file: $("file"), text: $("text"), send: $("btn-send"), settings: $("settings"),
    system: $("set-system"), temp: $("set-temp"), ctx: $("set-ctx"), tools: $("tools"), toolsNote: $("tools-note"),
    main: document.querySelector(".cb-main"),
  };

  let st = null; // estado del host
  let chat = null; // conversación abierta
  let busy = false;
  let stick = true;
  let attachments = []; // {name, dataUrl}
  let pendingDelete = null;
  let editing = null;
  const live = new Map(); // messageId -> registro de mensaje pintado
  let ui = Object.assign({ side: true, settings: false, draft: "" }, vscode.getState() || {});
  function saveUi() { vscode.setState(ui); }

  /* ---------- Markdown seguro: todo texto pasa por esc() antes de tocar HTML ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function inline(raw) {
    return String(raw).split(/(`[^`\n]+`)/).map((part) => {
      if (part.length > 2 && part[0] === "`" && part[part.length - 1] === "`") {
        return "<code>" + esc(part.slice(1, -1)) + "</code>";
      }
      let t = esc(part);
      t = t.replace(/\[([^\]\n]+)\]\(([^)\n]*)\)/g, "$1 ($2)");
      t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
      t = t.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
      return t;
    }).join("");
  }
  function cells(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  }
  function markdown(src) {
    const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    const special = (l) => /^\s*(```|#{1,4}\s|>\s?|[-*+]\s|\d+[.)]\s)/.test(l);
    while (i < lines.length) {
      const l = lines[i];
      const fence = l.match(/^\s*```\s*([\w+#.-]*)/);
      if (fence) {
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push('<div class="cb-code"><div class="cb-code-head"><span>' + esc(fence[1] || "código") +
          '</span><button type="button" class="cb-btn" data-act="copycode" aria-label="Copiar código">COPIAR</button></div><pre><code>' +
          esc(code.join("\n")) + "</code></pre></div>");
        continue;
      }
      if (!l.trim()) { i++; continue; }
      const h = l.match(/^(#{1,4})\s+(.*)$/);
      if (h) { out.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"); i++; continue; }
      if (/^\s*>\s?/.test(l)) {
        const q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push("<blockquote>" + q.map(inline).join("<br>") + "</blockquote>");
        continue;
      }
      if (/^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l)) {
        const ord = /^\s*\d+[.)]\s+/.test(l);
        const re = ord ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
        const items = [];
        while (i < lines.length && re.test(lines[i])) items.push("<li>" + inline(lines[i++].replace(re, "")) + "</li>");
        out.push((ord ? "<ol>" : "<ul>") + items.join("") + (ord ? "</ol>" : "</ul>"));
        continue;
      }
      if (l.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        const head = cells(l);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push("<table><thead><tr>" + head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table>");
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !(para.length && special(lines[i]))) para.push(lines[i++]);
      out.push("<p>" + para.map(inline).join("<br>") + "</p>");
    }
    return out.join("");
  }
  // Para pruebas en node (sin DOM al cargar no es posible: se expone solo si hay window.__cbTest).
  if (typeof window !== "undefined") window.__cbMarkdown = markdown;

  /* ---------- utilidades ---------- */
  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function rel(ts) {
    if (!ts) return "";
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "ahora";
    if (s < 3600) return "hace " + Math.floor(s / 60) + " min";
    if (s < 86400) return "hace " + Math.floor(s / 3600) + " h";
    if (s < 86400 * 30) return "hace " + Math.floor(s / 86400) + " d";
    return new Date(ts).toLocaleDateString("es-ES");
  }
  function metricsText(m) {
    if (!m) return "";
    const parts = [];
    if (m.evalCount != null) parts.push(m.evalCount + " tokens");
    if (m.evalCount && m.evalDurationMs > 0) parts.push((m.evalCount / (m.evalDurationMs / 1000)).toFixed(1) + " tok/s");
    if (m.totalMs != null) parts.push(Math.round(m.totalMs) + " ms");
    return parts.join(" · ");
  }
  function nearBottom() { return el.scroll.scrollHeight - el.scroll.scrollTop - el.scroll.clientHeight < 40; }
  function toBottom() { el.scroll.scrollTop = el.scroll.scrollHeight; stick = true; el.bottom.hidden = true; }
  function followScroll() { if (stick) toBottom(); else el.bottom.hidden = false; }
  function argsText(a) { try { return JSON.stringify(a, null, 2); } catch (_) { return String(a); } }
  function toolLabel(name) {
    const t = st && st.tools && st.tools.find((x) => x.name === name);
    if (t && t.label) return t.label.toUpperCase();
    return name === "generar_imagen" ? "GENERAR IMAGEN" : String(name || "").toUpperCase();
  }

  /* ---------- mensajes ---------- */
  function roleOf(r) { return r === "user" ? ["user", "TÚ", "TÚ"] : r === "tool" ? ["tool", "HERR", "HERRAMIENTA"] : ["assistant", "IA", "MODELO"]; }
  function newRecord(id, role, at) {
    const [cls, av, name] = roleOf(role);
    const root = mk("div", "cb-msg " + cls);
    root.dataset.id = id;
    const avatar = mk("div", "cb-avatar", av);
    avatar.setAttribute("aria-hidden", "true");
    const body = mk("div", "cb-body");
    const head = mk("div", "cb-role", name + (at ? " · " + new Date(at).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }) : ""));
    const think = mk("details", "cb-think");
    think.hidden = true;
    think.appendChild(mk("summary", "", "PENSANDO…"));
    const thinkBody = mk("div", "cb-think-body");
    think.appendChild(thinkBody);
    const tools = mk("div", "cb-tools-box");
    const content = mk("div", "cb-content");
    const imgs = mk("div", "cb-imgs");
    const err = mk("div", "cb-err");
    err.hidden = true;
    const foot = mk("div", "cb-foot");
    body.append(head, think, tools, content, imgs, err, foot);
    root.append(avatar, body);
    const rec = { id, role, root, think, thinkBody, tools, content, imgs, err, foot, text: "", thought: "", cards: [], metrics: null, streaming: false, dirty: false };
    return rec;
  }
  function paint(rec) {
    rec.dirty = false;
    if (rec.role === "user") rec.content.textContent = rec.text;
    else rec.content.innerHTML = markdown(rec.text);
    rec.content.classList.toggle("cb-cursor", rec.streaming);
    rec.content.hidden = !rec.text && !rec.streaming;
    rec.thinkBody.textContent = rec.thought;
    rec.think.hidden = !rec.thought;
    followScroll();
  }
  function schedule(rec) {
    if (rec.dirty) return;
    rec.dirty = true;
    requestAnimationFrame(() => paint(rec));
  }
  function addImage(rec, uri) {
    const img = mk("img", "cb-img");
    img.src = uri;
    img.alt = "Imagen del mensaje";
    img.tabIndex = 0;
    img.title = "Clic para abrir el fichero";
    img.dataset.file = uri;
    img.addEventListener("load", () => { if (stick) toBottom(); });
    rec.imgs.appendChild(img);
  }
  function addCard(rec, name, args, withPrompt) {
    const card = mk("div", "cb-toolcard");
    const head = mk("div", "cb-toolhead");
    const state = mk("span", "cb-toolstate", "EN CURSO");
    head.append(mk("span", "cb-toolname", toolLabel(name)), state);
    // El prompt de la imagen se copia tal cual se mandó a la herramienta. Las tarjetas de
    // «LLAMADA» de un mensaje assistant no lo llevan: solo la de la herramienta.
    const prompt = args && typeof args.prompt === "string" ? args.prompt : "";
    if (withPrompt !== false && prompt.trim()) {
      const b = mk("button", "cb-btn cb-prompt", "COPIAR PROMPT");
      b.type = "button";
      b.title = "Copiar el prompt con el que se generó la imagen";
      b.setAttribute("aria-label", b.title);
      b.addEventListener("click", () => {
        send({ type: "copy", text: prompt });
        b.textContent = "COPIADO";
        setTimeout(() => { b.textContent = "COPIAR PROMPT"; }, 1200);
      });
      head.appendChild(b);
    }
    const a = mk("pre", "cb-toolargs", argsText(args));
    const prog = mk("div", "cb-progress");
    prog.setAttribute("role", "progressbar");
    prog.setAttribute("aria-label", "Ejecutando herramienta");
    const res = mk("div", "cb-toolres");
    res.hidden = true;
    card.append(head, a, prog, res);
    rec.tools.appendChild(card);
    const c = { name, card, state, prog, res, closed: false };
    rec.cards.push(c);
    return c;
  }
  function closeCard(rec, name, result, error, imageUri, attachment) {
    let c = rec.cards.find((x) => x.name === name && !x.closed);
    if (!c) c = addCard(rec, name, {});
    c.closed = true;
    c.prog.remove();
    c.card.classList.add(error ? "error" : "done");
    c.state.textContent = error ? "ERROR" : "HECHO";
    const txt = error ? String(error) : typeof result === "string" ? result : result && result.text ? String(result.text) : "";
    if (txt) { c.res.textContent = txt; c.res.hidden = false; }
    const file = (result && result.attachment && result.attachment.file) || (attachment && attachment.file);
    if (imageUri) addImage(rec, imageUri);
    else if (file) {
      const b = mk("button", "cb-btn", "ABRIR IMAGEN");
      b.type = "button";
      b.dataset.file = file;
      b.dataset.act = "openfile";
      c.card.appendChild(b);
    }
  }
  function footer(rec, last) {
    rec.foot.textContent = "";
    if (rec.role === "tool") return;
    if (rec.metrics) rec.foot.appendChild(mk("span", "", metricsText(rec.metrics)));
    if (rec.role === "assistant" && !rec.streaming) {
      const copy = mk("button", "cb-btn", "COPIAR"); copy.type = "button"; copy.dataset.act = "copy"; copy.setAttribute("aria-label", "Copiar respuesta");
      const voice = mk("button", "cb-btn", "LEER EN VOZ"); voice.type = "button"; voice.dataset.act = "speak"; voice.setAttribute("aria-label", "Leer la respuesta en voz alta");
      rec.foot.append(copy, voice);
      if (last) { const rg = mk("button", "cb-btn", "REGENERAR"); rg.type = "button"; rg.dataset.act = "regen"; rg.setAttribute("aria-label", "Regenerar la respuesta"); rec.foot.appendChild(rg); }
    } else if (rec.role === "user") {
      const copy = mk("button", "cb-btn", "COPIAR"); copy.type = "button"; copy.dataset.act = "copy"; rec.foot.appendChild(copy);
    }
  }
  function refreshFooters() {
    const arr = Array.from(live.values());
    let lastAssistant = null;
    arr.forEach((r) => { if (r.role === "assistant") lastAssistant = r; });
    arr.forEach((r) => { if (r.role !== "tool") footer(r, r === lastAssistant && !busy); });
    el.empty.classList.toggle("gone", arr.length > 0);
  }
  function renderChat(c) {
    chat = c;
    // Un `chat` en mitad del turno no debe perder lo que se está pintando en streaming.
    const pending = Array.from(live.values()).filter((r) => r.streaming);
    live.clear();
    el.msgs.textContent = "";
    if (c) {
      (c.messages || []).forEach((m) => {
        if (m.role === "system") return;
        const rec = newRecord(m.id, m.role, m.at);
        rec.text = m.content || "";
        rec.metrics = m.metrics || null;
        if (m.role === "tool") {
          const card = addCard(rec, m.toolName || "herramienta", m.toolArgs || {});
          card.prog.remove(); card.closed = true; card.card.classList.add("done"); card.state.textContent = "HECHO";
          card.card.querySelector(".cb-toolargs").remove();
          rec.text = "";
          if (m.content) { card.res.textContent = m.content; card.res.hidden = false; }
        } else if (m.toolCalls && m.toolCalls.length) {
          m.toolCalls.forEach((t) => { const cd = addCard(rec, t.name, t.args, false); cd.prog.remove(); cd.closed = true; cd.card.classList.add("done"); cd.state.textContent = "LLAMADA"; });
        }
        (m.images || []).forEach((u) => addImage(rec, u));
        el.msgs.appendChild(rec.root);
        live.set(m.id, rec);
        paint(rec);
      });
    }
    // Red de seguridad: un registro sin nada visible (cascarón de una tool ya cerrada)
    // solo alargaría la conversación y arrastraría el scroll detrás de la respuesta.
    pending.forEach((r) => {
      if (live.has(r.id)) return;
      if (!r.text && !r.thought && !r.cards.length && !r.imgs.childElementCount && r.err.hidden) return;
      el.msgs.appendChild(r.root);
      live.set(r.id, r);
    });
    refreshFooters();
    updateExport();
    toBottom();
  }
  function onEvent(messageId, raw) {
    if (!raw) return;
    const keys = ["delta", "thinking", "toolStart", "toolEnd", "done", "error"];
    const kind = typeof raw.type === "string" ? raw.type : keys.find((k) => k in raw);
    if (!kind) return;
    const pick = (k) => (typeof raw[k] === "string" ? raw[k] : "");
    let rec = live.get(messageId);
    if (!rec) {
      rec = newRecord(messageId, "assistant", Date.now());
      rec.streaming = true;
      el.msgs.appendChild(rec.root);
      live.set(messageId, rec);
      el.empty.classList.add("gone");
    }
    if (kind === "delta") { rec.text += raw.text != null ? raw.text : pick("delta"); rec.streaming = true; schedule(rec); }
    else if (kind === "thinking") { rec.thought += raw.text != null ? raw.text : pick("thinking"); rec.streaming = true; schedule(rec); }
    else if (kind === "toolStart") { addCard(rec, raw.name, raw.args || {}); followScroll(); }
    else if (kind === "toolEnd") {
      const uri = raw.imageUri || (raw.result && raw.result.imageUri);
      closeCard(rec, raw.name, raw.result, raw.error, uri, raw.attachment);
      followScroll();
    } else if (kind === "done") {
      rec.streaming = false; rec.metrics = raw.metrics || null; paint(rec); refreshFooters();
    } else if (kind === "error") {
      rec.streaming = false;
      rec.err.textContent = "ERROR: " + (raw.message || "fallo desconocido");
      rec.err.hidden = false;
      rec.cards.forEach((c) => { if (!c.closed) { c.closed = true; c.prog.remove(); c.card.classList.add("error"); c.state.textContent = "ERROR"; } });
      paint(rec); refreshFooters();
    }
  }

  /* ---------- estado del host ---------- */
  function renderState(s) {
    st = s;
    const caps = s.capabilities || {};
    el.caps.querySelectorAll("[data-cap]").forEach((c) => c.classList.toggle("on", !!caps[c.dataset.cap]));
    // modelos
    el.model.textContent = "";
    (s.models || []).forEach((m) => {
      const o = mk("option", "", m.name + (m.sizeLabel ? " · " + m.sizeLabel : ""));
      o.value = m.name; el.model.appendChild(o);
    });
    if (!(s.models || []).length) { const o = mk("option", "", "Sin modelos"); o.value = ""; el.model.appendChild(o); }
    el.model.value = s.model || "";
    el.autospeak.checked = !!s.autoSpeak;
    // ajustes
    const p = s.params || {};
    if (document.activeElement !== el.system) el.system.value = p.system || "";
    if (document.activeElement !== el.temp) el.temp.value = p.temperature != null ? p.temperature : "";
    if (document.activeElement !== el.ctx) el.ctx.value = p.numCtx ? p.numCtx : "";
    el.tools.textContent = "";
    (s.tools || []).forEach((t) => {
      const li = mk("li", t.available ? "" : "off");
      const lab = mk("label");
      const cb = mk("input"); cb.type = "checkbox"; cb.checked = !!t.on && !!t.available; cb.disabled = !t.available;
      cb.dataset.tool = t.name;
      cb.setAttribute("aria-label", t.label || t.name);
      lab.append(cb, mk("span", "", (t.name === "generar_imagen" ? "GENERAR IMAGEN" : t.label || t.name)));
      li.appendChild(lab);
      if (!t.available) li.title = "El modelo no soporta herramientas";
      el.tools.appendChild(li);
    });
    el.toolsNote.hidden = !(s.tools || []).some((t) => !t.available);
    // bloqueo
    el.lock.hidden = !s.locked;
    el.lockReason.textContent = s.locked ? s.lockReason || "El chatbot no está disponible." : "";
    el.main.classList.toggle("locked", !!s.locked);
    renderChats();
    applyEnabled();
  }
  function renderChats() {
    el.chats.textContent = "";
    const list = (st && st.chats) || [];
    el.chatsEmpty.hidden = list.length > 0;
    list.forEach((c) => {
      const li = mk("li", "cb-chat" + (c.id === st.activeId ? " active" : ""));
      li.dataset.id = c.id;
      li.tabIndex = 0;
      li.setAttribute("aria-label", "Conversación " + c.title);
      if (editing === c.id) {
        const inp = mk("input", "cb-input cb-chat-edit"); inp.value = c.title; inp.maxLength = 80; inp.setAttribute("aria-label", "Nuevo título");
        const finish = (ok) => { const v = inp.value.trim(); editing = null; if (ok && v && v !== c.title) send({ type: "renameChat", id: c.id, title: v }); renderChats(); };
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); e.stopPropagation(); });
        inp.addEventListener("blur", () => { if (editing === c.id) finish(true); });
        li.appendChild(inp);
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
      } else if (pendingDelete === c.id) {
        li.appendChild(mk("div", "cb-chat-title", c.title));
        const row = mk("div", "cb-confirm", "¿BORRAR?");
        const yes = mk("button", "cb-btn danger", "SÍ"); yes.type = "button"; yes.dataset.act = "delyes";
        const no = mk("button", "cb-btn", "NO"); no.type = "button"; no.dataset.act = "delno";
        row.append(yes, no); li.appendChild(row);
      } else {
        li.title = "Doble clic para renombrar";
        li.append(mk("div", "cb-chat-title", c.title || "Sin título"), mk("div", "cb-chat-date", rel(c.updatedAt)));
        const x = mk("button", "cb-chat-del", "✕"); x.type = "button"; x.dataset.act = "del"; x.setAttribute("aria-label", "Borrar conversación"); x.title = "Borrar";
        li.appendChild(x);
      }
      el.chats.appendChild(li);
    });
  }
  function applyEnabled() {
    const locked = !!(st && st.locked);
    const vision = !!(st && st.capabilities && st.capabilities.vision);
    el.text.disabled = locked;
    el.attach.disabled = locked || !vision;
    el.attach.title = vision ? "Adjuntar imágenes" : "El modelo no tiene visión";
    el.send.disabled = locked && !busy;
    el.send.textContent = busy ? "DETENER" : "ENVIAR";
    el.send.classList.toggle("stop", busy);
    el.send.setAttribute("aria-label", busy ? "Detener la respuesta" : "Enviar");
    el.model.disabled = locked || busy;
    el.btnNew.disabled = locked;
    if (!vision && attachments.length) { attachments = []; renderThumbs(); }
  }
  function updateExport() { el.btnExport.disabled = !chat || !(chat.messages || []).length; }

  /* ---------- envío y adjuntos ---------- */
  function send(m) { vscode.postMessage(m); }
  function inputError(t) { el.inputErr.textContent = t || ""; el.inputErr.hidden = !t; }
  function renderThumbs() {
    el.thumbs.textContent = "";
    attachments.forEach((a, i) => {
      const w = mk("div", "cb-thumb");
      const im = mk("img"); im.src = a.dataUrl; im.alt = a.name;
      const x = mk("button", "", "×"); x.type = "button"; x.setAttribute("aria-label", "Quitar " + a.name); x.dataset.i = String(i);
      w.append(im, x); el.thumbs.appendChild(w);
    });
  }
  function addFiles(files) {
    if (!(st && st.capabilities && st.capabilities.vision)) { inputError("El modelo no tiene visión: no admite imágenes."); return; }
    inputError("");
    Array.from(files).forEach((f) => {
      if (attachments.length >= MAX_FILES) return inputError("Máximo " + MAX_FILES + " imágenes por mensaje.");
      if (!OK_TYPES.includes(f.type)) return inputError("«" + f.name + "»: solo PNG, JPEG, WebP o GIF.");
      if (f.size > MAX_BYTES) return inputError("«" + f.name + "» supera los 10 MiB.");
      const r = new FileReader();
      r.onload = () => {
        if (attachments.length >= MAX_FILES) return;
        attachments.push({ name: f.name || "imagen", dataUrl: String(r.result) });
        renderThumbs();
      };
      r.onerror = () => inputError("No se pudo leer «" + f.name + "».");
      r.readAsDataURL(f);
    });
  }
  function submit(textOverride) {
    if (busy) { send({ type: "stop" }); return; }
    if (st && st.locked) return;
    const text = (textOverride != null ? textOverride : el.text.value).trim();
    if (!text && !attachments.length) return;
    const msg = { type: "send", text };
    if (attachments.length) msg.attachments = attachments.map((a) => ({ name: a.name, dataUrl: a.dataUrl }));
    send(msg);
    el.text.value = ""; attachments = []; renderThumbs(); inputError("");
    ui.draft = ""; saveUi(); grow(); stick = true;
  }
  function grow() { el.text.style.height = "auto"; el.text.style.height = Math.min(el.text.scrollHeight, 200) + "px"; }

  /* ---------- eventos de la UI ---------- */
  el.send.addEventListener("click", () => submit());
  el.text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  el.text.addEventListener("input", () => { grow(); ui.draft = el.text.value; saveUi(); });
  el.text.addEventListener("paste", (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  ["dragenter", "dragover"].forEach((n) => el.compose.addEventListener(n, (e) => { e.preventDefault(); el.compose.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((n) => el.compose.addEventListener(n, (e) => { e.preventDefault(); el.compose.classList.remove("dragover"); }));
  el.compose.addEventListener("drop", (e) => { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  el.attach.addEventListener("click", () => el.file.click());
  el.file.addEventListener("change", () => { addFiles(el.file.files); el.file.value = ""; });
  el.thumbs.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (b) { attachments.splice(Number(b.dataset.i), 1); renderThumbs(); }
  });

  el.btnNew.addEventListener("click", () => send({ type: "newChat" }));
  el.btnExport.addEventListener("click", () => send({ type: "export" }));
  el.autospeak.addEventListener("change", () => send({ type: "setAutoSpeak", on: el.autospeak.checked }));
  el.model.addEventListener("change", () => { if (el.model.value) send({ type: "setModel", model: el.model.value }); });
  el.btnSide.addEventListener("click", () => { ui.side = !ui.side; saveUi(); applyFold(); });
  el.btnSettings.addEventListener("click", () => { ui.settings = !ui.settings; saveUi(); applyFold(); });
  function applyFold() {
    el.side.hidden = !ui.side;
    el.btnSide.setAttribute("aria-expanded", String(!!ui.side));
    el.settings.hidden = !ui.settings;
    el.btnSettings.setAttribute("aria-expanded", String(!!ui.settings));
  }

  let paramsTimer = null;
  function pushParams() {
    clearTimeout(paramsTimer);
    paramsTimer = setTimeout(() => {
      let t = parseFloat(el.temp.value);
      if (!isFinite(t)) t = 0.8;
      t = Math.min(2, Math.max(0, t));
      let n = parseInt(el.ctx.value, 10);
      if (!isFinite(n) || n <= 0) n = 0;
      else if (n < 256) n = 256;
      send({ type: "setParams", system: el.system.value, temperature: t, numCtx: n });
    }, 400);
  }
  [el.system, el.temp, el.ctx].forEach((n) => n.addEventListener("input", pushParams));
  el.tools.addEventListener("change", (e) => {
    const c = e.target.closest("input[data-tool]");
    if (c) send({ type: "setTool", name: c.dataset.tool, on: c.checked });
  });

  el.chats.addEventListener("click", (e) => {
    const li = e.target.closest(".cb-chat");
    if (!li) return;
    const id = li.dataset.id;
    const act = e.target.closest("[data-act]");
    if (act) {
      e.stopPropagation();
      if (act.dataset.act === "del") { pendingDelete = id; renderChats(); }
      else if (act.dataset.act === "delno") { pendingDelete = null; renderChats(); }
      else if (act.dataset.act === "delyes") { pendingDelete = null; send({ type: "deleteChat", id }); }
      return;
    }
    if (editing === id || pendingDelete === id) return;
    if (!st || id !== st.activeId) send({ type: "openChat", id });
  });
  el.chats.addEventListener("dblclick", (e) => {
    const li = e.target.closest(".cb-chat");
    if (li && !e.target.closest("[data-act]")) { editing = li.dataset.id; renderChats(); }
  });
  el.chats.addEventListener("keydown", (e) => {
    const li = e.target.closest(".cb-chat");
    if (li && e.target === li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); if (!st || li.dataset.id !== st.activeId) send({ type: "openChat", id: li.dataset.id }); }
    else if (li && e.target === li && e.key === "F2") { editing = li.dataset.id; renderChats(); }
  });

  el.msgs.addEventListener("click", (e) => {
    const img = e.target.closest(".cb-img");
    if (img) { send({ type: "openFile", file: img.dataset.file }); return; }
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const root = b.closest(".cb-msg");
    const rec = root && live.get(root.dataset.id);
    const act = b.dataset.act;
    if (act === "copycode") { send({ type: "copy", text: b.closest(".cb-code").querySelector("pre").textContent }); b.textContent = "COPIADO"; setTimeout(() => (b.textContent = "COPIAR"), 1200); }
    else if (act === "copy" && rec) send({ type: "copy", text: rec.text });
    else if (act === "speak" && rec) send({ type: "speak", id: rec.id });
    else if (act === "regen") send({ type: "regenerate" });
    else if (act === "openfile") send({ type: "openFile", file: b.dataset.file });
  });
  el.msgs.addEventListener("keydown", (e) => {
    const img = e.target.closest && e.target.closest(".cb-img");
    if (img && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); send({ type: "openFile", file: img.dataset.file }); }
  });
  el.scroll.addEventListener("scroll", () => { stick = nearBottom(); el.bottom.hidden = stick; });
  el.bottom.addEventListener("click", toBottom);

  SUGGESTIONS.forEach((s) => {
    const b = mk("button", "cb-sug", s); b.type = "button";
    b.addEventListener("click", () => submit(s));
    el.sugs.appendChild(b);
  });

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.type === "state" && m.state) renderState(m.state);
    else if (m.type === "chat") renderChat(m.chat || null);
    else if (m.type === "event") onEvent(m.messageId, m.event);
    else if (m.type === "busy") { busy = !!m.on; applyEnabled(); refreshFooters(); if (!busy) live.forEach((r) => { if (r.streaming) { r.streaming = false; paint(r); } }); }
  });

  el.text.value = ui.draft || "";
  applyFold();
  grow();
  send({ type: "ready" });
})();
