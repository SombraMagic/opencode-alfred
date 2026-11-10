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
    nota: document.getElementById("rd-nota"),
    temas: document.getElementById("rd-temas"),
    temaAdd: document.getElementById("btn-tema-add"),
    temaForm: document.getElementById("rd-tema-form"),
    temaFormTitle: document.getElementById("rd-tema-form-title"),
    temaNombre: document.getElementById("rd-tema-nombre"),
    temaIncluir: document.getElementById("rd-tema-incluir"),
    temaExcluir: document.getElementById("rd-tema-excluir"),
    btnTemaGuardar: document.getElementById("btn-tema-guardar"),
    btnTemaCancelar: document.getElementById("btn-tema-cancelar"),
    proveedor: document.getElementById("rd-proveedor"),
    modelo: document.getElementById("rd-modelo"),
    clave: document.getElementById("rd-clave"),
    btnClave: document.getElementById("btn-clave"),
    btnClaveBorrar: document.getElementById("btn-clave-borrar"),
    claveEstado: document.getElementById("rd-clave-estado"),
    traducir: document.getElementById("rd-traducir"),
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
  /** Id del tema en edición; `""` = tema nuevo; `null` = formulario cerrado. */
  let temaEditando = null;
  /** Id del tema pendiente de confirmar su borrado. */
  let temaQuitar = null;

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
        year: "numeric",
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
      agregarChip(tema.nombre, tema.nombre, activo === tema.nombre);
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
      texto(titular, f.tituloEs || f.titulo);
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
    texto(titulo, f.tituloEs || f.titulo);
    el.detalle.appendChild(titulo);

    // Con traducción guardada, el titular original queda a la vista en una línea pequeña.
    if (f.tituloEs) {
      const original = document.createElement("div");
      original.className = "rd-d-original";
      texto(original, f.titulo);
      el.detalle.appendChild(original);
    }

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
    texto(resumen, f.resumenEs || f.resumen || "Sin resumen.");
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
      li.appendChild(chk);
      li.appendChild(nombre);
      // Chip del tema fijo: la fuente temática entra siempre con ese tema. Sin tema
      // fijo no se pinta nada (no es un hueco vacío).
      if (fuente.temaFijo) {
        const chip = document.createElement("span");
        chip.className = "rd-tema-fijo";
        chip.title = "Tema fijo de la fuente: " + fuente.temaFijo;
        texto(chip, fuente.temaFijo);
        li.appendChild(chip);
      }
      const url = document.createElement("span");
      url.className = "rd-url";
      url.title = fuente.url;
      texto(url, fuente.url);
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

  // ── Temas ────────────────────────────────────────────────
  /**
   * Iconos de las filas de temas. Son constantes de este fichero: del host solo
   * llegan nombres y contadores, nunca SVG.
   */
  const ICONS = {
    editar:
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/>' +
      '<path d="M14.5 5.5l3 3"/>' +
      "</svg>",
    quitar:
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<path d="M4 7h16"/>' +
      '<path d="M9.5 7V4.5h5V7"/>' +
      '<path d="M6.5 7l1 13h9l1-13"/>' +
      '<path d="M10 11v5M14 11v5"/>' +
      "</svg>",
  };

  /** Una fila por tema y, si toca, la confirmación de borrado en el propio bloque. */
  function renderTemas(data) {
    el.temas.textContent = "";
    const temas = (data && data.temas) || [];
    if (temas.length === 0) {
      const vacio = document.createElement("li");
      vacio.className = "rd-vacio";
      texto(vacio, "Sin temas: el radar no filtra por palabras y el LLM puntúa con el tema «General».");
      el.temas.appendChild(vacio);
      return;
    }
    for (const tema of temas) {
      if (tema.id === temaQuitar) {
        el.temas.appendChild(filaConfirmar(tema));
        continue;
      }
      const li = document.createElement("li");
      li.className = "rd-tema";
      const nombre = document.createElement("span");
      nombre.className = "rd-tema-nombre";
      nombre.title = tema.nombre;
      texto(nombre, tema.nombre);
      const cuenta = document.createElement("span");
      cuenta.className = "rd-tema-cuenta";
      texto(cuenta, (tema.incluir || []).length + " inc · " + (tema.excluir || []).length + " exc");
      li.appendChild(nombre);
      li.appendChild(cuenta);
      li.appendChild(botonIcono("editar", "Editar el tema", () => abrirTemaForm(tema), "rd-tema-editar"));
      li.appendChild(
        botonIcono(
          "quitar",
          "Quitar el tema",
          () => {
            temaQuitar = tema.id;
            renderTemas(datos);
          },
          "rd-tema-quitar"
        )
      );
      el.temas.appendChild(li);
    }
  }

  function filaConfirmar(tema) {
    const li = document.createElement("li");
    li.className = "rd-tema";
    const pregunta = document.createElement("span");
    pregunta.className = "rd-tema-nombre";
    texto(pregunta, "¿Quitar «" + tema.nombre + "»?");
    li.appendChild(pregunta);
    li.appendChild(botonTema("SÍ, QUITAR", () => quitarTema(tema.id), "rd-tema-quitar"));
    li.appendChild(
      botonTema("CANCELAR", () => {
        temaQuitar = null;
        renderTemas(datos);
      })
    );
    return li;
  }

  function botonTema(etiqueta, alPulsar, clase) {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "ghost-btn rd-tema-btn" + (clase ? " " + clase : "");
    boton.textContent = etiqueta;
    boton.addEventListener("click", alPulsar);
    return boton;
  }

  /** Botón de icono: el SVG sale de ICONS y la etiqueta solo va en `title` y `aria-label`. */
  function botonIcono(icono, etiqueta, alPulsar, clase) {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "rd-icon-btn" + (clase ? " " + clase : "");
    boton.title = etiqueta;
    boton.setAttribute("aria-label", etiqueta);
    boton.innerHTML = ICONS[icono];
    boton.addEventListener("click", alPulsar);
    return boton;
  }

  function abrirTemaForm(tema) {
    temaEditando = tema ? tema.id : "";
    temaQuitar = null;
    texto(el.temaFormTitle, tema ? "EDITAR TEMA" : "NUEVO TEMA");
    el.temaNombre.value = tema ? tema.nombre : "";
    el.temaIncluir.value = tema ? (tema.incluir || []).join("\n") : "";
    el.temaExcluir.value = tema ? (tema.excluir || []).join("\n") : "";
    el.temaForm.hidden = false;
    el.temaAdd.hidden = true;
    renderTemas(datos);
    el.temaNombre.focus();
  }

  function cerrarTemaForm() {
    temaEditando = null;
    temaQuitar = null;
    el.temaForm.hidden = true;
    el.temaAdd.hidden = false;
    el.temaNombre.value = "";
    el.temaIncluir.value = "";
    el.temaExcluir.value = "";
  }

  function lineasDe(valor) {
    return String(valor || "")
      .split("\n")
      .map((linea) => linea.trim())
      .filter((linea) => linea.length > 0);
  }

  function guardarTemaForm() {
    const nombre = el.temaNombre.value.trim();
    const incluir = lineasDe(el.temaIncluir.value);
    const excluir = lineasDe(el.temaExcluir.value);
    const temas = ((datos && datos.temas) || []).map((t) => ({
      id: t.id,
      nombre: t.nombre,
      incluir: (t.incluir || []).slice(),
      excluir: (t.excluir || []).slice(),
    }));
    const indice = temaEditando ? temas.findIndex((t) => t.id === temaEditando) : -1;
    if (indice >= 0) {
      temas[indice] = { id: temas[indice].id, nombre, incluir, excluir };
    } else {
      // El id vacío lo rellena el host: aquí no se inventa.
      temas.push({ id: "", nombre, incluir, excluir });
    }
    act({ type: "guardarTemas", temas });
  }

  function quitarTema(id) {
    temaQuitar = null;
    const temas = ((datos && datos.temas) || [])
      .filter((t) => t.id !== id)
      .map((t) => ({
        id: t.id,
        nombre: t.nombre,
        incluir: (t.incluir || []).slice(),
        excluir: (t.excluir || []).slice(),
      }));
    act({ type: "guardarTemas", temas });
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
      traducir: el.traducir.checked,
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
    // La casilla de traducción se pinta siempre, aunque el formulario esté sucio: si se
    // quedaba dentro de `renderConfig`, un dato viejo la devolvía a apagada y parecía que
    // no se guardaba.
    el.traducir.checked = data.traducir === true;
    renderEstado(data.estado || null, data);
    renderChips();
    renderLista();
    renderDetalle();
    renderPie();
    renderBase(data);
    // Los temas no viven del formulario grande: se repintan siempre, y el formulario de
    // edición (HTML fijo) no se toca, así que un `data` en vuelo no pierde lo escrito.
    renderTemas(data);
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
    if (tab === "config" && datos) {
      if (!configSucio) {
        renderConfig(datos);
      }
      renderTemas(datos);
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
  el.temaAdd.addEventListener("click", () => abrirTemaForm(null));
  el.btnTemaGuardar.addEventListener("click", guardarTemaForm);
  el.btnTemaCancelar.addEventListener("click", cerrarTemaForm);
  el.nota.addEventListener("click", () => {
    el.nota.hidden = true;
  });
  el.activo.addEventListener("change", () =>
    act({ type: "setActivo", on: el.activo.checked })
  );

  for (const nodo of [el.proveedor, el.modelo, el.perfil, el.umbral]) {
    nodo.addEventListener("input", () => {
      configSucio = true;
    });
  }
  el.traducir.addEventListener("change", () => {
    configSucio = true;
  });
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
    if (message.type === "temasGuardados") {
      // Solo se cierra con el acuse del host: si la validación falló, el aviso llega antes
      // y lo escrito sigue en el formulario.
      cerrarTemaForm();
      renderTemas(datos);
      return;
    }
    if (message.type === "aviso") {
      // Los avisos van a su propia línea: el estado de la pasada repinta `#rd-aviso` y
      // antes se llevaba por delante el recordatorio de repuntuar.
      el.nota.hidden = false;
      el.nota.classList.toggle("error", message.tono !== "info");
      texto(el.nota, message.text || "Error desconocido.");
    }
  });

  setTab(tab);
  vscode.postMessage({ type: "ready" });
})();
