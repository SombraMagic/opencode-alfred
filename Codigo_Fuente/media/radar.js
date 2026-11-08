/* ALFRED // RADAR DE NOTICIAS — lista, filtros y configuración del radar.
   Todo lo que llega de la base se pinta con `textContent`: nunca como HTML. */
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    status: document.getElementById("rd-status"),
    tabNoticias: document.getElementById("tab-noticias"),
    tabConfig: document.getElementById("tab-config"),
    panelNoticias: document.getElementById("panel-noticias"),
    panelConfig: document.getElementById("panel-config"),
    busqueda: document.getElementById("rd-busqueda"),
    btnBuscar: document.getElementById("btn-buscar"),
    btnActualizar: document.getElementById("btn-actualizar"),
    chips: document.getElementById("rd-chips"),
    aviso: document.getElementById("rd-aviso"),
    lista: document.getElementById("rd-lista"),
    detalle: document.getElementById("rd-detalle"),
    pieFuentes: document.getElementById("rd-pie-fuentes"),
    pieTotal: document.getElementById("rd-pie-total"),
    btnPrev: document.getElementById("btn-prev"),
    btnNext: document.getElementById("btn-next"),
    pagInfo: document.getElementById("rd-pag-info"),
    fuentes: document.getElementById("rd-fuentes"),
    temas: document.getElementById("rd-temas"),
    proveedor: document.getElementById("rd-proveedor"),
    modelo: document.getElementById("rd-modelo"),
    clave: document.getElementById("rd-clave"),
    btnClave: document.getElementById("btn-clave"),
    btnClaveBorrar: document.getElementById("btn-clave-borrar"),
    claveEstado: document.getElementById("rd-clave-estado"),
    perfil: document.getElementById("rd-perfil"),
    baseEstado: document.getElementById("rd-base-estado"),
    activo: document.getElementById("rd-activo"),
    umbral: document.getElementById("rd-umbral"),
    umbralValor: document.getElementById("rd-umbral-valor"),
    btnGuardar: document.getElementById("btn-guardar-config"),
    btnRepuntuar: document.getElementById("btn-repuntuar"),
  };

  let datos = null;
  let seleccion = null;
  let tab = "noticias";
  /** El usuario tocó el formulario: un `data` en vuelo no puede pisarlo. */
  let configSucio = false;

  const guardado = vscode.getState();
  if (guardado && (guardado.tab === "config" || guardado.tab === "noticias")) {
    tab = guardado.tab;
  }

  function act(action) {
    vscode.postMessage({ type: "action", action: action });
  }

  function texto(nodo, valor) {
    nodo.textContent = valor === null || valor === undefined ? "" : String(valor);
  }

  function fecha(ms) {
    if (!ms || ms <= 0) return "sin fecha";
    try {
      return new Date(ms).toLocaleString("es-ES", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return String(ms);
    }
  }

  /** Tamaño de página: el que manda el host, sin repetir el número aquí. */
  function tamPagina() {
    return (datos && datos.pagina) || 100;
  }

  function filaActual() {
    if (!datos || seleccion === null) return null;
    for (const f of datos.filas || []) {
      if (f.id === seleccion) return f;
    }
    return null;
  }

  // ── Estado de la pasada ──────────────────────────────────
  function renderEstado(estado, data) {
    el.status.className = "hud-status";
    if (!estado) {
      texto(el.status, "—");
    } else if (estado.fase === "working") {
      texto(el.status, estado.trabajando || "Trabajando…");
      el.status.classList.add("busy");
    } else if (estado.fase === "sinBase") {
      texto(el.status, "SIN BASE");
      el.status.classList.add("error");
    } else if (estado.fase === "error") {
      texto(el.status, "ERROR");
      el.status.classList.add("error");
    } else if (estado.ultimaPasada) {
      texto(el.status, "ÚLTIMA " + fecha(estado.ultimaPasada));
      el.status.classList.add("ok");
    } else {
      texto(el.status, "SIN PASADAS");
    }

    const lineas = [];
    let error = false;
    if (data && data.sinBase) {
      lineas.push("Sin conexión con MariaDB. " + data.sinBase);
      error = true;
    } else if (data && data.error) {
      lineas.push(data.error);
      error = true;
    }
    if (estado && estado.mensaje && (!data || estado.mensaje !== data.sinBase)) {
      lineas.push(estado.mensaje);
      if (estado.fase === "error" || estado.fase === "sinBase") error = true;
    }
    for (const f of (estado && estado.fallos) || []) {
      lineas.push(f.fuente + ": " + f.error);
    }
    el.aviso.hidden = lineas.length === 0;
    el.aviso.classList.toggle("error", error);
    texto(el.aviso, lineas.join(" · "));
    el.btnActualizar.disabled = Boolean(estado && estado.fase === "working");
  }

  // ── Chips de tema ────────────────────────────────────────
  function renderChips() {
    el.chips.textContent = "";
    const activo = (datos && datos.tema) || "";
    const temas = (datos && datos.temas) || [];
    agregarChip("TODOS", "", activo === "");
    for (const tema of temas) {
      agregarChip(tema, tema, activo === tema);
    }
  }

  function agregarChip(textoVisible, tema, on) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "rd-chip" + (on ? " on" : "");
    chip.textContent = textoVisible;
    chip.setAttribute("aria-pressed", on ? "true" : "false");
    chip.addEventListener("click", () => {
      act({ type: "list", busqueda: el.busqueda.value.trim(), tema: tema, offset: 0 });
    });
    el.chips.appendChild(chip);
  }

  // ── Lista ────────────────────────────────────────────────
  function renderLista() {
    el.lista.textContent = "";
    const filas = (datos && datos.filas) || [];
    if (filas.length === 0) {
      const vacio = document.createElement("li");
      vacio.className = "rd-vacio";
      texto(
        vacio,
        datos && datos.sinBase
          ? "Sin noticias: no hay conexión con MariaDB."
          : "Sin noticias para este filtro."
      );
      el.lista.appendChild(vacio);
      return;
    }
    for (const f of filas) {
      const li = document.createElement("li");
      const boton = document.createElement("button");
      boton.type = "button";
      boton.className =
        "rd-item" + (f.leida ? " leida" : "") + (seleccion === f.id ? " on" : "");
      boton.addEventListener("click", () => {
        seleccion = f.id;
        renderLista();
        renderDetalle();
      });

      const score = document.createElement("span");
      score.className = "rd-score";
      texto(score, f.score >= 0 ? f.score : "—");

      const cuerpo = document.createElement("span");
      const titular = document.createElement("span");
      titular.className = "rd-titular";
      texto(titular, f.titulo);
      const meta = document.createElement("span");
      meta.className = "rd-meta";
      texto(meta, f.fuente + (f.tema ? " · " + f.tema : "") + " · " + fecha(f.publicada));
      cuerpo.appendChild(titular);
      cuerpo.appendChild(meta);

      boton.appendChild(score);
      boton.appendChild(cuerpo);
      li.appendChild(boton);
      el.lista.appendChild(li);
    }
  }

  // ── Detalle ──────────────────────────────────────────────
  function renderDetalle() {
    el.detalle.textContent = "";
    const f = filaActual();
    if (!f) {
      const vacio = document.createElement("p");
      vacio.className = "rd-vacio";
      texto(vacio, "Elige una noticia de la lista.");
      el.detalle.appendChild(vacio);
      return;
    }

    const titulo = document.createElement("h2");
    texto(titulo, f.titulo);
    el.detalle.appendChild(titulo);

    const meta = document.createElement("div");
    meta.className = "rd-d-meta";
    const partes = [
      f.score >= 0 ? f.score + " puntos" : "sin puntuar",
      f.fuente,
      f.tema || "sin tema",
      fecha(f.publicada),
    ];
    if (f.autor) partes.push(f.autor);
    texto(meta, partes.join(" · "));
    el.detalle.appendChild(meta);

    const resumen = document.createElement("p");
    texto(resumen, f.resumen || "Sin resumen.");
    el.detalle.appendChild(resumen);

    const enlace = document.createElement("span");
    enlace.className = "rd-d-enlace";
    texto(enlace, f.enlace);
    el.detalle.appendChild(enlace);

    const acciones = document.createElement("div");
    acciones.className = "rd-d-acciones";

    acciones.appendChild(
      botonAccion("ABRIR", "Abrir la noticia en el navegador", false, () => {
        act({ type: "abrir", enlace: f.enlace });
      })
    );
    acciones.appendChild(
      botonAccion(
        "GUARDAR",
        f.guardada ? "Quitar de guardadas" : "Guardar la noticia",
        f.guardada,
        () => act({ type: "marcar", id: f.id, campo: "guardada", valor: !f.guardada })
      )
    );
    acciones.appendChild(
      botonAccion(
        "LEÍDA",
        f.leida ? "Marcar como no leída" : "Marcar como leída",
        f.leida,
        () => act({ type: "marcar", id: f.id, campo: "leida", valor: !f.leida })
      )
    );
    el.detalle.appendChild(acciones);
  }

  function botonAccion(etiqueta, titulo, on, alPulsar) {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "ghost-btn" + (on ? " rd-banderas" : "");
    boton.title = titulo;
    boton.setAttribute("aria-pressed", on ? "true" : "false");
    boton.textContent = etiqueta;
    boton.addEventListener("click", alPulsar);
    return boton;
  }

  // ── Pie ──────────────────────────────────────────────────
  function renderPie() {
    const fuentes = (datos && datos.fuentes) || [];
    const activas = fuentes.filter((f) => f.activa).length;
    texto(el.pieFuentes, activas + " de " + fuentes.length + " fuentes activas");

    const total = datos ? datos.total : -1;
    texto(el.pieTotal, total < 0 ? "Sin conexión con MariaDB" : total + " noticia(s) en total");

    const offset = datos ? datos.offset : 0;
    const n = datos ? (datos.filas || []).length : 0;
    texto(el.pagInfo, total > 0 && n > 0 ? offset + 1 + "–" + (offset + n) + " de " + total : "");
    el.btnPrev.disabled = offset <= 0;
    el.btnNext.disabled = total < 0 || n === 0 || offset + n >= total;
  }

  // ── Configuración ────────────────────────────────────────
  function renderConfig(data) {
    el.fuentes.textContent = "";
    for (const fuente of data.fuentes || []) {
      const li = document.createElement("li");
      li.className = "rd-fuente";
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = fuente.activa === true;
      chk.value = fuente.id;
      chk.setAttribute("aria-label", "Leer " + fuente.nombre);
      chk.addEventListener("change", () => {
        configSucio = true;
      });
      const nombre = document.createElement("span");
      texto(nombre, fuente.nombre);
      const url = document.createElement("span");
      url.className = "rd-url";
      url.title = fuente.url;
      texto(url, fuente.url);
      li.appendChild(chk);
      li.appendChild(nombre);
      li.appendChild(url);
      if (fuente.ultimoError) {
        const fallo = document.createElement("span");
        fallo.className = "rd-fuente-error";
        fallo.title = fuente.ultimoError;
        texto(fallo, fuente.ultimoError);
        li.appendChild(fallo);
      }
      el.fuentes.appendChild(li);
    }

    el.temas.textContent = "";
    for (const tema of data.temas || []) {
      const li = document.createElement("li");
      li.className = "rd-tema";
      texto(li, "· " + tema);
      el.temas.appendChild(li);
    }

    el.proveedor.value = data.proveedor;
    el.modelo.value = data.modelo || "";
    el.umbral.value = String(data.umbral);
    texto(el.umbralValor, data.umbral);

    el.perfil.textContent = "";
    const primero = document.createElement("option");
    primero.value = "";
    primero.textContent = "El primero guardado";
    el.perfil.appendChild(primero);
    for (const perfil of data.perfiles || []) {
      const opcion = document.createElement("option");
      opcion.value = perfil.id;
      opcion.textContent =
        perfil.name + (perfil.hasPassword ? "" : " · sin contraseña guardada");
      el.perfil.appendChild(opcion);
    }
    el.perfil.value = data.profileId || "";

    el.claveEstado.className = "rd-hint";
    texto(
      el.claveEstado,
      data.hasClave
        ? "Clave guardada en el llavero de VS Code."
        : "Sin clave guardada: Ollama no la necesita."
    );
  }

  function renderBase(data) {
    if (!data) return;
    if (data.sinBase) {
      el.baseEstado.className = "rd-hint error";
      texto(el.baseEstado, "Sin conexión con MariaDB. " + data.sinBase);
    } else if (data.error) {
      el.baseEstado.className = "rd-hint error";
      texto(el.baseEstado, data.error);
    } else {
      el.baseEstado.className = "rd-hint";
      texto(el.baseEstado, "Conectada al perfil configurado.");
    }
  }

  function guardarConfig() {
    const activas = [];
    for (const chk of el.fuentes.querySelectorAll("input[type=checkbox]")) {
      if (chk.checked) activas.push(chk.value);
    }
    act({
      type: "guardarConfig",
      activas: activas,
      proveedor: el.proveedor.value,
      modelo: el.modelo.value.trim(),
      umbral: Number(el.umbral.value),
      profileId: el.perfil.value,
    });
    configSucio = false;
  }

  // ── Datos completos ──────────────────────────────────────
  function renderDatos(data) {
    datos = data;
    if (seleccion !== null && !filaActual()) {
      seleccion = null;
    }
    el.activo.checked = data.activo === true;
    renderEstado(data.estado || null, data);
    renderChips();
    renderLista();
    renderDetalle();
    renderPie();
    renderBase(data);
    if (!configSucio) {
      renderConfig(data);
    }
  }

  // ── Pestañas ─────────────────────────────────────────────
  function setTab(next) {
    tab = next;
    vscode.setState({ tab: tab });
    // Al cambiar de pestaña se vuelve a pintar la configuración con lo recibido: si el
    // formulario quedó sucio sin guardar, no se congela para siempre.
    configSucio = false;
    el.tabNoticias.classList.toggle("on", tab === "noticias");
    el.tabConfig.classList.toggle("on", tab === "config");
    el.tabNoticias.setAttribute("aria-selected", tab === "noticias" ? "true" : "false");
    el.tabConfig.setAttribute("aria-selected", tab === "config" ? "true" : "false");
    el.panelNoticias.hidden = tab !== "noticias";
    el.panelConfig.hidden = tab !== "config";
    if (tab === "config" && datos && !configSucio) {
      renderConfig(datos);
    }
  }

  // ── Cableado ─────────────────────────────────────────────
  el.tabNoticias.addEventListener("click", () => setTab("noticias"));
  el.tabConfig.addEventListener("click", () => setTab("config"));

  el.btnBuscar.addEventListener("click", () => {
    act({
      type: "list",
      busqueda: el.busqueda.value.trim(),
      tema: (datos && datos.tema) || "",
      offset: 0,
    });
  });
  el.busqueda.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      el.btnBuscar.click();
    }
  });

  el.btnActualizar.addEventListener("click", () => act({ type: "sync" }));
  el.btnRepuntuar.addEventListener("click", () => act({ type: "repuntuar" }));

  el.btnPrev.addEventListener("click", () => {
    act({
      type: "list",
      busqueda: el.busqueda.value.trim(),
      tema: (datos && datos.tema) || "",
      offset: Math.max(0, ((datos && datos.offset) || 0) - tamPagina()),
    });
  });
  el.btnNext.addEventListener("click", () => {
    act({
      type: "list",
      busqueda: el.busqueda.value.trim(),
      tema: (datos && datos.tema) || "",
      offset: ((datos && datos.offset) || 0) + tamPagina(),
    });
  });

  el.btnClave.addEventListener("click", () => {
    const clave = el.clave.value.trim();
    if (!clave) return;
    act({ type: "setClave", clave: clave });
    el.clave.value = "";
  });
  el.btnClaveBorrar.addEventListener("click", () => act({ type: "borrarClave" }));
  el.btnGuardar.addEventListener("click", guardarConfig);
  el.activo.addEventListener("change", () =>
    act({ type: "setActivo", on: el.activo.checked })
  );

  for (const nodo of [el.proveedor, el.modelo, el.perfil, el.umbral]) {
    nodo.addEventListener("input", () => {
      configSucio = true;
    });
  }
  el.umbral.addEventListener("input", () => texto(el.umbralValor, el.umbral.value));

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message) return;
    if (message.type === "data") {
      renderDatos(message.payload);
      return;
    }
    if (message.type === "estado") {
      renderEstado(message.estado, datos);
      return;
    }
    if (message.type === "aviso") {
      el.aviso.hidden = false;
      el.aviso.classList.add("error");
      texto(el.aviso, message.text || "Error desconocido.");
    }
  });

  setTab(tab);
  vscode.postMessage({ type: "ready" });
})();
