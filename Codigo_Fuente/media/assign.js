/* Asignación — conecta agentes con modelos favoritos: arrastrar, soltar y líneas. */
(function () {
  // Un arnés headless puede no inyectar la API de VS Code: sin ella el tablero sigue pintando.
  const vscode =
    typeof acquireVsCodeApi === "function"
      ? acquireVsCodeApi()
      : {
          postMessage() {},
          getState() {
            return null;
          },
          setState() {},
        };
  const SVG = "http://www.w3.org/2000/svg";

  const el = {
    root: document.querySelector(".assign"),
    kicker: document.querySelector(".assign-kicker"),
    hint: document.getElementById("hint"),
    profiles: document.getElementById("profiles"),
    search: document.getElementById("search"),
    providers: document.getElementById("providers"),
    close: document.getElementById("close"),
    agents: document.getElementById("agents"),
    agentsCount: document.getElementById("agents-count"),
    favorites: document.getElementById("favorites"),
    favCount: document.getElementById("fav-count"),
    favSort: document.getElementById("fav-sort"),
    groups: document.getElementById("groups"),
    models: document.getElementById("models"),
    modelsCount: document.getElementById("models-count"),
    board: document.querySelector(".board"),
    wires: document.getElementById("wires"),
    modal: document.getElementById("modal"),
    modalTitle: document.getElementById("modal-title"),
    modalText: document.getElementById("modal-text"),
    modalOk: document.getElementById("modal-ok"),
    modalCancel: document.getElementById("modal-cancel"),
  };

  const SCOPE = { project: "PROY", global: "GLOBAL", builtin: "INTEGRADO" };

  // Rótulo y ayuda de opencode, los del HTML: Claude los cambia y opencode los recupera.
  const KICKER = el.kicker.textContent;
  const HINT = el.hint.textContent;
  const HINT_CLAUDE =
    "Arrastra un agente hasta un modelo para conectarlo. La × quita el modelo: el subagente " +
    "hereda el de la sesión y CLAUDE vuelve al de por defecto.";

  // El buscador es HTML estático: su valor no se reconstruye al repintar.
  let query = "";
  // Conectores apagados del filtro; se restauran de la vista guardada al arrancar.
  const off = new Set();
  // Modo del último assign (`opencode` | `claude`). Solo el primero de cada modo siembra
  // query/off: los siguientes son repintados de la extensión.
  let mode = "";
  // Con Claude no hay FAVORITOS ni CONFIGURACIONES: el agente se suelta sobre MODELOS.
  let claude = false;
  let saveTimer = 0;
  let lastData = null;
  let lastKey = "";
  let favIds = new Set();
  // Borrado pendiente con el modal abierto ({ bar, index }) o null.
  let pendingDelete = null;
  // Elemento que abrió el modal: el foco vuelve a él al cerrar.
  let modalReturn = null;
  // Ids del catálogo vivo: los grupos pueden traer ids que el host ya no sirve.
  let catalogIds = new Set();
  let drag = null;
  // Fila/tarjeta seleccionada ({ kind, id }): resalta su cable. Solo visual: no se persiste ni se envía al host.
  let sel = null;
  let agentEls = new Map();
  let favEls = new Map();
  // Tarjetas de MODELOS por id: solo con Claude, donde son el destino de los cables.
  let modelEls = new Map();
  let raf = 0;

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function post(action) {
    vscode.postMessage({ type: "action", action });
  }

  // Una sola escritura por ráfaga: el filtro y el repintado siguen siendo inmediatos.
  function persistView() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      // Con Claude el filtro vive solo en memoria. Se mira al disparar: si Claude llegó con la
      // escritura pendiente, la vista guardada de opencode no se pisa con la suya.
      if (claude) return;
      post({ type: "persistView", search: el.search.value, disabledProviders: [...off] });
    }, 300);
  }

  /** El nombre legible del modelo; si el catálogo ya no lo trae, el id. */
  function modelLabel(models, id) {
    const found = models.find((m) => m.id === id);
    return found ? found.name : id;
  }

  /** Menos de un dólar lleva hasta tres decimales; el resto, dos. */
  function money(value) {
    return "$" + (value < 1 ? String(Number(value.toFixed(3))) : value.toFixed(2));
  }

  /** Tarifa por millón de tokens: `$1.25 in · $5.00 out`; sin datos o gratis, cadena vacía. */
  function costText(cost) {
    if (!cost) return "";
    if (!Number.isFinite(cost.input) || !Number.isFinite(cost.output)) return "";
    // Gratis ya lo dice el chip FREE: `$0 in · $0 out` solo hace ruido.
    if (cost.input === 0 && cost.output === 0) return "";
    return money(cost.input) + " in · " + money(cost.output) + " out";
  }

  /** Favoritos del grupo que el catálogo vivo conoce: los ids muertos no cuentan. */
  function liveCount(ids) {
    return ids.filter((id) => catalogIds.has(id)).length;
  }

  // Notas de BenchLM: una coma decimal, formato es-ES.
  const fmtNota = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });
  const BENCH_NOTAS = [
    ["overall", "O", "Overall"],
    ["coding", "C", "Coding"],
    ["agentic", "A", "Agentic"],
    ["knowledge", "K", "Knowledge"],
  ];

  /**
   * Las cuatro notas de BenchLM en una línea (`O 86,3 · C 82,9 · …`) y su detalle para el
   * `title`. Solo se pinta lo que el modelo traiga: sin notas devuelve null y no hay hueco.
   */
  function benchlmInline(benchlm) {
    if (!benchlm || typeof benchlm !== "object") return null;
    const corto = [];
    const largo = [];
    for (const [campo, letra, nombre] of BENCH_NOTAS) {
      const nota = benchlm[campo];
      if (!nota || typeof nota !== "object") continue;
      const score = Number(nota.score);
      if (!Number.isFinite(score)) continue;
      const valor = fmtNota.format(score);
      corto.push(letra + " " + valor);
      const rank = Number(nota.rank);
      largo.push(nombre + (Number.isFinite(rank) ? " #" + Math.round(rank) : "") + ": " + valor);
    }
    if (corto.length === 0) return null;
    return { corto: corto.join(" · "), largo: "BenchLM · " + largo.join(" · ") };
  }

  /**
   * Criterios de orden de FAVORITOS, en el orden de los botones. El último valor es la
   * dirección natural: las notas van de mejor a peor y el precio, del más barato al más caro.
   */
  const SORT_FIELDS = [
    ["overall", "O", "Overall de BenchLM", true],
    ["coding", "C", "Coding de BenchLM", true],
    ["agentic", "A", "Agentic de BenchLM", true],
    ["knowledge", "K", "Knowledge de BenchLM", true],
    ["cost", "$", "precio de salida ($/M tokens)", false],
  ];
  const SORT_KEYS = new Set(SORT_FIELDS.map((campo) => campo[0]));

  /** Orden inicial: nota global de BenchLM de mayor a menor, el que había antes. */
  function defaultSort() {
    return { field: "overall", desc: true };
  }

  /**
   * Orden recordado con `setState` (como mucho `{ sort: { field, desc } }`). Un estado raro
   * —campo que no está en la lista o dirección que no es booleana— cae al inicial.
   */
  function readSort() {
    try {
      const state = typeof vscode.getState === "function" ? vscode.getState() : null;
      const saved = state && typeof state === "object" ? state.sort : null;
      if (saved && SORT_KEYS.has(saved.field) && typeof saved.desc === "boolean") {
        return { field: saved.field, desc: saved.desc };
      }
    } catch (error) {
      // Estado ilegible: se queda el orden inicial.
    }
    return defaultSort();
  }

  function saveSort() {
    try {
      vscode.setState({ sort: { field: sort.field, desc: sort.desc } });
    } catch (error) {
      // Sin API de VS Code el orden vive solo en memoria.
    }
  }

  let sort = readSort();

  /** Nota de BenchLM del campo pedido; null cuando el modelo no la trae como número. */
  function benchScore(model, field) {
    const nota = model.benchlm && model.benchlm[field];
    if (!nota || typeof nota !== "object") return null;
    const raw = nota.score;
    if (raw === null || raw === undefined || raw === "") return null;
    const score = Number(raw);
    return Number.isFinite(score) ? score : null;
  }

  /** Tarifa de salida por millón de tokens; null cuando el modelo no trae precio. */
  function outCost(model) {
    const cost = model.cost;
    if (!cost || typeof cost !== "object") return null;
    const value = cost.output;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  /** Valor que ordena el criterio activo: la nota pedida o el precio de salida. */
  function sortValue(model) {
    return sort.field === "cost" ? outCost(model) : benchScore(model, sort.field);
  }

  /**
   * Favoritos con el criterio activo: primero los modelos con el dato, en la dirección
   * elegida; después los que no lo tienen, por nombre. Los empates se resuelven por nombre.
   */
  function favoriteOrder(a, b) {
    const valueA = sortValue(a);
    const valueB = sortValue(b);
    if (valueA === null || valueB === null) {
      if (valueA !== valueB) return valueA === null ? 1 : -1;
      return a.name.localeCompare(b.name, "es");
    }
    if (valueA !== valueB) return sort.desc ? valueB - valueA : valueA - valueB;
    return a.name.localeCompare(b.name, "es");
  }

  function agentKey(agent) {
    return agent.scope + "\u0000" + agent.name;
  }

  /**
   * Mismo orden que el Explorador, en cuatro bloques: agentes de proyecto, subagentes de
   * proyecto, agentes globales y subagentes globales. Dentro de cada bloque van primero los
   * integrados y después el resto; a igualdad, por nombre.
   */
  function agentOrder(a, b) {
    const blockA = (a.group === "project" ? 0 : 1) * 2 + (a.mode === "subagent" ? 1 : 0);
    const blockB = (b.group === "project" ? 0 : 1) * 2 + (b.mode === "subagent" ? 1 : 0);
    if (blockA !== blockB) return blockA - blockB;
    const builtinA = a.scope === "builtin" ? 0 : 1;
    const builtinB = b.scope === "builtin" ? 0 : 1;
    if (builtinA !== builtinB) return builtinA - builtinB;
    return a.name.localeCompare(b.name, "es");
  }

  /** Misma figura que el Explorador: rombo para primarios, triángulo para subagentes. */
  function agentIcon(agent) {
    const subagent = agent.mode === "subagent";
    const icon = node("span", "agent-icon mode-" + (subagent ? "subagent" : "primary"));
    icon.setAttribute("aria-hidden", "true");
    // El color del frontmatter manda; si no es un hex válido, se queda el del modo.
    if (typeof agent.color === "string" && /^#[0-9a-f]{6}$/i.test(agent.color)) {
      icon.style.setProperty("--agent-color", agent.color);
    }
    return icon;
  }

  function empty(text) {
    return node("div", "empty", text);
  }

  /** «1 favorito», «3 favoritos»: el modal se lee en español. */
  function plural(count, one, many) {
    return count + " " + (count === 1 ? one : many);
  }

  // ── Arrastre ────────────────────────────────────────────
  function startDrag(event, payload) {
    drag = payload;
    event.dataTransfer.setData("text/plain", JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "link";
    // Un agente a la caza de destino: todos los favoritos (con Claude, los modelos) se marcan.
    if (payload.kind === "agent") markTargets(true);
  }

  function endDrag() {
    drag = null;
    clearDrop();
  }

  function markTargets(on) {
    for (const card of (claude ? el.models : el.favorites).children) {
      card.classList.toggle("target", on);
    }
  }

  function clearDrop() {
    el.favorites.classList.remove("drop");
    el.models.classList.remove("drop");
    for (const card of el.favorites.children) card.classList.remove("drop", "target");
    for (const card of el.models.children) card.classList.remove("drop", "target");
  }

  /** Un agente soltado sobre la tarjeta queda conectado a su modelo. */
  function acceptAgent(card, model) {
    card.addEventListener("dragover", (event) => {
      if (!drag || drag.kind !== "agent") return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "link";
      card.classList.add("drop");
      card.classList.add("target");
    });
    card.addEventListener("dragleave", (event) => {
      if (card.contains(event.relatedTarget)) return;
      card.classList.remove("drop");
    });
    card.addEventListener("drop", (event) => {
      if (!drag || drag.kind !== "agent") return;
      event.preventDefault();
      const { agent, scope } = drag;
      drag = null;
      clearDrop();
      post({ type: "assign", agent, scope, model: model.id });
    });
  }

  // ── Filtro de conectores ────────────────────────────────
  function providerCounts(models) {
    const counts = new Map();
    for (const model of models) counts.set(model.provider, (counts.get(model.provider) || 0) + 1);
    return counts;
  }

  function renderProviders(models) {
    el.providers.textContent = "";
    for (const [provider, count] of providerCounts(models)) {
      const chip = node("button", "chip" + (off.has(provider) ? " off" : ""), provider);
      chip.type = "button";
      chip.title = count + (count === 1 ? " modelo" : " modelos");
      chip.setAttribute("aria-pressed", String(!off.has(provider)));
      chip.appendChild(node("span", "prov-count", String(count)));
      chip.addEventListener("click", () => {
        if (off.has(provider)) off.delete(provider);
        else off.add(provider);
        repaint();
        persistView();
      });
      el.providers.appendChild(chip);
    }
  }

  // ── Columna AGENTES ─────────────────────────────────────
  function renderAgents(agents, models) {
    el.agents.textContent = "";
    agentEls = new Map();
    el.agentsCount.textContent = agents.length ? String(agents.length) : "";
    if (agents.length === 0) {
      el.agents.appendChild(empty("Sin agentes."));
      return;
    }

    // Copia ordenada: el orden del host no se toca y las líneas se apoyan en `agentEls`.
    const list = [...agents].sort(agentOrder);

    for (const agent of list) {
      const card = node("div", "card agent");
      card.draggable = true;
      card.title = agent.name;
      // La marca sobrevive a los repintados del sondeo: se deriva de sel al construir.
      if (sel && sel.kind === "agente" && sel.id === agentKey(agent)) card.classList.add("sel");

      const line = node("div", "card-line");
      line.appendChild(agentIcon(agent));
      line.appendChild(node("span", "card-name", agent.name));
      line.appendChild(
        node("span", "chip scope scope-" + agent.scope, SCOPE[agent.scope] || agent.scope)
      );
      card.appendChild(line);

      if (agent.model) {
        const row = node("div", "card-model-row");
        const label = node("span", "card-model", modelLabel(models, agent.model));
        label.title = agent.model;
        row.appendChild(label);
        const clear = node("button", "card-x", "×");
        clear.type = "button";
        clear.title = "Quitar modelo";
        clear.setAttribute("aria-label", "Quitar el modelo de " + agent.name);
        clear.addEventListener("click", () =>
          post({ type: "clear", agent: agent.name, scope: agent.scope })
        );
        row.appendChild(clear);
        card.appendChild(row);
      }

      if (agent.detail) card.appendChild(node("div", "card-detail", agent.detail));

      card.addEventListener("dragstart", (event) =>
        startDrag(event, { kind: "agent", agent: agent.name, scope: agent.scope })
      );
      card.addEventListener("dragend", endDrag);
      // Tras un drag real el navegador no dispara click, así que no interfiere con el arrastre.
      // El botón «×» ya tiene su propio clic: no lo convertimos también en selección.
      card.addEventListener("click", (event) => {
        if (event.target.closest(".card-x")) return;
        toggleSel("agente", agentKey(agent));
      });

      agentEls.set(agentKey(agent), card);
      el.agents.appendChild(card);
    }
  }

  // ── Pestañas: grupos de favoritos y configuraciones ─────
  // Misma mecánica en las dos barras: clic para activar, doble clic para renombrar, × para
  // borrar la activa y + para crear. `msg` nombra los mensajes que entiende el host.
  const GROUP_TABS = {
    select: "selectGroup",
    create: "createGroup",
    rename: "renameGroup",
    remove: "deleteGroup",
    key: "group",
    createTitle: "Crear grupo",
    createAria: "Crear un grupo de favoritos",
    renameAria: "Nombre del grupo",
    deleteTitle: "Borrar grupo",
    deleteAria: "Borrar el grupo",
    modalTitle: "Borrar grupo",
    // Al crear, el host devuelve el grupo nuevo y la barra salta a él.
    jumpOnCreate: true,
    // Se anuncia lo que de verdad se borra: los ids muertos no cuentan.
    modalText: (group) =>
      "Se borrará el grupo \"" +
      group.name +
      "\" y sus " +
      plural(liveCount(group.ids || []), "favorito", "favoritos") +
      ". Los modelos siguen en MODELOS.",
  };

  const PROFILE_TABS = {
    select: "selectProfile",
    create: "createProfile",
    rename: "renameProfile",
    remove: "deleteProfile",
    key: "profile",
    createTitle: "Crear configuración",
    createAria: "Crear una configuración de asignaciones",
    renameAria: "Nombre de la configuración",
    deleteTitle: "Borrar configuración",
    deleteAria: "Borrar la configuración",
    modalTitle: "Borrar configuración",
    modalText: (profile) =>
      "¿Borrar la configuración «" +
      profile.name +
      "»? Se pierden sus asignaciones guardadas. Los ficheros de agente no se tocan.",
  };

  const groupBar = {
    box: el.groups,
    msg: GROUP_TABS,
    tabs: [],
    active: 0,
    // Pestaña en renombrado en línea; mientras exista, la barra no se repinta.
    editing: null,
    // Temporizador del clic: espera por si llega el doble clic del renombrado.
    timer: 0,
    // Nombres previos a un alta: el siguiente repintado salta a la pestaña nueva.
    pending: null,
  };

  // Configuraciones guardadas agente→modelo: solo el nombre y el índice activo. Las
  // asignaciones las aplica el host escribiendo el `model:` de los .md; aquí no se pintan.
  const profileBar = {
    box: el.profiles,
    msg: PROFILE_TABS,
    tabs: [],
    active: 0,
    editing: null,
    timer: 0,
  };

  function renderTabbar(bar) {
    // Renombrar en línea: un repintado a media edición borraría el campo.
    if (bar.editing !== null) return;
    const msg = bar.msg;
    bar.box.textContent = "";

    bar.tabs.forEach((item, index) => {
      const tab = node("div", "group-tab" + (index === bar.active ? " on" : ""));
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(index === bar.active));
      tab.tabIndex = 0;
      tab.addEventListener("keydown", (event) => {
        if (event.target !== tab || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        tab.click();
      });
      const name = node("span", "group-tab-name", item.name);
      tab.appendChild(name);
      tab.title = item.name;
      tab.addEventListener("click", () => {
        if (bar.editing !== null || index === bar.active) return;
        // El repintado del host sustituye la pestaña, así que el clic deja un turno al doble
        // clic: si llega, se cancela el cambio de pestaña y se renombra en línea.
        if (bar.timer) clearTimeout(bar.timer);
        bar.timer = setTimeout(() => {
          bar.timer = 0;
          post({ type: msg.select, [msg.key]: index });
        }, 250);
      });
      name.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        if (bar.timer) {
          clearTimeout(bar.timer);
          bar.timer = 0;
        }
        startRename(bar, index, name);
      });

      // La × solo en la pestaña activa, y nunca si es la única.
      if (index === bar.active && bar.tabs.length > 1) {
        const del = node("button", "group-x", "×");
        del.type = "button";
        del.title = msg.deleteTitle;
        del.setAttribute("aria-label", msg.deleteAria + " " + item.name);
        del.addEventListener("click", (event) => {
          event.stopPropagation();
          askDelete(bar, index);
        });
        tab.appendChild(del);
      }
      bar.box.appendChild(tab);
    });

    const add = node("button", "group-add", "+");
    add.type = "button";
    add.title = msg.createTitle;
    add.setAttribute("aria-label", msg.createAria);
    add.addEventListener("click", () => {
      // El nombre lo pone el host; el salto a la pestaña nueva se resuelve con los previos.
      // Las configuraciones no saltan: «+» crea una copia sin cambiar la activa.
      if (msg.jumpOnCreate) bar.pending = new Set(bar.tabs.map((tab) => tab.name));
      post({ type: msg.create });
    });
    bar.box.appendChild(add);
  }

  /** Tras crear, salta a la pestaña que no estaba antes en la barra. */
  function jumpToNew(bar) {
    if (!bar.pending) return;
    const before = bar.pending;
    bar.pending = null;
    const index = bar.tabs.findIndex((tab) => !before.has(tab.name));
    if (index >= 0 && index !== bar.active) {
      post({ type: bar.msg.select, [bar.msg.key]: index });
    }
  }

  /** Renombrado en línea: Enter confirma, Esc o vacío cancelan. */
  function startRename(bar, index, nameEl) {
    const item = bar.tabs[index];
    if (bar.editing !== null || !item) return;
    bar.editing = index;

    const input = node("input", "group-rename");
    input.type = "text";
    input.maxLength = 60;
    input.value = item.name;
    input.setAttribute("aria-label", bar.msg.renameAria);
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      bar.editing = null;
      const value = input.value.trim();
      if (commit && value && value !== item.name) {
        post({ type: bar.msg.rename, [bar.msg.key]: index, name: value });
      }
      renderTabbar(bar);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("dblclick", (event) => event.stopPropagation());
  }

  /** Confirmación de borrado dentro de la webview: `window.confirm` no existe aquí. */
  function askDelete(bar, index) {
    const item = bar.tabs[index];
    if (!item || bar.tabs.length <= 1) return;
    pendingDelete = { bar, index };
    el.modalTitle.textContent = bar.msg.modalTitle;
    el.modalText.textContent = bar.msg.modalText(item);
    modalReturn = document.activeElement;
    el.modal.hidden = false;
    el.modalOk.focus();
  }

  function closeModal() {
    pendingDelete = null;
    el.modal.hidden = true;
    // El foco vuelve a quien abrió el modal; si el repintado ya se lo llevó, no se fuerza.
    if (modalReturn && modalReturn.isConnected) modalReturn.focus();
    modalReturn = null;
  }

  // ── Orden de FAVORITOS ──────────────────────────────────
  /** Los cinco botones de orden, en la línea del título; el activo muestra su flecha. */
  function renderSort() {
    el.favSort.textContent = "";
    for (const [field, letra, etiqueta, naturalDesc] of SORT_FIELDS) {
      const active = sort.field === field;
      const button = node("button", "sort-btn" + (active ? " on" : ""));
      button.type = "button";
      // La flecha dice la dirección que se está viendo: ▼ de mejor a peor, ▲ al revés.
      button.textContent = letra + (active ? (sort.desc ? "▼" : "▲") : "");
      const title = "Ordenar por " + etiqueta;
      button.title = title + (active ? (sort.desc ? " (descendente)" : " (ascendente)") : "");
      button.setAttribute("aria-label", title);
      button.setAttribute("aria-pressed", String(active));
      button.addEventListener("click", () => {
        // Otro criterio entra con su dirección natural; el activo invierte la suya.
        if (active) setSort(field, !sort.desc);
        else setSort(field, naturalDesc);
      });
      el.favSort.appendChild(button);
    }
  }

  /** Cambia el criterio y repinta solo FAVORITOS, conservando su scroll. */
  function setSort(field, desc) {
    sort = { field, desc };
    saveSort();
    renderSort();
    if (!lastData) return;
    const top = el.favorites.scrollTop;
    renderFavorites(lastData.models || []);
    el.favorites.scrollTop = top;
    scheduleWires();
  }

  // ── Columna FAVORITOS ───────────────────────────────────
  function renderFavorites(models) {
    el.favorites.textContent = "";
    favEls = new Map();
    const list = [...favIds]
      .map((id) => models.find((m) => m.id === id))
      .filter(Boolean)
      .sort(favoriteOrder);
    el.favCount.textContent = list.length ? String(list.length) : "";

    if (list.length === 0) {
      el.favorites.appendChild(empty("Arrastra aquí tus modelos."));
      return;
    }

    for (const model of list) {
      const card = node("div", "card fav");
      card.draggable = true;
      card.title = model.id;
      if (sel && sel.kind === "modelo" && sel.id === model.id) card.classList.add("sel");
      const line = node("div", "card-line");
      line.appendChild(node("span", "card-name", model.name));
      // Gratis: mismo chip que MODELOS, en la línea del nombre para no estirar la tarjeta.
      if (model.free === true) {
        line.appendChild(node("span", "chip free", "FREE"));
        card.classList.add("free");
      }
      card.appendChild(line);
      const prov = node("div", "card-provider", model.provider);
      // Las notas de BenchLM van en la misma línea del proveedor, tras un separador.
      const bench = benchlmInline(model.benchlm);
      if (bench) {
        prov.appendChild(document.createTextNode(" · "));
        const nota = node("span", "card-bench", bench.corto);
        nota.title = bench.largo;
        prov.appendChild(nota);
      }
      card.appendChild(prov);
      const cost = costText(model.cost);
      if (cost) {
        const row = node("div", "card-cost", cost);
        row.title = "USD por millón de tokens";
        card.appendChild(row);
      }

      // Un agente soltado sobre este favorito queda conectado a él.
      acceptAgent(card, model);
      card.addEventListener("dragstart", (event) =>
        startDrag(event, { kind: "model", id: model.id, group: groupBar.active })
      );
      card.addEventListener("dragend", endDrag);
      card.addEventListener("click", () => toggleSel("modelo", model.id));

      favEls.set(model.id, card);
      el.favorites.appendChild(card);
    }
  }

  // ── Columna MODELOS ─────────────────────────────────────
  function renderModelsColumn(models) {
    const hidden = new Set([...off]);
    const matches = models.filter(
      (m) =>
        !hidden.has(m.provider) &&
        (!query || (m.provider + " " + m.name + " " + m.id).toLowerCase().includes(query))
    );

    el.modelsCount.textContent =
      query || off.size ? matches.length + "/" + models.length : String(models.length);
    el.models.textContent = "";
    modelEls = new Map();

    if (matches.length === 0) {
      el.models.appendChild(
        empty(models.length === 0 ? "Sin modelos." : "Sin coincidencias.")
      );
      return;
    }

    for (const model of matches) {
      const isFav = favIds.has(model.id);
      const card = node("div", "card model-card" + (isFav ? " is-fav" : ""));
      card.draggable = !claude;
      card.title = model.id;

      const line = node("div", "card-line");
      line.appendChild(node("span", "card-name", model.name));
      if (isFav) line.appendChild(node("span", "card-star", "★"));
      card.appendChild(line);

      const meta = node("div", "card-meta");
      meta.appendChild(node("span", "card-provider", model.provider));
      if (model.free) {
        meta.appendChild(node("span", "chip free", "FREE"));
        card.classList.add("free");
      }
      // Las notas de BenchLM cierran la línea; si no caben, se recortan.
      const bench = benchlmInline(model.benchlm);
      if (bench) {
        const nota = node("span", "card-bench", bench.corto);
        nota.title = bench.largo;
        meta.appendChild(nota);
      }
      card.appendChild(meta);

      const cost = costText(model.cost);
      if (cost) {
        const row = node("div", "card-cost", cost);
        row.title = "USD por millón de tokens";
        card.appendChild(row);
      }

      if (model.hint) card.appendChild(node("div", "card-detail", model.hint));

      if (claude) {
        // Sin favoritos, la tarjeta de MODELOS es el destino: no se arrastra, recibe agentes
        // y el clic resalta sus cables.
        if (sel && sel.kind === "modelo" && sel.id === model.id) card.classList.add("sel");
        acceptAgent(card, model);
        card.addEventListener("click", () => toggleSel("modelo", model.id));
        modelEls.set(model.id, card);
      } else {
        card.addEventListener("dragstart", (event) =>
          startDrag(event, { kind: "model", id: model.id })
        );
        card.addEventListener("dragend", endDrag);
      }
      el.models.appendChild(card);
    }
  }

  // ── Zonas de drop de columna ────────────────────────────
  el.favorites.addEventListener("dragover", (event) => {
    if (!drag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "link";
    el.favorites.classList.add("drop");
  });
  el.favorites.addEventListener("dragleave", (event) => {
    if (el.favorites.contains(event.relatedTarget)) return;
    el.favorites.classList.remove("drop");
  });
  el.favorites.addEventListener("drop", (event) => {
    if (!drag) return;
    event.preventDefault();
    // El agente lo recoge la tarjeta de favorito; aquí solo caen modelos.
    if (drag.kind === "model") {
      const id = drag.id;
      drag = null;
      clearDrop();
      post({ type: "toggleFavorite", id, on: true, group: groupBar.active });
    }
  });

  // La columna MODELOS es la papelera de favoritos: soltar un favorito lo desmarca.
  el.models.addEventListener("dragover", (event) => {
    if (!drag || drag.kind !== "model" || !favIds.has(drag.id)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "link";
    el.models.classList.add("drop");
  });
  el.models.addEventListener("dragleave", (event) => {
    if (el.models.contains(event.relatedTarget)) return;
    el.models.classList.remove("drop");
  });
  el.models.addEventListener("drop", (event) => {
    if (!drag || drag.kind !== "model" || !favIds.has(drag.id)) return;
    event.preventDefault();
    const id = drag.id;
    const group = drag.group === undefined ? groupBar.active : drag.group;
    drag = null;
    clearDrop();
    post({ type: "toggleFavorite", id, on: false, group });
  });

  // Sin dragend (drop fuera de la vista) las marcas se quedarían pegadas.
  window.addEventListener("drop", () => {
    if (drag) endDrag();
  });
  window.addEventListener("dragend", endDrag);

  // ── Selección ───────────────────────────────────────────
  // Clic en un agente o en un favorito (con Claude, un modelo): resalta el cable que los une.
  // Clic en lo ya seleccionado: deselecciona.
  function toggleSel(kind, id) {
    sel = sel && sel.kind === kind && sel.id === id ? null : { kind, id };
    markSel();
    drawWires();
  }

  function markSel() {
    for (const [key, card] of agentEls)
      card.classList.toggle("sel", !!sel && sel.kind === "agente" && sel.id === key);
    // Solo uno de los dos mapas tiene tarjetas: favoritos con opencode, modelos con Claude.
    for (const [id, card] of [...favEls, ...modelEls])
      card.classList.toggle("sel", !!sel && sel.kind === "modelo" && sel.id === id);
  }

  // ── Líneas ──────────────────────────────────────────────
  function visibleIn(rect, list) {
    const box = list.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom;
  }

  function round(value) {
    return Math.round(value * 10) / 10;
  }

  function drawWires() {
    const svg = el.wires;
    const box = svg.getBoundingClientRect();
    svg.textContent = "";
    if (!lastData || box.width < 1 || box.height < 1) return;
    // El cable acaba en el favorito; con Claude, en la tarjeta de MODELOS. Un modelo que el
    // buscador o un chip esconden no tiene tarjeta, así que tampoco cable.
    const targets = claude ? modelEls : favEls;
    const column = claude ? el.models : el.favorites;

    for (const agent of lastData.agents || []) {
      if (!agent.model || (!claude && !favIds.has(agent.model))) continue;
      const key = agentKey(agent);
      const from = agentEls.get(key);
      const to = targets.get(agent.model);
      if (!from || !to) continue;
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      if (!visibleIn(a, el.agents) || !visibleIn(b, column)) continue;

      const x1 = round(a.right - box.left);
      const y1 = round(a.top + a.height / 2 - box.top);
      const x2 = round(b.left - box.left);
      const y2 = round(b.top + b.height / 2 - box.top);
      const dx = round(Math.max(18, (x2 - x1) / 2));

      const path = document.createElementNS(SVG, "path");
      // El resaltado se deriva de sel aquí, porque el SVG se repinta entero en cada fotograma.
      const hot =
        (sel && sel.kind === "agente" && sel.id === key) ||
        (sel && sel.kind === "modelo" && sel.id === agent.model);
      if (hot) path.classList.add("hot");
      path.setAttribute(
        "d",
        "M" + x1 + " " + y1 + " C" + round(x1 + dx) + " " + y1 + " " + round(x2 - dx) + " " + y2 + " " + x2 + " " + y2
      );
      svg.appendChild(path);
    }
  }

  // scroll y resize llegan a rachas: un solo repintado por fotograma.
  function scheduleWires() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      drawWires();
    });
  }

  // ── Repintado ───────────────────────────────────────────
  function renderAssign(data) {
    if (!data) return;
    // Sin `kind`, opencode: el tablero de siempre.
    const kind = data.kind === "claude" ? "claude" : "opencode";
    // Cambiar de modo es como abrir el tablero: el buscador y los chips se siembran otra vez.
    if (kind !== mode) {
      mode = kind;
      claude = kind === "claude";
      // El filtro compara en minúsculas; el buscador conserva lo que escribió el usuario.
      query = (data.search || "").trim().toLowerCase();
      el.search.value = data.search || "";
      off.clear();
      for (const provider of data.disabledProviders || []) off.add(provider);
    }
    lastData = data;
    const agents = data.agents || [];
    const models = data.models || [];
    // El host ya no filtra los grupos por catálogo: los ids muertos se quedan fuera de las cuentas.
    catalogIds = new Set(models.map((m) => m.id));
    // Con Claude no hay grupos ni configuraciones: ni se siembran ni se pintan pestañas.
    let groups = [];
    let active = 0;
    let profiles = [];
    let activeProfile = 0;
    if (!claude) {
      // El host garantiza al menos un grupo; si llega vacío, se pinta uno vacío igualmente.
      groups =
        Array.isArray(data.favoriteGroups) && data.favoriteGroups.length > 0
          ? data.favoriteGroups
          : [{ name: "Favoritos", ids: [] }];
      active = Math.min(Math.max(0, Number(data.activeGroup) || 0), groups.length - 1);
      // Igual con las configuraciones: el host manda siempre al menos una.
      profiles =
        Array.isArray(data.profiles) && data.profiles.length > 0
          ? data.profiles
          : [{ name: "Configuración 1", assignments: {} }];
      activeProfile = Math.min(
        Math.max(0, Number(data.activeProfile) || 0),
        profiles.length - 1
      );
    }

    // El sondeo puede repetir los mismos datos: sin esta clave, el scroll y el foco saltan.
    const key = JSON.stringify([
      kind,
      agents,
      models,
      groups,
      active,
      profiles,
      activeProfile,
      query,
      [...off].sort(),
    ]);
    if (key === lastKey) return;
    lastKey = key;

    // Cada repintado aplica el modo que llega: el mismo webview puede recibir el otro.
    el.root.classList.toggle("claude", claude);
    el.kicker.textContent = claude ? KICKER + " · CLAUDE" : KICKER;
    el.hint.textContent = claude ? HINT_CLAUDE : HINT;

    groupBar.tabs = groups;
    groupBar.active = active;
    profileBar.tabs = profiles;
    profileBar.active = activeProfile;
    favIds = new Set(claude ? [] : groups[active].ids || []);

    // Tras crear, se salta a la pestaña nueva: la que no estaba antes en la barra.
    jumpToNew(groupBar);

    renderProviders(models);
    renderAgents(agents, models);
    if (claude) {
      // Columnas ocultas y vacías: ni pestañas ni favoritos de un opencode anterior.
      el.profiles.textContent = "";
      el.groups.textContent = "";
      el.favorites.textContent = "";
      favEls = new Map();
    } else {
      renderTabbar(profileBar);
      renderTabbar(groupBar);
      renderFavorites(models);
    }
    renderModelsColumn(models);
    scheduleWires();
  }

  function repaint() {
    lastKey = "";
    if (lastData) renderAssign(lastData);
  }

  // ── Eventos fijos ───────────────────────────────────────
  el.search.addEventListener("input", () => {
    query = el.search.value.trim().toLowerCase();
    repaint();
    persistView();
  });

  el.close.addEventListener("click", () => post({ type: "close" }));

  // ── Modal de borrado (grupo o configuración) ────────────
  el.modalOk.addEventListener("click", () => {
    const pending = pendingDelete;
    closeModal();
    if (!pending) return;
    post({ type: pending.bar.msg.remove, [pending.bar.msg.key]: pending.index });
  });
  el.modalCancel.addEventListener("click", closeModal);
  el.modal.addEventListener("click", (event) => {
    if (event.target === el.modal) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (el.modal.hidden) return;
    if (event.key === "Escape") {
      closeModal();
      return;
    }
    // Trampa de foco: Tab cicla entre CANCELAR y BORRAR y no escapa al tablero de detrás.
    if (event.key !== "Tab") return;
    event.preventDefault();
    (document.activeElement === el.modalOk ? el.modalCancel : el.modalOk).focus();
  });

  for (const list of [el.board, el.agents, el.favorites, el.models]) {
    list.addEventListener("scroll", scheduleWires, { passive: true });
  }
  window.addEventListener("resize", scheduleWires);
  new ResizeObserver(scheduleWires).observe(el.board);

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message && message.type === "assign") renderAssign(message.payload);
  });

  renderSort();
  vscode.postMessage({ type: "ready" });
})();
