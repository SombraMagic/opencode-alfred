// OpenCode Alfred — cambio de tema visual.
// El host manda { type: "theme", theme: "alfred" | "manoli" | "steampunk" } por
// postMessage y este script solo pone el atributo data-theme en el <body>. El CSS hace
// el resto: media/themes/alfred.css es el HUD oscuro por defecto (:root),
// media/themes/manoli.css se activa con body[data-theme="manoli"] y
// media/themes/steampunk.css con body[data-theme="steampunk"]. Los tres se enlazan
// siempre y el atributo decide cuál manda.
//
// No llama a acquireVsCodeApi(): cada panel ya la llama una vez y una segunda
// llamada lanza error. Este fichero solo escucha.
(function () {
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.type !== "theme") return;
    if (typeof data.theme !== "string") return;
    if (!document.body) return;
    document.body.dataset.theme = data.theme;
  });
})();
