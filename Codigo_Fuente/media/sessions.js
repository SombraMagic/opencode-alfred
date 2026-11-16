/* ALFRED // SESIONES — proyectos de opencode o Claude y sus sesiones, en una pestaña central.
   El host manda `{ type: "sessions", groups, error? }` y este script solo pinta: no
   sondea. Los proyectos desplegados se recuerdan en `setState`, por `dir`. */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  const el = {
    list: document.getElementById("list"),
    refresh: document.getElementById("btn-refresh"),
  };

  /* ── Estado de la vista ─────────────────────────────────────────────────────
     `datos` es el último mensaje del host; `null` = todavía sin datos (ni vacío ni
     error inventados). Sin estado guardado, el primer mensaje despliega el primer
     proyecto: la lista nunca arranca entera cerrada. */
  const previo = vscode.getState();
  const estadoPrevio = previo && typeof previo === "object" ? previo : null;
  const desplegados = new Set(
    estadoPrevio && Array.isArray(estadoPrevio.expanded)
      ? estadoPrevio.expanded.filter((dir) => typeof dir === "string" && dir)
      : []
  );
  const sembrar = !estadoPrevio || !Array.isArray(estadoPrevio.expanded);
  let sembrado = false;
  let datos = null;

  function guardarEstado() {
    vscode.setState({
      ...(estadoPrevio ? estadoPrevio : {}),
      expanded: [...desplegados],
    });
  }

  function pedirSesiones() {
    vscode.postMessage({ type: "sessions" });
  }

  /* ── Piezas de la lista ─────────────────────────────────────────────────────
     Todo texto ajeno (títulos y rutas vienen de las bases de opencode) va por
     `textContent`: nada de HTML con datos. */

  // Grupo sin `name` conocido: el último tramo de la ruta, que es lo que se reconoce.
  function nombreDeRuta(dir) {
    const tramos = String(dir || "")
      .split(/[\\/]+/)
      .filter(Boolean);
    return tramos.length ? tramos[tramos.length - 1] : String(dir || "");
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
    // La carpeta del proyecto, en el `title` del renglón.
    fila.title = String(dir || "");

    const nombre = document.createElement("span");
    nombre.className = "ss-item-name";
    // Título vacío: los primeros caracteres del id, para que la fila nunca quede en blanco.
    const titulo = String(item.title || "").trim();
    nombre.textContent = titulo || String(item.id || "").slice(0, 8);
    fila.append(nombre);

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

  function bloqueGrupo(group) {
    const abierto = desplegados.has(group.dir);
    const sesiones = Array.isArray(group.sessions) ? group.sessions : [];

    const bloque = document.createElement("div");
    bloque.className = "ss-group";

    const fila = document.createElement("button");
    fila.type = "button";
    fila.className = "ss-group-row";
    fila.title = String(group.dir || "");
    fila.setAttribute("aria-expanded", abierto ? "true" : "false");

    const flecha = document.createElement("span");
    flecha.className = "ss-arrow";
    flecha.setAttribute("aria-hidden", "true");
    flecha.textContent = abierto ? "▾" : "▸";

    const nombre = document.createElement("span");
    nombre.className = "ss-group-name";
    nombre.textContent = String(group.name || "").trim() || nombreDeRuta(group.dir);

    const cuenta = document.createElement("span");
    cuenta.className = "ss-count";
    cuenta.textContent = String(sesiones.length);

    fila.append(flecha, nombre, cuenta);
    fila.addEventListener("click", () => {
      if (desplegados.has(group.dir)) {
        desplegados.delete(group.dir);
      } else {
        desplegados.add(group.dir);
      }
      guardarEstado();
      pintar();
    });
    bloque.append(fila);

    const lista = document.createElement("div");
    lista.className = "ss-sessions";
    lista.hidden = !abierto;
    for (const item of sesiones) {
      lista.append(filaSesion(group.dir, item));
    }
    bloque.append(lista);
    return bloque;
  }

  // Reconstruye la lista entera: es barata y evita estados a medias entre mensajes.
  function pintar() {
    if (!el.list) return;
    el.list.replaceChildren();
    if (!datos) return; // esperando datos: ni vacío ni error inventados

    if (datos.error) {
      el.list.append(nota(String(datos.error), true));
      return;
    }

    const grupos = (Array.isArray(datos.groups) ? datos.groups : []).filter(
      (g) => g && typeof g === "object" && g.dir
    );
    const conSesiones = grupos.filter(
      (g) => Array.isArray(g.sessions) && g.sessions.length > 0
    );
    if (!conSesiones.length) {
      el.list.append(nota("Sin sesiones guardadas.", false));
      return;
    }

    for (const group of conSesiones) {
      el.list.append(bloqueGrupo(group));
    }
  }

  /* ── Mensajes del host ──────────────────────────────────────────────────── */
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.type !== "sessions") return;

    datos = message;
    const grupos = Array.isArray(message.groups) ? message.groups : [];
    if (sembrar && !sembrado) {
      sembrado = true;
      const primero = grupos[0];
      if (primero && primero.dir && Array.isArray(primero.sessions) && primero.sessions.length) {
        desplegados.add(primero.dir);
        guardarEstado();
      }
    }
    pintar();
  });

  el.refresh?.addEventListener("click", pedirSesiones);

  vscode.postMessage({ type: "ready" });
})();
