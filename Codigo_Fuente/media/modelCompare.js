/* ALFRED // COMPARAR MODELOS — lista de modelos favoritos, dos huecos de
   comparación con arrastrar-y-soltar y fichas selladas con su fecha.
   El host manda `init` (lista + caché + clave de BenchLM + alias guardados),
   `compared` (fichas recién tomadas), `aliased` (alias guardado y su ficha) y
   `busy`; de aquí salen `ready` y las acciones `compare`, `setAlias`,
   `benchlmKey` y `openBenchlm`. */
(function () {
  "use strict";

  // Sin acquireVsCodeApi (arnés de prueba) el panel sigue pintando con datos falsos.
  const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

  const el = {
    status: document.getElementById("status"),
    run: document.getElementById("btn-compare-run"),
    notice: document.getElementById("notice"),
    list: document.getElementById("model-list"),
    rows: document.getElementById("model-rows"),
    listEmpty: document.getElementById("list-empty"),
    count: document.getElementById("models-count"),
    benchKey: document.getElementById("btn-benchlm-key"),
    benchSite: document.getElementById("btn-benchlm-site"),
    slots: [
      {
        root: document.getElementById("slot-a"),
        key: document.getElementById("slot-a-key"),
        clear: document.getElementById("slot-a-clear"),
        body: document.getElementById("slot-a-body"),
      },
      {
        root: document.getElementById("slot-b"),
        key: document.getElementById("slot-b-key"),
        clear: document.getElementById("slot-b-clear"),
        body: document.getElementById("slot-b-body"),
      },
    ],
  };

  const state = {
    /** Lista que manda el host (los favoritos del tablero de asignación). */
    models: [],
    byKey: new Map(),
    /** Caché de fichas por key: `cache[key]` es un ModelSheet o no está. */
    cache: {},
    slots: [huevoSlot(), huevoSlot()],
    /** Alias de BenchLM por clave de modelo: `aliases[key]` es el identificador guardado. */
    aliases: {},
    /** Keys con un alias en vuelo: la fila de alias se pinta deshabilitada y con BUSCANDO… */
    aliasEspera: new Set(),
    /** Hay clave de BenchLM guardada en el host. Decide qué se ofrece en la ficha. */
    benchlmKey: false,
    busy: false,
    error: "",
    /** Keys con las que se lanzó la comparación en vuelo: si el usuario cambió un
       hueco mientras, la ficha que llega no es suya y no se pinta encima. */
    peticion: null,
    /** Primer `init` ya aplicado: ahí se leen los huecos guardados. */
    cargado: false,
  };

  /** Temporizadores de los alias en vuelo, para que un host mudo no deje el botón en BUSCANDO… */
  const esperas = new Map();

  /** Tope del alias: el mismo que `MAX_ALIAS` en el host (`src/benchlm/aliases.ts`). */
  const MAX_ALIAS = 200;

  function send(message) {
    if (api) {
      api.postMessage(message);
    }
  }

  /** Acción del panel hacia el host (compare, benchlmKey, openBenchlm). */
  function actua(action) {
    send({ type: "action", action: action });
  }

  function guarda() {
    if (api && typeof api.setState === "function") {
      api.setState({ keys: [state.slots[0].key, state.slots[1].key] });
    }
  }

  function leido() {
    const s = api && typeof api.getState === "function" ? api.getState() : null;
    return s && Array.isArray(s.keys) ? s.keys : [];
  }

  function huevoSlot() {
    return { key: null, sheet: null, freshAt: 0, missing: false };
  }

  /** Hueco ocupado por una key: con su ficha de caché si la hay. */
  function slotCon(key) {
    return { key: key, sheet: ficha(cacheOf(key)), freshAt: 0, missing: false };
  }

  function esModelo(m) {
    return !!m && typeof m === "object" && typeof m.key === "string" && m.key !== "";
  }

  function ficha(v) {
    return v && typeof v === "object" ? v : null;
  }

  function cacheOf(key) {
    return typeof key === "string" ? ficha(state.cache[key]) : null;
  }

  function texto(v) {
    return typeof v === "string" && v.trim() !== "" ? v : null;
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /* ── Formato ────────────────────────────────────────── */

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  /** `03/11/2026` */
  function fmtFecha(ts) {
    const d = new Date(ts);
    return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear();
  }

  /** `03/11/2026 14:32` */
  function fmtFechaHora(ts) {
    const d = new Date(ts);
    return fmtFecha(ts) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  /** Relativo en español: `hace 3 h`, `hace 2 días`. */
  function fmtRelativo(ts) {
    const t = num(ts);
    if (t === null || t <= 0) return null;
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "hace unos segundos";
    const m = Math.round(s / 60);
    if (m < 60) return "hace " + m + " min";
    const h = Math.round(m / 60);
    if (h < 24) return "hace " + h + (h === 1 ? " hora" : " h");
    const d = Math.round(h / 24);
    if (d < 31) return "hace " + d + (d === 1 ? " día" : " días");
    const mes = Math.round(d / 30);
    if (mes < 12) return "hace " + mes + (mes === 1 ? " mes" : " meses");
    const a = Math.round(mes / 12);
    return "hace " + a + (a === 1 ? " año" : " años");
  }

  /** Entero con punto de millar: `131.072`. */
  function fmtMiles(v) {
    const n = num(v);
    if (n === null || n < 0) return null;
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  /** Dólares por millón: `$0`, `$0.0012`, `$3.20`. */
  function fmtDolar(v) {
    const n = num(v);
    if (n === null) return null;
    if (n <= 0) return "$0";
    if (n < 0.0001) return "<$0.0001";
    if (n < 1) return "$" + n.toFixed(4);
    return "$" + n.toFixed(2);
  }

  /** Una coma decimal y agrupación es-ES: `86,3`, `146,7`, `1.048`. */
  const fmtNum = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });

  function fmtScore(v) {
    const n = num(v);
    return n === null ? null : fmtNum.format(n);
  }

  function fmtLista(arr) {
    if (!Array.isArray(arr)) return null;
    const partes = arr.map((x) => texto(x)).filter((x) => x !== null);
    return partes.length ? partes.join(", ") : null;
  }

  /* ── Nodos ──────────────────────────────────────────── */

  function nodo(clase, textoNode) {
    const n = document.createElement("span");
    n.className = clase;
    n.textContent = textoNode;
    return n;
  }

  function chip(clase, etiqueta, titulo) {
    const c = nodo("chip " + clase, etiqueta);
    if (titulo) c.title = titulo;
    return c;
  }

  function pista(msg, mala) {
    const p = document.createElement("p");
    p.className = mala ? "mc-hint bad" : "mc-hint";
    p.textContent = msg;
    return p;
  }

  /* ── Cabecera y aviso ───────────────────────────────── */

  function renderHeader() {
    const llenos = !!state.slots[0].key && !!state.slots[1].key;
    el.run.disabled = state.busy || !llenos;
    el.status.hidden = !state.busy;
    el.status.className = state.busy ? "hud-status busy" : "hud-status";
    if (state.busy) {
      el.status.textContent = "Tomando datos…";
    }
  }

  /** Botón de llave: dice si hay clave guardada sin abrir un formulario desde aquí. */
  function renderBenchKey() {
    const titulo = state.benchlmKey
      ? "Clave de BenchLM configurada: pulsa para cambiarla"
      : "Clave de BenchLM";
    el.benchKey.title = titulo;
    el.benchKey.setAttribute("aria-label", titulo);
    el.benchKey.classList.toggle("set", state.benchlmKey);
  }

  function renderNotice() {
    el.notice.hidden = !state.error;
    if (state.error) {
      el.notice.textContent = state.error;
    }
  }

  function setBusy(on) {
    state.busy = !!on;
    if (!state.busy) {
      state.peticion = null;
    }
    renderHeader();
    renderNotice();
  }

  /* ── Lista de la izquierda ──────────────────────────── */

  function filaModelo(m) {
    const row = document.createElement("div");
    row.className = "mrow";
    row.draggable = true;
    row.dataset.key = m.key;
    row.appendChild(nodo("mrow-name", texto(m.name) || m.key));
    if (texto(m.name) && m.name !== m.key) {
      const k = nodo("mrow-key", m.key);
      row.appendChild(k);
    }
    if (m.free === true) {
      row.appendChild(chip("free", "FREE", "Modelo gratuito"));
    }
    const proveedor = texto(m.provider);
    const id = texto(m.id);
    row.title = [proveedor, id || m.key].filter(Boolean).join(" · ");
    return row;
  }

  function renderList() {
    const top = el.list.scrollTop;
    el.rows.textContent = "";
    const frag = document.createDocumentFragment();
    for (const m of state.models) {
      frag.appendChild(filaModelo(m));
    }
    el.rows.appendChild(frag);
    el.count.textContent = state.models.length ? String(state.models.length) : "";
    el.listEmpty.hidden = state.models.length > 0;
    el.list.scrollTop = top;
  }

  /* ── Ficha ──────────────────────────────────────────── */

  function celdaLabel(txt) {
    const th = document.createElement("th");
    th.scope = "row";
    th.className = "sheet-label";
    th.textContent = txt;
    return th;
  }

  /** Fila rótulo/valor. `valor` null o vacío deja la raya en color apagado. */
  function fila(txt, valor, extra, titulo) {
    const tr = document.createElement("tr");
    tr.appendChild(celdaLabel(txt));
    const td = document.createElement("td");
    const v = texto(valor);
    if (v === null) {
      td.className = "sheet-value none";
      td.textContent = "—";
    } else {
      td.className = "sheet-value" + (extra ? " " + extra : "");
      td.textContent = v;
      if (titulo) td.title = titulo;
    }
    tr.appendChild(td);
    return tr;
  }

  function filaNumero(txt, v, unidad) {
    const n = num(v);
    const formateado = n === null ? null : fmtMiles(n);
    return fila(txt, formateado, null, n === null ? "" : n.toLocaleString("es-ES") + " " + unidad);
  }

  function filaSiNo(txt, v) {
    if (typeof v !== "boolean") return fila(txt, null);
    return fila(txt, v ? "SÍ" : "NO", v ? "yes" : "no");
  }

  function seccion(txt) {
    const tr = document.createElement("tr");
    tr.className = "sec";
    const th = document.createElement("th");
    th.colSpan = 2;
    th.textContent = txt;
    tr.appendChild(th);
    return tr;
  }

  /** Sello de la ficha: lo recién comparado lleva fecha y hora; lo de caché, relativo. */
  function sello(slot) {
    if (slot.freshAt > 0) {
      return {
        txt: "ACTUALIZADO · " + fmtFechaHora(slot.freshAt),
        titulo: "Datos tomados del catálogo vivo",
        fresco: true,
      };
    }
    const f = num(slot.sheet && slot.sheet.fetchedAt);
    if (f === null || f <= 0) return null;
    return {
      txt: "EN CACHÉ · " + (fmtRelativo(f) || fmtFecha(f)),
      titulo: "Datos de " + fmtFechaHora(f),
      fresco: false,
    };
  }

  /* ── BenchLM: lo más importante de la ficha ─────────── */

  /** Una de las cuatro cifras: puesto `#n` y puntuación grande sobre 100. */
  function cifra(etiqueta, datos) {
    const d = ficha(datos) || {};
    const caja = document.createElement("div");
    caja.className = "bench-stat";

    const l = nodo("bench-stat-label", etiqueta);
    caja.appendChild(l);

    const s = fmtScore(d.score);
    const v = nodo("bench-score", s === null ? "—" : s);
    if (s === null) {
      v.classList.add("none");
    } else {
      v.title = etiqueta + ": puntuación sobre 100";
    }
    caja.appendChild(v);

    const r = num(d.rank);
    const p = nodo("bench-puesto", r === null ? "sin puesto" : "#" + Math.round(r));
    if (r === null) p.classList.add("none");
    caja.appendChild(p);
    return caja;
  }

  function filaExamen(ex) {
    const e = ficha(ex) || {};
    const tr = document.createElement("tr");

    const tdCat = document.createElement("td");
    const cat = texto(e.category);
    if (cat === null) {
      tdCat.textContent = "—";
      tdCat.className = "bench-cat none";
    } else {
      tdCat.className = "bench-cat";
      tdCat.appendChild(chip("bench-cat-chip", cat));
    }
    tr.appendChild(tdCat);

    const tdNom = document.createElement("td");
    const nom = texto(e.name);
    tdNom.className = "bench-name";
    tdNom.textContent = nom === null ? "—" : nom;
    if (nom !== null) tdNom.title = nom;
    tr.appendChild(tdNom);

    const tdScore = document.createElement("td");
    const sc = fmtScore(e.score);
    tdScore.className = "bench-score-cell" + (sc === null ? " none" : "");
    const unidad = texto(e.unit);
    tdScore.textContent = sc === null ? "—" : sc + (unidad ? " " + unidad : "");
    tr.appendChild(tdScore);
    return tr;
  }

  /* ── Alias de BenchLM: el identificador cuando la búsqueda automática falla ── */

  /** Alias guardado de una clave de modelo; "" si no hay. */
  function aliasDe(key) {
    const v = typeof key === "string" ? state.aliases[key] : null;
    return typeof v === "string" ? v : "";
  }

  /** Marca o desmarca un alias en vuelo. `true` arranca el tope de espera. */
  function marcarEspera(key, on) {
    const previo = esperas.get(key);
    if (previo !== undefined) {
      clearTimeout(previo);
      esperas.delete(key);
    }
    if (!on) {
      state.aliasEspera.delete(key);
      return;
    }
    state.aliasEspera.add(key);
    esperas.set(
      key,
      setTimeout(() => {
        esperas.delete(key);
        state.aliasEspera.delete(key);
        renderSlots();
      }, 20000)
    );
  }

  /** Un `init` o un `aliased` cierran todas las esperas: el host ya contestó. */
  function limpiaEsperas() {
    for (const key of [...esperas.keys()]) {
      clearTimeout(esperas.get(key));
    }
    esperas.clear();
    state.aliasEspera.clear();
  }

  /**
   * Fila del alias: SIEMPRE visible, también con «sin coincidencia» o sin clave de BenchLM,
   * que son justo los casos en los que hace falta. Enter en el input hace lo mismo que BUSCAR.
   */
  function filaAlias(sheet) {
    const key = texto(sheet.key) || "";

    const caja = document.createElement("form");
    caja.className = "bench-alias";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "bench-alias-input";
    input.value = aliasDe(key);
    input.placeholder = "alias en BenchLM";
    input.title =
      "Identificador del modelo en BenchLM (por ejemplo claude-sonnet-4-5, " +
      "o la URL de su ficha). Vacío y BUSCAR vuelve a la búsqueda automática.";
    input.setAttribute("aria-label", "Alias del modelo en BenchLM");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.maxLength = MAX_ALIAS;
    caja.appendChild(input);

    const boton = document.createElement("button");
    boton.type = "submit";
    boton.className = "ghost-btn bench-alias-btn";
    boton.textContent = "BUSCAR";
    boton.title = "Guardar el alias y consultar BenchLM con él";
    caja.appendChild(boton);

    const esperando = key !== "" && state.aliasEspera.has(key);
    const pintarEspera = (on) => {
      input.disabled = on;
      boton.disabled = on;
      boton.textContent = on ? "BUSCANDO…" : "BUSCAR";
    };
    pintarEspera(esperando);

    caja.addEventListener("submit", (event) => {
      event.preventDefault();
      // Sin clave de modelo no hay a qué atar el alias.
      if (!key || state.aliasEspera.has(key)) return;
      pintarEspera(true);
      marcarEspera(key, true);
      actua({ type: "setAlias", key: key, alias: input.value.trim() });
    });
    return caja;
  }

  /** Bloque BenchLM de una ficha: cifras, exámenes, error o la invitación a lo que falte. */
  function bloqueBenchlm(sheet) {
    const caja = document.createElement("div");
    caja.className = "bench";

    const d = ficha(sheet.benchlm);
    const err = d ? texto(d.error) : null;

    const cab = document.createElement("div");
    cab.className = "bench-head";
    cab.appendChild(nodo("bench-title", "BENCHLM"));
    const rotulo = d ? texto(d.slug) || texto(d.name) : null;
    const slug = nodo("bench-slug", rotulo === null ? "sin datos" : rotulo);
    if (rotulo === null) slug.classList.add("none");
    else slug.title = rotulo;
    cab.appendChild(slug);
    const asOf = d ? texto(d.dataAsOf) : null;
    if (asOf !== null) cab.appendChild(nodo("bench-asof", "datos de " + asOf));
    caja.appendChild(cab);

    // Sin datos y sin clave: se ofrece añadirla. Con clave y sin comparar: a COMPARAR.
    if (!d) {
      const linea = document.createElement("p");
      linea.className = "bench-empty";
      if (!state.benchlmKey) {
        linea.appendChild(nodo("bench-empty-text", "Sin clave de BenchLM."));
        const boton = document.createElement("button");
        boton.type = "button";
        boton.className = "ghost-btn";
        boton.textContent = "AÑADIR CLAVE";
        boton.title = "Guardar una clave de BenchLM.ai para traer las puntuaciones";
        boton.addEventListener("click", () => actua({ type: "benchlmKey" }));
        linea.appendChild(boton);
      } else {
        linea.textContent = "Aún no consultado. Pulsa COMPARAR.";
      }
      caja.appendChild(linea);
    } else if (err !== null) {
      caja.appendChild(pista(err, true));
    } else {
      const cats = ficha(d.categories) || {};
      const f = num(d.fetchedAt);
      if (f !== null && f > 0) {
        caja.title = "Puntuaciones tomadas de BenchLM el " + fmtFechaHora(f);
      }
      const cifras = document.createElement("div");
      cifras.className = "bench-cifras";
      cifras.appendChild(cifra("OVERALL", d.overall));
      cifras.appendChild(cifra("CODING", cats.coding));
      cifras.appendChild(cifra("AGENTIC", cats.agentic));
      cifras.appendChild(cifra("KNOWLEDGE", cats.knowledge));
      caja.appendChild(cifras);

      if (Array.isArray(d.exams) && d.exams.length) {
        const sub = document.createElement("p");
        sub.className = "bench-sub";
        sub.textContent = "EXÁMENES";
        caja.appendChild(sub);
        const tabla = document.createElement("table");
        tabla.className = "bench-table";
        const cuerpo = document.createElement("tbody");
        for (const ex of d.exams) {
          cuerpo.appendChild(filaExamen(ex));
        }
        tabla.appendChild(cuerpo);
        caja.appendChild(tabla);
      }
    }

    // El alias va SIEMPRE, también cuando el error es justo «sin coincidencia»: es lo que lo resuelve.
    caja.appendChild(filaAlias(sheet));
    return caja;
  }

  function renderFicha(sheet, seal) {
    const wrap = document.createElement("div");
    wrap.className = "sheet";

    const head = document.createElement("div");
    head.className = "sheet-head";
    head.appendChild(nodo("sheet-name", texto(sheet.name) || texto(sheet.key) || "—"));
    if (sheet.free === true) {
      head.appendChild(chip("free", "FREE", "Modelo gratuito"));
    }
    if (seal) {
      head.appendChild(chip(seal.fresco ? "sheet-seal fresh" : "sheet-seal", seal.txt, seal.titulo));
    }
    wrap.appendChild(head);
    // Las puntuaciones van lo primero: debajo del nombre y antes de los datos de models.dev.
    wrap.appendChild(bloqueBenchlm(sheet));

    const table = document.createElement("table");
    table.className = "sheet-table";
    const cuerpo = document.createElement("tbody");
    const coste = ficha(sheet.cost);
    const limite = ficha(sheet.limit);
    const mod = ficha(sheet.modalities);

    cuerpo.appendChild(seccion("IDENTIFICACIÓN"));
    cuerpo.appendChild(fila("Proveedor", texto(sheet.provider)));
    cuerpo.appendChild(fila("ID", texto(sheet.id)));
    cuerpo.appendChild(fila("Estado", texto(sheet.status)));
    cuerpo.appendChild(fila("Publicación", texto(sheet.releaseDate)));
    cuerpo.appendChild(fila("Actualizado", texto(sheet.lastUpdated)));

    cuerpo.appendChild(seccion("LÍMITES"));
    cuerpo.appendChild(filaNumero("Contexto", limite && limite.context, "tokens"));
    cuerpo.appendChild(filaNumero("Salida", limite && limite.output, "tokens"));

    cuerpo.appendChild(seccion("COSTES"));
    cuerpo.appendChild(fila("$/M entrada", coste && fmtDolar(coste.input)));
    cuerpo.appendChild(fila("$/M salida", coste && fmtDolar(coste.output)));
    cuerpo.appendChild(fila("$/M razonamiento", coste && fmtDolar(coste.reasoning)));
    cuerpo.appendChild(fila("$/M lectura caché", coste && fmtDolar(coste.cacheRead)));
    cuerpo.appendChild(fila("$/M escritura caché", coste && fmtDolar(coste.cacheWrite)));

    cuerpo.appendChild(seccion("CAPACIDADES"));
    cuerpo.appendChild(filaSiNo("Herramientas", sheet.toolCall));
    cuerpo.appendChild(filaSiNo("Razonamiento", sheet.reasoningModel));
    cuerpo.appendChild(filaSiNo("Adjuntos", sheet.attachment));
    cuerpo.appendChild(fila("Modalidades entrada", fmtLista(mod && mod.input)));
    cuerpo.appendChild(fila("Modalidades salida", fmtLista(mod && mod.output)));

    table.appendChild(cuerpo);
    wrap.appendChild(table);
    return wrap;
  }

  function renderSlot(i) {
    const slot = state.slots[i];
    const dom = el.slots[i];
    dom.key.textContent = slot.key || "";
    dom.key.title = slot.key || "";
    dom.clear.hidden = !slot.key;
    dom.body.textContent = "";

    if (!slot.key) {
      dom.body.appendChild(pista("Arrastra un modelo desde la lista.", false));
      return;
    }
    if (ficha(slot.sheet)) {
      dom.body.appendChild(renderFicha(slot.sheet, sello(slot)));
      return;
    }
    if (slot.missing) {
      dom.body.appendChild(pista("Modelo no encontrado en el catálogo vivo.", true));
      return;
    }
    dom.body.appendChild(pista("Sin datos · pulsa COMPARAR.", false));
  }

  function renderSlots() {
    renderSlot(0);
    renderSlot(1);
  }

  /* ── Acciones ───────────────────────────────────────── */

  function coloca(i, key) {
    if (typeof key !== "string" || !state.byKey.has(key)) return false;
    state.slots[i] = slotCon(key);
    guarda();
    renderSlot(i);
    renderHeader();
    return true;
  }

  function vacia(i) {
    state.slots[i] = huevoSlot();
    guarda();
    renderSlot(i);
    renderHeader();
  }

  /** Los dos mensajes del host (compared e init) traen fichas: esto decide cuáles pinta. */
  function sincroniza() {
    for (let i = 0; i < 2; i++) {
      const slot = state.slots[i];
      if (!slot.key) continue;
      const cached = cacheOf(slot.key);
      if (!cached) continue;
      const f = num(cached.fetchedAt);
      if (slot.freshAt > 0 && f !== null && f > slot.freshAt) {
        slot.sheet = cached;
        slot.freshAt = f;
      } else if (slot.freshAt === 0) {
        slot.sheet = cached;
      }
      slot.missing = false;
    }
  }

  /* ── Mensajes del host ──────────────────────────────── */

  function onInit(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    const lista = Array.isArray(p.models) ? p.models : [];
    state.models = [];
    state.byKey = new Map();
    for (const m of lista) {
      if (esModelo(m) && !state.byKey.has(m.key)) {
        state.models.push(m);
        state.byKey.set(m.key, m);
      }
    }
    state.cache = ficha(p.cache) || {};
    state.aliases = ficha(p.aliases) || {};
    state.benchlmKey = p.benchlmKey === true;
    renderBenchKey();
    limpiaEsperas();

    if (!state.cargado) {
      state.cargado = true;
      const guardadas = leido();
      for (let i = 0; i < 2; i++) {
        const k = guardadas[i];
        if (typeof k === "string" && state.byKey.has(k)) {
          state.slots[i] = slotCon(k);
        }
      }
    }
    // Una key guardada que ya no está en la lista se descarta con el hueco.
    for (let i = 0; i < 2; i++) {
      if (state.slots[i].key && !state.byKey.has(state.slots[i].key)) {
        state.slots[i] = huevoSlot();
        guarda();
      }
    }
    sincroniza();

    renderList();
    renderSlots();
    renderHeader();
  }

  function onCompared(msg) {
    const hojas = Array.isArray(msg.sheets) ? msg.sheets : [];
    const pedido = state.peticion;
    state.peticion = null;
    for (let i = 0; i < 2; i++) {
      const slot = state.slots[i];
      if (!slot.key) continue;
      if (pedido && pedido[i] !== slot.key) continue;
      const hoja = ficha(hojas[i]);
      if (hoja) {
        slot.sheet = hoja;
        slot.missing = false;
        const f = num(hoja.fetchedAt);
        slot.freshAt = f !== null && f > 0 ? f : Date.now();
      } else {
        slot.sheet = null;
        slot.freshAt = 0;
        slot.missing = true;
      }
    }
    state.error = texto(msg.error) || "";
    setBusy(false);
    // El repintado devuelve todas las filas de alias a BUSCAR.
    limpiaEsperas();
    renderSlots();
    renderNotice();
  }

  /** El host guardó el alias ("" = borrado) y devuelve la ficha ya consultada. */
  function onAliased(msg) {
    const key = texto(msg.key);
    if (key === null) return;
    const alias = typeof msg.alias === "string" ? msg.alias.trim() : "";
    if (alias !== "") {
      state.aliases[key] = alias;
    } else {
      delete state.aliases[key];
    }
    const hoja = ficha(msg.sheet);
    if (hoja) {
      state.cache[key] = hoja;
      // El hueco que tenga ese modelo se repinta con la ficha nueva, sin gastar otra lectura.
      for (let i = 0; i < 2; i++) {
        const slot = state.slots[i];
        if (slot.key !== key) continue;
        slot.sheet = hoja;
        slot.freshAt = num(hoja.fetchedAt) || Date.now();
        slot.missing = false;
      }
    }
    marcarEspera(key, false);
    renderSlots();
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "init") {
      onInit(msg.payload);
    } else if (msg.type === "compared") {
      onCompared(msg);
    } else if (msg.type === "aliased") {
      onAliased(msg);
    } else if (msg.type === "busy") {
      setBusy(msg.on === true);
    }
    // `theme` lo aplica media/theme.js: aquí no se toca.
  });

  /* ── Arrastrar y soltar ─────────────────────────────── */

  el.rows.addEventListener("dragstart", (e) => {
    const row = e.target && e.target.closest ? e.target.closest(".mrow") : null;
    if (!row || !row.dataset.key || !e.dataTransfer) return;
    e.dataTransfer.setData("text/plain", row.dataset.key);
    e.dataTransfer.effectAllowed = "copy";
  });

  for (let i = 0; i < 2; i++) {
    const dom = el.slots[i];
    let dentro = 0;
    const aceptable = (e) => {
      if (!e.dataTransfer) return false;
      const tipos = e.dataTransfer.types;
      return !Array.isArray(tipos) || tipos.indexOf("text/plain") >= 0;
    };
    dom.root.addEventListener("dragenter", (e) => {
      if (!aceptable(e)) return;
      e.preventDefault();
      dentro += 1;
      dom.root.classList.add("drop-hot");
    });
    dom.root.addEventListener("dragover", (e) => {
      if (!aceptable(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      dom.root.classList.add("drop-hot");
    });
    dom.root.addEventListener("dragleave", () => {
      dentro = Math.max(0, dentro - 1);
      if (dentro === 0) dom.root.classList.remove("drop-hot");
    });
    dom.root.addEventListener("drop", (e) => {
      e.preventDefault();
      dentro = 0;
      dom.root.classList.remove("drop-hot");
      const key = e.dataTransfer ? e.dataTransfer.getData("text/plain") : "";
      coloca(i, key);
    });
    dom.clear.addEventListener("click", () => vacia(i));
  }

  el.run.addEventListener("click", () => {
    if (state.busy) return;
    const a = state.slots[0].key;
    const b = state.slots[1].key;
    if (!a || !b) return;
    state.error = "";
    state.peticion = [a, b];
    setBusy(true);
    send({ type: "action", action: { type: "compare", keys: [a, b] } });
  });

  el.benchKey.addEventListener("click", () => actua({ type: "benchlmKey" }));
  el.benchSite.addEventListener("click", () => actua({ type: "openBenchlm" }));

  renderSlots();
  renderHeader();
  renderBenchKey();
  send({ type: "ready" });
})();
