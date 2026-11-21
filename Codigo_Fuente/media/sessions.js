/* ALFRED // SESIONES — proyectos de opencode o Claude y sus sesiones, en una pestaña central.
   El host manda `{ type: "sessions", groups, current?, error? }` y este script solo pinta: no
   sondea. Arriba, un desplegable con los proyectos; debajo, las sesiones del elegido tal como
   llegan (la más nueva arriba). Al abrir el panel manda el proyecto abierto en VS Code
   (`current`); lo que elija la persona se respeta entre refrescos mientras el panel viva. */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  const el = {
    list: document.getElementById("list"),
    project: document.getElementById("project"),
    refresh: document.getElementById("btn-refresh"),
  };

  /* ── Estado de la vista ─────────────────────────────────────────────────────
     `datos` es el último mensaje del host; `null` = todavía sin datos (ni vacío ni
     error inventados). `elegido` es el `dir` del proyecto a la vista; `null` hasta el
     primer mensaje, que lo siembra con `current`. Solo en memoria: al reabrir el panel
     vuelve a mandar el proyecto actual. */
  let datos = null;
  let elegido = null;

  function pedirSesiones() {
    vscode.postMessage({ type: "sessions" });
  }

  /* ── Piezas ─────────────────────────────────────────────────────────────────
     Todo texto ajeno (títulos y rutas vienen de las bases de opencode o de Claude) va por
     `textContent`: nada de HTML con datos. */

  // Grupo sin `name` conocido: el último tramo de la ruta, que es lo que se reconoce.
  function nombreDeRuta(dir) {
    const tramos = String(dir || "")
      .split(/[\\/]+/)
      .filter(Boolean);
    return tramos.length ? tramos[tramos.length - 1] : String(dir || "");
  }

  // Ruta comparable: mismas barras, sin la final y sin distinguir mayúsculas (Windows; la
  // letra de unidad puede venir en otra caja).
  function normalizar(dir) {
    return String(dir || "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  }

  // Fecha corta: la hora si es de hoy; si no, día y mes (y el año si no es el actual).
  function fechaCorta(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "";
    const d = new Date(n);
    const hoy = new Date();
    const dos = (v) => String(v).padStart(2, "0");
    const hora = dos(d.getHours()) + ":" + dos(d.getMinutes());
    if (d.toDateString() === hoy.toDateString()) return hora;
    const dia = dos(d.getDate()) + "/" + dos(d.getMonth() + 1);
    return d.getFullYear() === hoy.getFullYear()
      ? dia + " " + hora
      : dia + "/" + String(d.getFullYear()).slice(-2);
  }

  function nota(texto, esError) {
    const p = document.createElement("p");
    p.className = "ss-note" + (esError ? " error" : "");
    p.textContent = texto;
    return p;
  }

  function filaSesion(dir, item) {
    const fila = document.createElement("button");
    fila.type = "button";
    fila.className = "ss-item" + (item.active ? " active" : "");

    const nombre = document.createElement("span");
    nombre.className = "ss-item-name";
    // Título vacío: los primeros caracteres del id, para que la fila nunca quede en blanco.
    const titulo = String(item.title || "").trim();
    nombre.textContent = titulo || String(item.id || "").slice(0, 8);
    fila.title = titulo || String(item.id || "");
    fila.append(nombre);

    const cuando = fechaCorta(item.updated);
    if (cuando) {
      const fecha = document.createElement("span");
      fecha.className = "ss-date";
      fecha.textContent = cuando;
      fecha.title = new Date(Number(item.updated)).toLocaleString();
      fila.append(fecha);
    }

    if (item.active) {
      const punto = document.createElement("span");
      punto.className = "ss-dot";
      punto.title = "Sesión abierta";
      punto.setAttribute("aria-label", "Sesión abierta");
      fila.append(punto);
    }

    fila.addEventListener("click", () =>
      vscode.postMessage({
        type: "loadSession",
        id: item.id,
        directory: dir,
        title: item.title,
      })
    );
    return fila;
  }

  // Rehace las opciones del desplegable con la selección vigente.
  function pintarDesplegable(grupos) {
    if (!el.project) return;
    el.project.replaceChildren();
    for (const g of grupos) {
      const opcion = document.createElement("option");
      opcion.value = g.dir;
      opcion.textContent = String(g.name || "").trim() || nombreDeRuta(g.dir);
      opcion.title = g.dir;
      el.project.append(opcion);
    }
    el.project.value = elegido || "";
    el.project.title = elegido || "";
    el.project.disabled = grupos.length === 0;
  }

  // Reconstruye la vista entera: es barata y evita estados a medias entre mensajes.
  function pintar() {
    if (!el.list) return;
    el.list.replaceChildren();
    if (!datos) return; // esperando datos: ni vacío ni error inventados

    const grupos = (Array.isArray(datos.groups) ? datos.groups : []).filter(
      (g) => g && typeof g === "object" && typeof g.dir === "string" && g.dir &&
        Array.isArray(g.sessions) && g.sessions.length > 0
    );

    // Sin elección válida (primer mensaje o el proyecto elegido desapareció): el actual y,
    // si no está en la lista, el primero.
    if (!elegido || !grupos.some((g) => g.dir === elegido)) {
      const actual = normalizar(datos.current);
      const casa = actual ? grupos.find((g) => normalizar(g.dir) === actual) : undefined;
      elegido = (casa || grupos[0] || { dir: null }).dir;
    }
    pintarDesplegable(grupos);

    if (datos.error) {
      el.list.append(nota(String(datos.error), true));
      return;
    }
    const grupo = grupos.find((g) => g.dir === elegido);
    if (!grupo) {
      el.list.append(nota("Sin sesiones guardadas.", false));
      return;
    }
    for (const item of grupo.sessions) {
      el.list.append(filaSesion(grupo.dir, item));
    }
  }

  /* ── Mensajes del host ──────────────────────────────────────────────────── */
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.type !== "sessions") return;
    datos = message;
    pintar();
  });

  el.project?.addEventListener("change", () => {
    elegido = el.project.value || null;
    pintar();
  });

  el.refresh?.addEventListener("click", pedirSesiones);

  vscode.postMessage({ type: "ready" });
})();
