/* Mente local — HUD del cerebro Ollama: interruptor, modelos, descarga, instalación y servidor.
   Solo pinta `state` y manda acciones por `postMessage`; no guarda nada propio. */

(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const interruptor = $("power");
  const punto = $("power-dot");
  const textoInterruptor = $("power-text");
  const resumen = $("resumen");
  const aviso = $("aviso");

  const bloqueModelos = $("bloque-modelos");
  const contador = $("modelos-count");
  const listaModelos = $("modelos");
  const vacioModelos = $("modelos-vacio");
  const filtro = $("filtro");
  const botonesOrden = Array.from(document.querySelectorAll(".ord"));

  const bloqueDescargar = $("bloque-descargar");
  const campoDescarga = $("modelo");
  const botonDescargar = $("descargar");
  const botonCancelar = $("cancelar");
  const pull = $("pull");
  const pullModelo = $("pull-model");
  const pullPct = $("pull-pct");
  const pullBarra = $("pull-bar");
  const pullRelleno = $("pull-fill");
  const pullEstado = $("pull-status");
  const pullBytes = $("pull-bytes");

  const bloqueInstalar = $("bloque-instalar");
  const instalarSiNo = $("instalar-si-no");
  const instalarSi = $("instalar-si");
  const botonInstalar = $("instalar");
  const botonDesinstalar = $("desinstalar");
  const botonAbrir = $("abrirCarpeta");
  const botonRefrescar = $("refrescar");
  const rutaModelos = $("ruta-modelos");

  const bloqueServidor = $("bloque-servidor");
  const campoServidor = $("servidor");
  const botonGuardar = $("guardarServidor");
  const botonArrancar = $("arrancarServidor");
  const botonParar = $("pararServidor");

  /** Tareas del host, en el texto del interruptor mientras dura la operación. */
  const TAREAS = {
    instalando: "INSTALANDO…",
    desinstalando: "DESINSTALANDO…",
    arrancando: "ARRANCANDO…",
    parando: "PARANDO…",
    guardando: "GUARDANDO…",
  };

  const unDecimal = new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const entero = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });

  const comparadores = {
    nombre: (a, b) => a.name.localeCompare(b.name, "es"),
    tamano: (a, b) => b.sizeBytes - a.sizeBytes,
    recientes: (a, b) => String(b.modified || "").localeCompare(String(a.modified || "")),
  };

  const guardado = vscode.getState() || {};
  let estado = null;
  let orden = Object.prototype.hasOwnProperty.call(comparadores, guardado.orden)
    ? guardado.orden
    : "nombre";
  let aguja = typeof guardado.filtro === "string" ? guardado.filtro : "";

  if (aguja) {
    filtro.value = aguja;
  }

  function accion(mensaje) {
    vscode.postMessage(mensaje);
  }

  function guardarPreferencias() {
    vscode.setState({ orden, filtro: filtro.value });
  }

  /** Un decimal en GB, entero en MB por debajo de 1 GB. */
  function bytes(n) {
    if (typeof n !== "number" || !isFinite(n) || n < 0) {
      return "—";
    }
    const gb = n / 1073741824;
    if (gb >= 1) {
      return `${unDecimal.format(gb)} GB`;
    }
    const mb = n / 1048576;
    if (mb >= 1) {
      return `${entero.format(mb)} MB`;
    }
    return `${entero.format(n / 1024)} KB`;
  }

  function plural(n, uno, varios) {
    return `${entero.format(n)} ${n === 1 ? uno : varios}`;
  }

  // ── Confirmación en dos pasos, sin `confirm()` ──────────────────────────────
  /* El primer clic arma el botón; el segundo, antes de 4 s, ejecuta. La lista se
     repinta con cada `state`, así que el armado vive en un conjunto por clave y se
     vuelve a aplicar a los botones nuevos. */
  const pendientes = new Set();
  const relojes = new Map();

  function soltar(clave) {
    pendientes.delete(clave);
    const reloj = relojes.get(clave);
    if (reloj !== undefined) {
      clearTimeout(reloj);
      relojes.delete(clave);
    }
  }

  function marcarPendientes() {
    for (const boton of document.querySelectorAll("[data-confirm]")) {
      const armado = pendientes.has(boton.dataset.confirm);
      boton.classList.toggle("confirmar", armado);
      boton.textContent = armado ? "¿SEGURO?" : boton.dataset.label || "";
    }
  }

  function confirmar(clave) {
    if (!pendientes.has(clave)) {
      pendientes.add(clave);
      relojes.set(
        clave,
        setTimeout(() => {
          soltar(clave);
          marcarPendientes();
        }, 4000)
      );
      marcarPendientes();
      return false;
    }
    soltar(clave);
    marcarPendientes();
    return true;
  }

  // ── Pintado ────────────────────────────────────────────────────────────────
  function trozo(texto, clase) {
    const span = document.createElement("span");
    span.className = `r-item${clase ? ` ${clase}` : ""}`;
    span.textContent = texto;
    return span;
  }

  function pintarResumen(s) {
    resumen.textContent = "";
    const piezas = [
      trozo(
        s.installed
          ? s.version
            ? `Ollama ${s.version}`
            : "Ollama instalado"
          : "Ollama no instalado",
        "fuerte"
      ),
    ];
    if (s.installed) {
      piezas.push(trozo(s.running ? "servidor en marcha" : "servidor parado", s.running ? "ok" : "off"));
      if (s.running || s.models.length) {
        piezas.push(
          trozo(`${plural(s.models.length, "modelo", "modelos")} · ${bytes(s.modelsBytes)}`)
        );
      }
      if (s.freeBytes !== null && s.freeBytes !== undefined) {
        piezas.push(trozo(`${bytes(s.freeBytes)} libres`));
      }
    }
    piezas.forEach((pieza, i) => {
      if (i) {
        const sep = document.createElement("span");
        sep.className = "r-sep";
        sep.textContent = "·";
        resumen.append(sep);
      }
      resumen.append(pieza);
    });
  }

  function ponerAviso(texto, esError) {
    aviso.textContent = texto || "";
    aviso.hidden = !texto;
    aviso.title = texto || "";
    aviso.classList.toggle("error", Boolean(texto) && Boolean(esError));
  }

  function chip(texto, clase, explicacion) {
    const span = document.createElement("span");
    span.className = `chip ${clase}`;
    span.textContent = texto;
    if (explicacion) {
      span.title = explicacion;
    }
    return span;
  }

  function filaModelo(modelo, s, ocupado) {
    const fila = document.createElement("li");
    fila.className = "mrow";
    if (modelo.family) {
      fila.title = `Familia ${modelo.family}`;
    }

    const principal = document.createElement("div");
    principal.className = "m-main";

    const nombre = document.createElement("span");
    nombre.className = "m-name";
    nombre.textContent = modelo.name;
    principal.append(nombre);

    if (modelo.parameters) {
      const parametros = document.createElement("span");
      parametros.className = "m-params";
      parametros.textContent = modelo.parameters;
      parametros.title = "Parámetros del modelo";
      principal.append(parametros);
    }

    if (modelo.loaded) {
      principal.append(chip("EN MEMORIA", "mem"));
    }
    const esPreferido = modelo.name === s.model;
    if (esPreferido) {
      principal.append(
        chip(
          "PREFERIDO",
          "def",
          "El modelo que usará Alfred en sus funciones locales; no cambia el modelo de opencode"
        )
      );
    }

    const tamano = document.createElement("span");
    tamano.className = "m-size";
    tamano.textContent = bytes(modelo.sizeBytes);

    const acciones = document.createElement("div");
    acciones.className = "m-actions";

    const usar = document.createElement("button");
    usar.type = "button";
    usar.className = "btn mini";
    usar.textContent = "PREFERIR";
    usar.dataset.accion = "usar";
    usar.dataset.model = modelo.name;
    usar.disabled = ocupado || esPreferido;
    usar.title = esPreferido
      ? "Ya es el modelo preferido de Alfred"
      : "Marcar como modelo preferido de Alfred (no cambia el de opencode)";

    const clave = `borrar:${modelo.name}`;
    const borrar = document.createElement("button");
    borrar.type = "button";
    borrar.className = "btn mini danger";
    borrar.dataset.accion = "borrar";
    borrar.dataset.model = modelo.name;
    borrar.dataset.confirm = clave;
    borrar.dataset.label = "BORRAR";
    borrar.disabled = ocupado;
    borrar.title = `Borrar ${modelo.name} del disco`;

    acciones.append(usar, borrar);
    fila.append(principal, tamano, acciones);
    return fila;
  }

  function pintarModelos(s, ocupado) {
    bloqueModelos.hidden = !s.installed;
    if (!s.installed) {
      return;
    }

    for (const boton of botonesOrden) {
      const activo = boton.dataset.orden === orden;
      boton.classList.toggle("on", activo);
      boton.setAttribute("aria-pressed", activo ? "true" : "false");
    }

    const visibles = s.models
      .filter((modelo) => !aguja || modelo.name.toLowerCase().includes(aguja.toLowerCase()))
      .sort(comparadores[orden]);

    if (!s.models.length) {
      contador.textContent = "";
    } else if (aguja) {
      contador.textContent = `${visibles.length} de ${s.models.length}`;
    } else {
      contador.textContent = plural(s.models.length, "modelo", "modelos");
    }

    listaModelos.textContent = "";
    for (const modelo of visibles) {
      listaModelos.append(filaModelo(modelo, s, ocupado));
    }

    vacioModelos.hidden = visibles.length > 0;
    if (!visibles.length) {
      if (!s.models.length) {
        vacioModelos.textContent = s.running
          ? "Sin modelos instalados. Descarga uno en DESCARGAR."
          : "Arranca el servidor para verlos.";
      } else {
        vacioModelos.textContent = `Ningún modelo coincide con «${aguja}».`;
      }
    }
  }

  function pintarDescarga(s, ocupado) {
    bloqueDescargar.hidden = !s.installed;
    if (!s.installed) {
      return;
    }

    const activo = Boolean(s.pull);
    campoDescarga.disabled = ocupado || activo;
    botonDescargar.disabled = ocupado || activo || !campoDescarga.value.trim();
    botonCancelar.hidden = !activo;
    botonCancelar.disabled = ocupado;

    pull.hidden = !activo;
    if (!activo) {
      pullRelleno.style.width = "";
      pullBarra.classList.remove("indet");
      return;
    }

    const total = s.pull.total;
    const hayTotal = total > 0;
    const pct = hayTotal ? Math.min(100, Math.max(0, (s.pull.completed / total) * 100)) : 0;

    pullModelo.textContent = s.pull.model;
    pullModelo.title = s.pull.model;
    pullEstado.textContent = s.pull.status || "descargando";
    pullEstado.title = s.pull.status || "";
    pullBarra.classList.toggle("indet", !hayTotal);
    if (hayTotal) {
      pullBarra.setAttribute("aria-valuenow", String(Math.floor(pct)));
      pullBarra.removeAttribute("aria-valuetext");
    } else {
      pullBarra.removeAttribute("aria-valuenow");
    }
    pullRelleno.style.width = hayTotal ? `${pct.toFixed(1)}%` : "";
    pullPct.textContent = hayTotal ? `${entero.format(Math.floor(pct))} %` : "";
    pullBytes.textContent = hayTotal ? `${bytes(s.pull.completed)} / ${bytes(total)}` : "";
  }

  function pintarInstalacion(s, ocupado) {
    instalarSiNo.hidden = s.installed;
    instalarSi.hidden = !s.installed;
    botonInstalar.disabled = ocupado;
    botonDesinstalar.disabled = ocupado;
    botonAbrir.disabled = ocupado;
    botonRefrescar.disabled = ocupado;

    if (s.installed) {
      rutaModelos.textContent = s.modelsDir || "—";
      rutaModelos.title = s.modelsDir || "";
    } else {
      // Sin Ollama no hay nada que un desinstalar armado pueda hacer.
      soltar("desinstalar");
    }
  }

  function normalizarURL(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  function urlValida(url) {
    return /^https?:\/\/\S+$/i.test(url) && url.length <= 200;
  }

  function revisarServidor() {
    if (!estado) {
      return;
    }
    const valor = campoServidor.value.trim();
    const valida = urlValida(valor);
    campoServidor.classList.toggle("mal", valor !== "" && !valida);
    botonGuardar.disabled =
      Boolean(estado.busy) ||
      !valida ||
      normalizarURL(valor) === normalizarURL(estado.baseURL);
  }

  function pintarServidor(s) {
    bloqueServidor.hidden = !s.installed;
    if (document.activeElement !== campoServidor) {
      campoServidor.value = s.baseURL || "";
      campoServidor.classList.remove("mal");
    }
    revisarServidor();
    botonArrancar.disabled = !s.installed || s.running || Boolean(s.busy);
    botonParar.disabled = !s.installed || !s.running || Boolean(s.busy);
  }

  function pintar(s) {
    estado = s;
    const ocupado = Boolean(s.busy);

    interruptor.classList.toggle("on", s.enabled);
    interruptor.setAttribute("aria-pressed", s.enabled ? "true" : "false");
    interruptor.disabled = ocupado;
    punto.classList.toggle("on", s.enabled);
    punto.classList.toggle("off", !s.enabled);
    punto.classList.toggle("pulsa", ocupado);
    textoInterruptor.textContent = s.busy
      ? TAREAS[s.busy] || s.busy.toUpperCase()
      : s.enabled
        ? "ENCENDIDA"
        : "APAGADA";
    interruptor.title = s.enabled
      ? "Apagar el cerebro local (Ollama)"
      : "Encender el cerebro local (Ollama)";

    pintarResumen(s);
    ponerAviso(s.message, false);
    pintarModelos(s, ocupado);
    pintarDescarga(s, ocupado);
    pintarInstalacion(s, ocupado);
    pintarServidor(s);
    marcarPendientes();
  }

  // ── Acciones ───────────────────────────────────────────────────────────────
  interruptor.addEventListener("click", () => {
    if (!estado || estado.busy) {
      return;
    }
    accion({ type: "setEnabled", on: !estado.enabled });
  });

  botonArrancar.addEventListener("click", () => {
    if (!estado || estado.busy) {
      return;
    }
    accion({ type: "startServer" });
  });

  botonParar.addEventListener("click", () => {
    if (!estado || estado.busy) {
      return;
    }
    accion({ type: "stopServer" });
  });

  for (const boton of botonesOrden) {
    boton.addEventListener("click", () => {
      orden = boton.dataset.orden;
      guardarPreferencias();
      if (estado) {
        pintar(estado);
      }
    });
  }

  filtro.addEventListener("input", () => {
    aguja = filtro.value.trim();
    guardarPreferencias();
    if (estado) {
      pintar(estado);
    }
  });

  listaModelos.addEventListener("click", (evento) => {
    const boton = evento.target.closest("button");
    if (!boton || boton.disabled || !listaModelos.contains(boton)) {
      return;
    }
    const model = boton.dataset.model;
    if (boton.dataset.accion === "usar") {
      accion({ type: "setModel", model });
      return;
    }
    if (boton.dataset.accion === "borrar" && confirmar(`borrar:${model}`)) {
      accion({ type: "delete", model });
    }
  });

  function enviarDescarga() {
    const model = campoDescarga.value.trim();
    if (!model || !estado || estado.busy || estado.pull) {
      return;
    }
    accion({ type: "pull", model });
  }

  botonDescargar.addEventListener("click", enviarDescarga);
  campoDescarga.addEventListener("keydown", (evento) => {
    if (evento.key === "Enter") {
      enviarDescarga();
    }
  });
  campoDescarga.addEventListener("input", () => {
    if (estado) {
      pintarDescarga(estado, Boolean(estado.busy));
    }
  });
  botonCancelar.addEventListener("click", () => accion({ type: "cancelPull" }));

  botonInstalar.addEventListener("click", () => accion({ type: "install" }));
  botonDesinstalar.addEventListener("click", () => {
    if (confirmar("desinstalar")) {
      accion({ type: "uninstall" });
    }
  });
  botonAbrir.addEventListener("click", () => accion({ type: "openModelsDir" }));
  botonRefrescar.addEventListener("click", () => accion({ type: "refresh" }));

  campoServidor.addEventListener("input", revisarServidor);
  botonGuardar.addEventListener("click", () => {
    const url = campoServidor.value.trim();
    if (!urlValida(url)) {
      campoServidor.classList.add("mal");
      campoServidor.focus();
      return;
    }
    accion({ type: "setBaseURL", url });
  });

  window.addEventListener("message", (evento) => {
    const mensaje = evento.data;
    if (!mensaje || typeof mensaje !== "object") {
      return;
    }
    if (mensaje.type === "state" && mensaje.state) {
      pintar(mensaje.state);
    }
  });

  vscode.postMessage({ type: "ready" });
})();
