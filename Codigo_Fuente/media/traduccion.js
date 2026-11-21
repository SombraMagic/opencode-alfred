/* Traducción — pestaña de prueba del servicio de traducción local de Mente local.
   No hace red: pide la traducción al host, que la manda por la API HTTP del servicio. */

(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const estado = $("estado");
  const aviso = $("aviso");
  const origen = $("origen");
  const resultado = $("resultado");
  const botonTraducir = $("traducir");
  const meta = $("meta");
  const curl = $("curl");
  const botonCopiar = $("copiarCurl");
  const botonesDestino = Array.from(document.querySelectorAll(".tr-ord"));

  const guardado = vscode.getState() || {};
  let destino = guardado.destino === "en" ? "en" : "es";
  let activo = false;
  let puerto = 5005;
  let enCurso = false;

  if (typeof guardado.texto === "string") {
    origen.value = guardado.texto;
  }

  function guardar() {
    vscode.setState({ destino, texto: origen.value });
  }

  function ponerAviso(texto, esError) {
    aviso.textContent = texto || "";
    aviso.hidden = !texto;
    aviso.classList.toggle("error", Boolean(texto) && Boolean(esError));
  }

  function ejemploCurl() {
    const cuerpo = JSON.stringify({ texto: "Hello world", destino: destino }).replace(/"/g, '\\"');
    return (
      `curl -s -X POST http://127.0.0.1:${puerto}/traducir ` +
      `-H "Content-Type: application/json" -d "${cuerpo}"`
    );
  }

  function pintar() {
    for (const boton of botonesDestino) {
      const on = boton.dataset.destino === destino;
      boton.classList.toggle("on", on);
      boton.setAttribute("aria-pressed", on ? "true" : "false");
    }
    botonTraducir.disabled = enCurso || !activo || !origen.value.trim();
    botonTraducir.textContent = enCurso ? "TRADUCIENDO…" : "TRADUCIR";
    curl.textContent = ejemploCurl();
  }

  for (const boton of botonesDestino) {
    boton.addEventListener("click", () => {
      destino = boton.dataset.destino === "en" ? "en" : "es";
      guardar();
      pintar();
    });
  }

  origen.addEventListener("input", () => {
    guardar();
    pintar();
  });

  function traducir() {
    if (enCurso || !activo || !origen.value.trim()) {
      return;
    }
    enCurso = true;
    meta.textContent = "";
    ponerAviso("", false);
    pintar();
    vscode.postMessage({ type: "traducir", texto: origen.value, destino });
  }

  botonTraducir.addEventListener("click", traducir);
  origen.addEventListener("keydown", (evento) => {
    if (evento.key === "Enter" && (evento.ctrlKey || evento.metaKey)) {
      evento.preventDefault();
      traducir();
    }
  });

  botonCopiar.addEventListener("click", () => {
    vscode.postMessage({ type: "copiar", texto: ejemploCurl() });
  });

  window.addEventListener("message", (evento) => {
    const m = evento.data;
    if (!m || typeof m !== "object") {
      return;
    }
    if (m.type === "estado") {
      activo = m.activo === true;
      puerto = typeof m.puerto === "number" ? m.puerto : puerto;
      estado.textContent = activo ? `ESCUCHANDO :${puerto}` : "APAGADO";
      estado.classList.toggle("ok", activo);
      estado.classList.toggle("error", !activo);
      if (!activo) {
        ponerAviso("El servicio de traducción está apagado: enciéndelo en Mente local.", true);
      } else if (!m.modelo) {
        ponerAviso("Mente local no tiene modelo PREFERIDO: el servicio responderá 503.", true);
      } else {
        ponerAviso("", false);
      }
      pintar();
      return;
    }
    if (m.type === "resultado") {
      enCurso = false;
      if (typeof m.error === "string") {
        ponerAviso(m.error, true);
        meta.textContent = "";
      } else {
        resultado.value = typeof m.texto === "string" ? m.texto : "";
        const ms = typeof m.ms === "number" ? m.ms : 0;
        meta.textContent = `${(ms / 1000).toFixed(1)} s · ${m.modelo || "—"}`;
      }
      pintar();
    }
  });

  pintar();
  vscode.postMessage({ type: "ready" });
})();
