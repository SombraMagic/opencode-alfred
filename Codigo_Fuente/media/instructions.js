// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const textarea = (id) => /** @type {HTMLTextAreaElement} */ (document.getElementById(id));

  function post(message) {
    vscode.postMessage(message);
  }

  function setBanner(text, isError) {
    const el = $("banner");
    if (!text) {
      el.hidden = true;
      return;
    }
    el.textContent = text;
    el.hidden = false;
    el.classList.toggle("error", !!isError);
    el.classList.toggle("ok", !isError);
  }

  function wireEvents() {
    textarea("f-text").addEventListener("input", () => post({ type: "dirty", value: true }));

    $("btn-save").addEventListener("click", () =>
      post({ type: "save", payload: { text: textarea("f-text").value } })
    );
    $("btn-cancel").addEventListener("click", () => post({ type: "cancel" }));
    $("btn-open-raw").addEventListener("click", () => post({ type: "openRaw" }));
    $("btn-delete").addEventListener("click", () => post({ type: "delete" }));

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        $("btn-save").click();
      }
    });
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "init": {
        const d = message.payload || {};
        $("subtitle").textContent = d.exists
          ? d.file
          : `${d.file} (aún no existe; se creará al guardar)`;
        $("btn-delete").hidden = !d.exists;
        textarea("f-text").value = d.text || "";
        break;
      }
      case "saved":
        setBanner(message.message, !message.ok);
        // Tras guardar ya hay fichero en disco: "Borrar" pasa a tener sentido.
        if (message.ok) {
          $("btn-delete").hidden = false;
        }
        break;
    }
  });

  // El AGENTS.md es Markdown: se ve coloreado sin dejar de editarse como texto plano.
  window.MdEditor?.attachTextarea(textarea("f-text"));

  wireEvents();
  post({ type: "ready" });
})();
