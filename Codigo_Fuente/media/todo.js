/* ALFRED // TO_DO — lista de tareas compartida con la IA (vía MCP).
   El host manda `state` ({tareas, proyectos, ahora}) cada vez que cambia el fichero y `notice`;
   de aquí salen `ready` y las acciones setEstado, mover, moverA, setProyecto, borrar, finalizar
   y refresh. Todo lo que viene del host (descripciones, rutas) entra por textContent: lo escribe
   una IA y no es de fiar. */
(function () {
  "use strict";

  const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

  const ESTADOS = [
    ["nuevoIA", "NuevoIA"],
    ["nuevoUsu", "NuevoUsu"],
    ["pendiente", "Pendiente"],
    ["trabajando", "Trabajando"],
    ["revisa", "Revisa"],
    ["finalizado", "Finalizado"],
  ];
  const LABEL = Object.fromEntries(ESTADOS);
  const TODOS = "*";

  const el = {
    count: document.getElementById("count"),
    notice: document.getElementById("notice"),
    project: document.getElementById("flt-project"),
    chips: document.getElementById("flt-estados"),
    group: document.getElementById("btn-group"),
    list: document.getElementById("list"),
    empty: document.getElementById("empty"),
    modal: document.getElementById("modal"),
    modalText: document.getElementById("modal-text"),
    modalOk: document.getElementById("modal-ok"),
    modalCancel: document.getElementById("modal-cancel"),
  };

  const saved = (api && api.getState && api.getState()) || {};
  const S = {
    tareas: [],
    proyectos: [],
    proyecto: typeof saved.proyecto === "string" ? saved.proyecto : TODOS,
    estados: new Set(Array.isArray(saved.estados) ? saved.estados.filter((e) => LABEL[e]) : []),
    agrupar: saved.agrupar === true,
    expandidas: new Set(),
    autoExp: new Set(),
    drag: null,
    pendiente: false,
    firma: "",
    borrando: null,
    noticeTimer: 0,
  };

  function send(msg) {
    if (api) api.postMessage(msg);
  }
  function act(action) {
    send({ type: "action", action });
  }
  function persist() {
    if (api && api.setState) {
      api.setState({ proyecto: S.proyecto, estados: [...S.estados], agrupar: S.agrupar });
    }
  }

  /** Misma normalización que `mismoProyecto` del host (separadores, caja, barra final). */
  function norm(p) {
    let s = String(p || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/");
    if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
    return s.toLowerCase();
  }

  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function proyectoLabel(p) {
    return p ? p : "(sin proyecto)";
  }

  /* ── Datos derivados ─────────────────────────────────── */
  function porProyecto() {
    if (S.proyecto === TODOS) return S.tareas;
    const n = norm(S.proyecto);
    return S.tareas.filter((t) => norm(t.proyecto) === n);
  }

  function visibles() {
    let v = porProyecto();
    if (S.estados.size) v = v.filter((t) => S.estados.has(t.estado));
    if (S.agrupar) {
      const orden = [];
      for (const t of v) {
        const k = norm(t.proyecto);
        if (!orden.includes(k)) orden.push(k);
      }
      v = v
        .map((t, i) => ({ t, i, g: orden.indexOf(norm(t.proyecto)) }))
        .sort((a, b) => a.g - b.g || a.i - b.i)
        .map((x) => x.t);
    }
    return v;
  }

  function firmaDe(vis) {
    return JSON.stringify([
      S.proyecto,
      [...S.estados],
      S.agrupar,
      S.proyectos,
      S.tareas.length,
      vis.map((t) => [t.id, t.estado, t.origen, t.proyecto, t.nota, t.nombre, t.fecha, t.descripcion.length]),
      ESTADOS.map(([e]) => porProyecto().filter((t) => t.estado === e).length),
    ]);
  }

  /* ── Pintado ─────────────────────────────────────────── */
  function render(forzar) {
    if (S.drag) {
      S.pendiente = true;
      return;
    }
    const vis = visibles();
    const firma = firmaDe(vis);
    if (!forzar && firma === S.firma) return;
    S.firma = firma;
    S.pendiente = false;

    const scroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
    pintarCabecera();
    pintarFiltros();
    el.list.textContent = "";

    let grupoActual = null;
    for (const t of vis) {
      if (S.agrupar && norm(t.proyecto) !== grupoActual) {
        grupoActual = norm(t.proyecto);
        el.list.appendChild(h("h3", "group-title", proyectoLabel(t.proyecto)));
      }
      el.list.appendChild(ficha(t));
    }

    if (!vis.length) {
      el.empty.hidden = false;
      el.empty.textContent = S.tareas.length
        ? "Ninguna tarea coincide con los filtros."
        : "No hay tareas todavía. Entran desde el botón «A TO_DO» del bloc de dictado o las crea la IA por MCP. " +
          "La IA solo ve las que estén en Pendiente: pasa una tarea a Pendiente para dársela.";
    } else {
      el.empty.hidden = true;
    }
    if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
  }

  function pintarCabecera() {
    const total = S.tareas.length;
    const vis = visibles().length;
    el.count.textContent = vis === total ? String(total) : vis + " / " + total;
    el.group.setAttribute("aria-pressed", String(S.agrupar));
  }

  function pintarFiltros() {
    // Dropdown de proyecto
    const sin = S.tareas.some((t) => !t.proyecto);
    const ops = [[TODOS, "Todos"]];
    for (const p of S.proyectos) ops.push([p, p]);
    if (sin) ops.push(["", "(sin proyecto)"]);
    if (!ops.some(([v]) => v === S.proyecto)) S.proyecto = TODOS;
    el.project.textContent = "";
    for (const [v, txt] of ops) {
      const o = h("option", "", txt);
      o.value = v;
      el.project.appendChild(o);
    }
    el.project.value = S.proyecto;

    // Chips de estado, con contador dentro del proyecto elegido
    const base = porProyecto();
    el.chips.textContent = "";
    for (const [e, etiqueta] of ESTADOS) {
      const b = h("button", "fchip e-" + e);
      b.type = "button";
      b.dataset.estado = e;
      b.setAttribute("aria-pressed", String(S.estados.has(e)));
      b.title = "Filtrar por " + etiqueta;
      b.setAttribute("aria-label", "Filtrar por " + etiqueta);
      b.appendChild(document.createTextNode(etiqueta));
      b.appendChild(h("span", "n", String(base.filter((t) => t.estado === e).length)));
      el.chips.appendChild(b);
    }
  }

  /** Propuesta de la IA que el usuario aún no ha activado. */
  function esIAsinRevisar(t) {
    return t.origen === "ia" && (t.estado === "nuevoIA" || t.estado === "pendiente");
  }

  function ficha(t) {
    const card = h("article", "card e-" + t.estado + (t.estado === "finalizado" ? " finalizado" : ""));
    card.dataset.id = t.id;

    const row = h("div", "row");

    const handle = h("span", "handle", "⋮⋮");
    handle.title = "Arrastrar para reordenar";
    handle.setAttribute("aria-label", "Arrastrar para reordenar");
    row.appendChild(handle);

    const chk = h("input", "chk");
    chk.type = "checkbox";
    chk.checked = t.estado === "finalizado";
    chk.title = "Marcar como finalizada";
    chk.setAttribute("aria-label", "Marcar como finalizada");
    chk.dataset.role = "chk";
    row.appendChild(chk);

    const nombre = h("span", "nombre", t.nombre);
    nombre.title = t.nombre;
    row.appendChild(nombre);

    if (esIAsinRevisar(t)) {
      const ia = h("span", "chip-ia", "CREADA POR IA");
      ia.title = "La propuso la IA: revisa el texto antes de pasarla a Pendiente";
      row.appendChild(ia);
    }

    const sel = h("select", "td-select estado e-" + t.estado);
    sel.dataset.role = "estado";
    sel.title = "Estado de la tarea";
    sel.setAttribute("aria-label", "Estado de la tarea");
    for (const [e, etiqueta] of ESTADOS) {
      // «Finalizado» solo se marca con el check: aparece únicamente si ya lo está.
      if (e === "finalizado" && t.estado !== "finalizado") continue;
      const o = h("option", "", etiqueta);
      o.value = e;
      if (e === "finalizado") o.disabled = true;
      sel.appendChild(o);
    }
    sel.value = t.estado;
    row.appendChild(sel);

    const proy = h("select", "td-select proyecto");
    proy.dataset.role = "proyecto";
    proy.title = t.proyecto ? "Proyecto: " + t.proyecto : "Sin proyecto";
    proy.setAttribute("aria-label", "Proyecto de la tarea");
    const conocidos = S.proyectos.slice();
    if (t.proyecto && !conocidos.includes(t.proyecto)) conocidos.push(t.proyecto);
    const o0 = h("option", "", "(sin proyecto)");
    o0.value = "";
    proy.appendChild(o0);
    for (const p of conocidos) {
      const o = h("option", "", p);
      o.value = p;
      proy.appendChild(o);
    }
    proy.value = t.proyecto;
    row.appendChild(proy);

    row.appendChild(h("span", "fecha", new Date(t.fecha).toLocaleString()));

    const acc = h("span", "acciones");
    acc.appendChild(mini("up", "↑", "Subir"));
    acc.appendChild(mini("down", "↓", "Bajar"));
    acc.appendChild(mini("del del", "✕", "Borrar la tarea"));
    row.appendChild(acc);
    card.appendChild(row);

    const det = h("div", "detalle");
    det.hidden = !S.expandidas.has(t.id);
    det.appendChild(h("pre", "desc", t.descripcion));
    if (t.nota) {
      const n = h("p", "nota");
      n.appendChild(h("b", "", "NOTA DE LA IA "));
      n.appendChild(document.createTextNode(t.nota));
      det.appendChild(n);
    }
    card.appendChild(det);
    return card;
  }

  function mini(role, glyph, title) {
    const b = h("button", "mini", glyph);
    b.type = "button";
    b.dataset.role = role.split(" ")[0];
    b.title = title;
    b.setAttribute("aria-label", title);
    return b;
  }

  /* ── Eventos de la lista ─────────────────────────────── */
  function cardOf(node) {
    return node && node.closest ? node.closest(".card") : null;
  }

  el.list.addEventListener("click", (ev) => {
    const card = cardOf(ev.target);
    if (!card) return;
    const id = card.dataset.id;
    const rol = ev.target.dataset && ev.target.dataset.role;
    if (rol === "up" || rol === "down") {
      const msg = { type: "mover", id, delta: rol === "up" ? -1 : 1 };
      if (S.proyecto !== TODOS) msg.proyecto = S.proyecto;
      act(msg);
      return;
    }
    if (rol === "del") {
      pedirBorrar(id);
      return;
    }
    if (ev.target.closest("select, input, button, .handle")) return;
    const det = card.querySelector(".detalle");
    if (!det) return;
    det.hidden = !det.hidden;
    if (det.hidden) S.expandidas.delete(id);
    else S.expandidas.add(id);
  });

  el.list.addEventListener("change", (ev) => {
    const card = cardOf(ev.target);
    if (!card) return;
    const id = card.dataset.id;
    const rol = ev.target.dataset && ev.target.dataset.role;
    if (rol === "chk") act({ type: "finalizar", id, hecho: ev.target.checked });
    else if (rol === "estado") act({ type: "setEstado", id, estado: ev.target.value });
    else if (rol === "proyecto") act({ type: "setProyecto", id, proyecto: ev.target.value });
  });

  /* ── Arrastrar y soltar ──────────────────────────────── */
  el.list.addEventListener("mousedown", (ev) => {
    const handle = ev.target.closest && ev.target.closest(".handle");
    const card = cardOf(ev.target);
    if (card) card.draggable = !!handle;
  });

  el.list.addEventListener("dragstart", (ev) => {
    const card = cardOf(ev.target);
    if (!card || !card.draggable) {
      ev.preventDefault();
      return;
    }
    S.drag = card.dataset.id;
    card.classList.add("dragging");
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", S.drag);
    }
  });

  function limpiarIndicador() {
    for (const c of el.list.querySelectorAll(".drop-before, .drop-after")) {
      c.classList.remove("drop-before", "drop-after");
    }
  }

  function despuesDe(card, ev) {
    const r = card.getBoundingClientRect();
    return ev.clientY > r.top + r.height / 2;
  }

  el.list.addEventListener("dragover", (ev) => {
    if (!S.drag) return;
    const card = cardOf(ev.target);
    if (!card || card.dataset.id === S.drag) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    limpiarIndicador();
    card.classList.add(despuesDe(card, ev) ? "drop-after" : "drop-before");
  });

  el.list.addEventListener("drop", (ev) => {
    if (!S.drag) return;
    const card = cardOf(ev.target);
    if (!card || card.dataset.id === S.drag) return;
    ev.preventDefault();
    const origen = S.tareas.findIndex((t) => t.id === S.drag);
    const j = S.tareas.findIndex((t) => t.id === card.dataset.id);
    if (origen < 0 || j < 0) return;
    // Índice global donde queda la tarea tras quitarla de su sitio y colocarla junto al destino.
    const despues = despuesDe(card, ev);
    let destino = despues ? j + 1 : j;
    if (origen < destino) destino -= 1;
    if (destino !== origen) act({ type: "moverA", id: S.drag, destino });
  });

  el.list.addEventListener("dragend", () => {
    for (const c of el.list.querySelectorAll(".card")) {
      c.classList.remove("dragging");
      c.draggable = false;
    }
    limpiarIndicador();
    S.drag = null;
    if (S.pendiente) render(false);
  });

  /* ── Barra de herramientas ───────────────────────────── */
  el.project.addEventListener("change", () => {
    S.proyecto = el.project.value;
    persist();
    render(true);
  });

  el.chips.addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest(".fchip");
    if (!b) return;
    const e = b.dataset.estado;
    if (S.estados.has(e)) S.estados.delete(e);
    else S.estados.add(e);
    persist();
    render(true);
  });

  el.group.addEventListener("click", () => {
    S.agrupar = !S.agrupar;
    persist();
    render(true);
  });

  /* ── Borrado con modal propio ────────────────────────── */
  function pedirBorrar(id) {
    const t = S.tareas.find((x) => x.id === id);
    if (!t) return;
    S.borrando = id;
    el.modalText.textContent = "¿Borrar «" + t.nombre + "»? No se puede deshacer.";
    el.modal.hidden = false;
    el.modalCancel.focus();
  }
  function cerrarModal() {
    S.borrando = null;
    el.modal.hidden = true;
  }
  el.modalCancel.addEventListener("click", cerrarModal);
  el.modal.addEventListener("click", (ev) => {
    if (ev.target === el.modal) cerrarModal();
  });
  el.modalOk.addEventListener("click", () => {
    if (S.borrando) act({ type: "borrar", id: S.borrando });
    cerrarModal();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !el.modal.hidden) cerrarModal();
  });

  /* ── Mensajes del host ───────────────────────────────── */
  /** Un fallo (`error`) se queda hasta cerrarlo con ×; el resto se oculta a los 8 s. */
  function aviso(text, error) {
    el.notice.textContent = "";
    el.notice.appendChild(h("span", "", text));
    clearTimeout(S.noticeTimer);
    if (error) {
      const x = h("button", "notice-x", "×");
      x.type = "button";
      x.title = "Cerrar el aviso";
      x.setAttribute("aria-label", "Cerrar el aviso");
      x.addEventListener("click", () => {
        el.notice.hidden = true;
      });
      el.notice.appendChild(x);
    } else {
      S.noticeTimer = setTimeout(() => {
        el.notice.hidden = true;
      }, 8000);
    }
    el.notice.hidden = false;
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "state") {
      S.tareas = Array.isArray(msg.tareas) ? msg.tareas : [];
      S.proyectos = Array.isArray(msg.proyectos) ? msg.proyectos : [];
      // Las propuestas de la IA nacen con la descripción desplegada, una sola vez por tarea.
      for (const t of S.tareas) {
        if (esIAsinRevisar(t) && !S.autoExp.has(t.id)) {
          S.autoExp.add(t.id);
          S.expandidas.add(t.id);
        }
      }
      render(false);
    } else if (msg.type === "notice" && typeof msg.text === "string") {
      aviso(msg.text, msg.error === true);
      // Selects y checks ya cambiados en pantalla vuelven al valor real del fichero.
      if (msg.error === true) render(true);
    }
  });

  send({ type: "ready" });
})();
