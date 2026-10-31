(function () {
  // ── Lógica pura (sin DOM): se puede cargar con require desde node ──
  // Los decimales van con coma (es-ES) y el separador de miles con punto.
  function numero(n, decimales) {
    const valor = Number(n);
    const v = Number.isFinite(valor) ? valor : 0;
    return v.toLocaleString("es-ES", {
      minimumFractionDigits: decimales,
      maximumFractionDigits: decimales,
    });
  }

  // Misma escala que media/context.js, con coma decimal.
  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v <= 0) return "0";
    if (v < 1000) return String(Math.round(v));
    if (v < 1e6) return numero(v / 1000, v < 1e5 ? 1 : 0) + "k";
    if (v < 1e9) return numero(v / 1e6, v < 1e7 ? 2 : 1) + "M";
    return numero(v / 1e9, 2) + "B";
  }

  // Divisa: USD (o sin código) se queda con el formato del HUD; otra va con Intl.
  function monedaTexto(n, moneda) {
    const iso = String(moneda == null ? "" : moneda).trim().toUpperCase();
    if (!iso || iso === "USD") return numero(n, 2) + " $";
    try {
      return new Intl.NumberFormat("es-ES", { style: "currency", currency: iso }).format(
        Number(n) || 0
      );
    } catch {
      // Código ISO que Intl no conoce: se pinta el número con el código detrás.
      return numero(n, 2) + " " + iso;
    }
  }

  // Importe con su unidad, para la columna de la derecha.
  function fmtValor(n, unidad, moneda) {
    if (unidad === "usd") return monedaTexto(n, moneda);
    if (unidad === "solicitudes") return Math.round(Number(n) || 0) + " peticiones";
    if (unidad === "porcentaje") return Math.round(Number(n) || 0) + " %";
    return fmtTokens(n);
  }

  // "usado / tope" con la unidad una sola vez cuando el número la lleva pegada.
  // En peticiones va sin la palabra: el rótulo de la línea ya dice de qué va.
  function fmtPar(usado, tope, unidad, moneda) {
    if (unidad === "solicitudes") {
      return Math.round(Number(usado) || 0) + " / " + Math.round(Number(tope) || 0);
    }
    // En porcentaje el tope siempre es 100: repetirlo no dice nada.
    if (unidad === "porcentaje") return Math.round(Number(usado) || 0) + " %";
    return fmtValor(usado, unidad, moneda) + " / " + fmtValor(tope, unidad, moneda);
  }

  // null = sin tope conocido (solo se pinta el dato, no hay barra).
  function porcentaje(usado, tope) {
    const u = Number(usado) || 0;
    const t = Number(tope) || 0;
    if (!(t > 0)) return null;
    if (u <= 0) return 0;
    return Math.min(100, (u / t) * 100);
  }

  // "" normal, "aviso" ≥75 %, "peligro" ≥95 % o tope alcanzado.
  function tramo(usado, tope) {
    const p = porcentaje(usado, tope);
    if (p === null) return "";
    const u = Number(usado) || 0;
    const t = Number(tope) || 0;
    if (p >= 95 || u >= t) return "peligro";
    if (p >= 75) return "aviso";
    return "";
  }

  // Acepta epoch en ms, en segundos o ISO. 0 = no hay fecha.
  function msDe(valor) {
    if (typeof valor === "number" && Number.isFinite(valor)) {
      return valor < 1e11 ? valor * 1000 : valor;
    }
    const t = Date.parse(String(valor));
    return Number.isFinite(t) ? t : 0;
  }

  function reponeTexto(resetsAt, ahora) {
    const at = msDe(resetsAt);
    if (!at) return "";
    const resto = at - (Number(ahora) || Date.now());
    if (resto <= 0) return "se repone en breve";
    const min = Math.ceil(resto / 60000);
    const d = Math.floor(min / 1440);
    const h = Math.floor((min % 1440) / 60);
    const m = min % 60;
    // Las ventanas largas (semana, mes) en horas daban «648h»: en días se leen de un vistazo.
    if (d > 0) return "se repone en " + d + " d" + (h > 0 ? " " + h + " h" : "");
    return "se repone en " + (h > 0 ? h + "h " + m + "m" : m + "m");
  }

  // "" cuando no hay plan: la tarjeta no pinta chip en ese caso.
  function planEtiqueta(plan) {
    const bruto = String(plan == null ? "" : plan).trim();
    if (!bruto) return "";
    const norm = bruto.toLowerCase().replace(/[\s_]+/g, "-");
    if (norm === "go-plus") return "GO PLUS";
    return bruto.toUpperCase();
  }

  function planOpuesto(plan) {
    const norm = String(plan == null ? "" : plan).toLowerCase().replace(/[\s_]+/g, "-");
    return norm === "go-plus" ? "go" : "go-plus";
  }

  function haceTexto(at, ahora) {
    const ms = msDe(at);
    if (!ms) return "";
    const min = Math.floor(((Number(ahora) || Date.now()) - ms) / 60000);
    if (min < 1) return "hace menos de 1 min";
    if (min < 60) return "hace " + min + " min";
    const h = Math.floor(min / 60);
    if (h < 24) return "hace " + h + " h";
    return "hace " + Math.floor(h / 24) + " d";
  }

  const puro = {
    numero,
    fmtTokens,
    monedaTexto,
    fmtValor,
    fmtPar,
    porcentaje,
    tramo,
    msDe,
    reponeTexto,
    planEtiqueta,
    planOpuesto,
    haceTexto,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = puro;
  }

  // Comprobación en node: basta con cargar el fichero. En la webview sigue.
  if (typeof document === "undefined") {
    return;
  }

  const vscode = acquireVsCodeApi();

  const el = {
    refresh: document.getElementById("refresh"),
    stamp: document.getElementById("stamp"),
    list: document.getElementById("list"),
    hint: document.getElementById("hint"),
  };

  let ultimo = 0;
  // Plegado: un id por tarjeta cerrada. Lo guarda el host entre sesiones.
  const plegados = new Set();
  // El host es la fuente al abrir la vista; durante la sesión manda el clic local.
  let sembrado = false;

  function sembrar(colapsadas) {
    if (sembrado) return;
    sembrado = true;
    for (const id of Array.isArray(colapsadas) ? colapsadas : []) {
      if (typeof id === "string" && id) plegados.add(id);
    }
  }

  function nodo(tag, clase, texto) {
    const n = document.createElement(tag);
    if (clase) n.className = clase;
    if (texto !== undefined && texto !== null) n.textContent = texto;
    return n;
  }

  function filaVentana(w) {
    const usado = Number(w.used) || 0;
    const tope = Number(w.limit) || 0;
    const unidad =
      w.unit === "usd" || w.unit === "solicitudes" || w.unit === "tokens" || w.unit === "porcentaje"
        ? w.unit
        : "tokens";
    const etiqueta = String(w.label || "Ventana");
    const moneda = w.currency;

    // Una sola línea: rótulo, barra (o el tiempo de reanudación), cifras y %.
    const fila = nodo("div", "win");

    const nombre = nodo("span", "win-label", etiqueta);
    nombre.title = etiqueta;
    fila.appendChild(nombre);

    // Sin tope no hay barra ni %: se queda el dato a secas (saldo o gasto).
    if (!(tope > 0)) {
      fila.appendChild(nodo("span", "win-num", fmtValor(usado, unidad, moneda)));
      return fila;
    }

    const pct = porcentaje(usado, tope);

    if (usado >= tope) {
      // Al tope la barra no dice nada: su sitio lo ocupa cuándo vuelve a haber cuota.
      fila.appendChild(
        nodo("span", "win-reset", reponeTexto(w.resetsAt, Date.now()) || "al límite")
      );
    } else {
      const barra = nodo("div", "bar");
      barra.setAttribute("role", "progressbar");
      barra.setAttribute("aria-label", etiqueta);
      barra.setAttribute("aria-valuemin", "0");
      barra.setAttribute("aria-valuemax", "100");
      barra.setAttribute("aria-valuenow", String(Math.round(pct)));
      const relleno = nodo("div", ("bar-fill " + tramo(usado, tope)).trim());
      // Único estilo en línea: el ancho de la barra (redondeado a 2 decimales).
      relleno.style.width = Math.round(Math.max(0, Math.min(100, pct)) * 100) / 100 + "%";
      barra.appendChild(relleno);
      fila.appendChild(barra);
    }

    // Solo las ventanas por peticiones necesitan las cifras: el % no dice cuánto queda.
    if (unidad === "solicitudes") {
      fila.appendChild(nodo("span", "win-num", fmtPar(usado, tope, unidad, moneda)));
    }
    fila.appendChild(nodo("span", "win-pct", Math.round(pct) + " %"));

    return fila;
  }

  function tarjeta(p) {
    p = p || {};
    const error = p.status === "error";
    const card = nodo("article", "card" + (error ? " error" : ""));

    const abierta = !plegados.has(p.id);
    const cabecera = nodo("header", "card-head");

    const toggle = nodo("button", "card-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(abierta));
    const chev = nodo("span", "chev", abierta ? "▾" : "▸");
    const nombre = nodo("span", "card-name", String(p.name || p.id || "Proveedor"));
    nombre.title = String(p.name || p.id || "");
    toggle.append(chev, nombre);
    cabecera.appendChild(toggle);

    // El chip de plan solo con plan conocido y tarjeta sana; en opencode-go alterna.
    if (!error && p.plan) {
      const esGo = p.id === "opencode-go";
      const plan = nodo(esGo ? "button" : "span", esGo ? "chip plan act" : "chip plan");
      plan.textContent = planEtiqueta(p.plan);
      if (esGo) {
        plan.type = "button";
        plan.title = "Cambiar entre Go y Go Plus";
        plan.setAttribute("aria-label", "Plan actual: " + plan.textContent + ". Pulsa para cambiar de plan");
        plan.addEventListener("click", () => {
          const destino = planOpuesto(p.plan);
          plan.textContent = planEtiqueta(destino);
          vscode.postMessage({ type: "setGoPlan", plan: destino });
        });
      }
      cabecera.appendChild(plan);
    }

    if (!error && p.estimated) {
      const est = nodo("span", "chip est", "ESTIMADO");
      est.title = "Datos estimados por el editor, no leídos de la API del proveedor";
      cabecera.appendChild(est);
    }

    const cuerpo = nodo("div", "card-body");
    cuerpo.hidden = !abierta;
    if (error) {
      const texto = String(p.error || "No se pudieron leer los límites.");
      const linea = nodo("p", "card-error", texto);
      linea.title = texto;
      cuerpo.appendChild(linea);
    } else {
      const ventanas = Array.isArray(p.windows) ? p.windows : [];
      if (ventanas.length === 0) {
        cuerpo.appendChild(nodo("p", "win-empty", "Sin datos de consumo."));
      } else {
        for (const w of ventanas) cuerpo.appendChild(filaVentana(w || {}));
      }
    }
    card.append(cabecera, cuerpo);

    toggle.addEventListener("click", () => {
      const abrir = cuerpo.hidden;
      cuerpo.hidden = !abrir;
      chev.textContent = abrir ? "▾" : "▸";
      toggle.setAttribute("aria-expanded", String(abrir));
      if (abrir) plegados.delete(p.id);
      else plegados.add(p.id);
      const id = String(p.id || "");
      if (id) vscode.postMessage({ type: "collapse", id, collapsed: !abrir });
    });

    return card;
  }

  function pintaSello() {
    if (!ultimo) {
      el.stamp.hidden = true;
      el.stamp.textContent = "";
      return;
    }
    el.stamp.hidden = false;
    el.stamp.textContent = haceTexto(ultimo, Date.now());
  }

  function render(lista, colapsadas) {
    sembrar(colapsadas);
    const proveedores = Array.isArray(lista) ? lista : [];
    el.list.replaceChildren();
    ultimo = 0;
    for (const p of proveedores) {
      const at = msDe(p.updatedAt);
      if (at > ultimo) ultimo = at;
    }

    if (proveedores.length === 0) {
      el.hint.hidden = false;
      el.hint.textContent = "Ningún proveedor con límites activado. Actívalo en CONECTOR, en la vista Control.";
      pintaSello();
      return;
    }

    el.hint.hidden = true;
    const frag = document.createDocumentFragment();
    for (const p of proveedores) frag.appendChild(tarjeta(p));
    el.list.appendChild(frag);
    pintaSello();
  }

  el.refresh.addEventListener("click", () => {
    vscode.postMessage({ type: "refresh" });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message && message.type === "data") {
      render(message.providers, message.collapsed);
    }
  });

  // «hace X min» envejece solo, sin esperar al siguiente sondeo.
  setInterval(pintaSello, 30000);

  vscode.postMessage({ type: "ready" });
})();
