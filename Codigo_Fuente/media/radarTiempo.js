/* ALFRED // RADAR — pestaña TIEMPO: mapa Leaflet con capas y previsión.
   Sin red propia (la CSP no abre connect-src): los datos los manda el host por postMessage.
   Todo texto externo (nombres de lugar, errores) se pinta con `textContent`; los únicos
   `innerHTML` son los SVG constantes de este fichero.
   Uso: `RadarTiempo.crear(vscode)` → { abrir(), mensaje(m) }. radar.js lo cablea. */
(function () {
  "use strict";

  // ── Paletas de datos (únicos colores fijos: son escalas, no estilo) ─────────
  const PAL_TEMP = [
    [-20, [110, 60, 170]], [-10, [60, 90, 200]], [0, [60, 170, 230]], [8, [80, 200, 160]],
    [16, [170, 220, 80]], [24, [250, 200, 60]], [32, [245, 130, 50]], [40, [220, 50, 50]],
    [46, [150, 20, 60]],
  ];
  const PAL_VIENTO = [
    [0, [80, 180, 230]], [10, [80, 210, 160]], [25, [200, 220, 70]], [40, [250, 170, 50]],
    [60, [240, 90, 60]], [90, [200, 40, 140]],
  ];
  const PAL_LLUVIA = [[0, [120, 200, 250]], [1, [30, 90, 220]], [2, [250, 220, 60]], [3, [230, 60, 50]]];

  // Paleta de datos de la capa NUBOSIDAD (gris sobre base oscura / gris oscuro sobre base clara):
  // es escala de datos, no estilo, y tiene que contrastar con los tiles de la base, no con el tema.
  const NUBE_OSCURA = [205, 212, 225];
  const NUBE_CLARA = [110, 120, 140];

  function color(pal, v) {
    if (v <= pal[0][0]) return pal[0][1];
    for (let i = 1; i < pal.length; i++) {
      if (v <= pal[i][0]) {
        const a = pal[i - 1], b = pal[i];
        const t = (v - a[0]) / (b[0] - a[0]);
        return [
          a[1][0] + (b[1][0] - a[1][0]) * t,
          a[1][1] + (b[1][1] - a[1][1]) * t,
          a[1][2] + (b[1][2] - a[1][2]) * t,
        ];
      }
    }
    return pal[pal.length - 1][1];
  }

  function gradiente(pal, min, max) {
    const paradas = pal.map((p) => {
      const c = p[1];
      const pos = Math.max(0, Math.min(100, ((p[0] - min) / (max - min)) * 100));
      return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ") " + pos.toFixed(0) + "%";
    });
    return "linear-gradient(90deg," + paradas.join(",") + ")";
  }

  // ── Iconos WMO (SVG propios) ─────────────────────────────────────────────
  const S = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
  const P_SOL =
    '<g class="rd-i-sol"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></g>';
  const P_LUNA = '<g class="rd-i-luna"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></g>';
  const P_NUBE = '<path class="rd-i-nube" d="M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 18z"/>';
  const ALTA = (x) => '<g transform="translate(0 -3)">' + x + "</g>";
  const GOTAS = '<path class="rd-i-agua" d="M8 19.5l-1 2.5M12 19.5l-1 2.5M16 19.5l-1 2.5"/>';
  const LLOVIZNA = '<path class="rd-i-agua" d="M9 19.5l-.7 1.8M15 19.5l-.7 1.8"/>';
  const NIEVE = '<g class="rd-i-nieve"><path d="M8 20h.01M12 21.5h.01M16 20h.01M10 22.5h.01M14 22.5h.01"/></g>';
  const NIEBLA = '<path class="rd-i-niebla" d="M5 20h14M7 22.5h10"/>';
  const RAYO = '<path class="rd-i-rayo" d="M12.5 15.5l-3 4.5h3l-1 3.5 4-5h-3l1-3z"/>';

  function iconoSvg(codigo, dia) {
    const astro = dia === false ? P_LUNA : P_SOL;
    let c;
    if (codigo === 0) c = astro;
    else if (codigo === 1 || codigo === 2)
      c = '<g transform="translate(-2 -3) scale(.7)">' + astro + '</g><g transform="translate(2 2) scale(.8)">' + P_NUBE + "</g>";
    else if (codigo === 3) c = P_NUBE;
    else if (codigo === 45 || codigo === 48) c = ALTA(P_NUBE) + NIEBLA;
    else if (codigo >= 51 && codigo <= 57) c = ALTA(P_NUBE) + LLOVIZNA;
    else if ((codigo >= 61 && codigo <= 67) || (codigo >= 80 && codigo <= 82)) c = ALTA(P_NUBE) + GOTAS;
    else if ((codigo >= 71 && codigo <= 77) || codigo === 85 || codigo === 86) c = ALTA(P_NUBE) + NIEVE;
    else if (codigo >= 95) c = ALTA(P_NUBE) + RAYO;
    else c = P_NUBE;
    return S + c + "</svg>";
  }

  function descripcion(codigo) {
    if (codigo === 0) return "Despejado";
    if (codigo === 1) return "Casi despejado";
    if (codigo === 2) return "Parcialmente nublado";
    if (codigo === 3) return "Nublado";
    if (codigo === 45 || codigo === 48) return "Niebla";
    if (codigo >= 51 && codigo <= 57) return "Llovizna";
    if (codigo >= 61 && codigo <= 67) return "Lluvia";
    if (codigo >= 71 && codigo <= 77) return "Nieve";
    if (codigo >= 80 && codigo <= 82) return "Chubascos";
    if (codigo === 85 || codigo === 86) return "Chubascos de nieve";
    if (codigo >= 95) return "Tormenta";
    return "Sin datos";
  }

  const FLECHA =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 20V4M6 10l6-6 6 6"/></svg>';

  // ── Utilidades ───────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  function h(tag, clase, texto) {
    const n = document.createElement(tag);
    if (clase) n.className = clase;
    if (texto !== undefined && texto !== null) n.textContent = String(texto);
    return n;
  }

  function num(v, dec, unidad) {
    if (typeof v !== "number" || !isFinite(v)) return "—";
    return v.toFixed(dec === undefined ? 0 : dec) + (unidad || "");
  }

  function icono(codigo, dia) {
    const s = h("span", "rd-ico");
    s.innerHTML = iconoSvg(codigo, dia);
    return s;
  }

  function flecha(direccion) {
    const s = h("span", "rd-flecha");
    s.innerHTML = FLECHA;
    // Dirección «de dónde viene»: la flecha apunta hacia donde va.
    if (typeof direccion === "number") s.style.transform = "rotate(" + (direccion + 180) + "deg)";
    return s;
  }

  const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

  /** Las horas llegan sin zona (hora local del lugar): se leen del texto, sin convertir. */
  function horaDe(iso) {
    return typeof iso === "string" ? iso.slice(11, 16) : "—";
  }
  function diaHora(iso) {
    if (typeof iso !== "string" || iso.length < 16) return "—";
    const d = new Date(iso.slice(0, 10) + "T12:00:00");
    return DIAS[d.getDay()] + " " + iso.slice(8, 10) + " · " + iso.slice(11, 16);
  }

  function crear(vscode) {
    const el = {
      q: $("rd-lugar-q"),
      buscar: $("btn-lugar-buscar"),
      actualizar: $("btn-tiempo-actualizar"),
      lugares: $("rd-lugares"),
      msg: $("rd-tiempo-msg"),
      mapa: $("rd-mapa"),
      lyLluvia: $("ly-lluvia"),
      lyViento: $("ly-viento"),
      lyTemp: $("ly-temp"),
      lyNubes: $("ly-nubes"),
      opacidad: $("rd-opacidad"),
      ctlLluvia: $("rd-ctl-lluvia"),
      play: $("btn-lluvia-play"),
      lluviaSlider: $("rd-lluvia-slider"),
      lluviaHora: $("rd-lluvia-hora"),
      ctlHora: $("rd-ctl-hora"),
      horaSlider: $("rd-hora-slider"),
      horaValor: $("rd-hora-valor"),
      leyenda: $("rd-leyenda"),
      titulo: $("rd-t-lugar"),
      ahora: $("rd-ahora"),
      horas: $("rd-horas"),
      dias: $("rd-dias"),
    };

    const capas = { lluvia: false, viento: false, temp: false, nubes: false };
    let abierto = false;
    let mapa = null;
    let base = null;
    let baseClara = null;
    let pin = null;
    let canvas = null;
    let lugar = null;
    let rej = null; // última rejilla
    let offLugar = 0; // ms entre GMT y la hora local del lugar activo
    let rejPedida = null; // { bounds, zoom }
    let horaIdx = 0;
    let temporizador = null;
    let raf = 0;
    let ultimaQ = "";
    // Radar de lluvia
    let radar = null; // { host, frames, maxZoom }
    let radarPedido = false;
    let radarCapas = new Map();
    let radarIdx = -1;
    let anim = null;
    // Caché de tokens por data-theme: se invalida al recibir `theme`.
    let tokens = null;

    function tema() {
      return document.body.dataset.theme || "alfred";
    }
    function leerTokens() {
      if (!tokens || tokens.tema !== tema()) {
        const cs = getComputedStyle(document.body);
        tokens = { tema: tema(), bg: cs.getPropertyValue("--bg").trim() || "#000" };
      }
      return tokens;
    }

    function mensaje(texto, error) {
      el.msg.textContent = texto || "";
      el.msg.classList.toggle("error", Boolean(error));
      el.msg.hidden = !texto;
    }

    // ── Mapa ───────────────────────────────────────────────────────────────
    function iniciarMapa() {
      if (mapa || typeof L === "undefined") {
        if (typeof L === "undefined") mensaje("No se cargó el mapa (Leaflet).", true);
        return;
      }
      mapa = L.map(el.mapa, { zoomControl: true, attributionControl: false, minZoom: 2, maxZoom: 11, worldCopyJump: false })
        .setView([40, -3.5], 5);
      L.control.attribution({ prefix: false }).addAttribution("Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors").addTo(mapa);
      ponerBase();
      canvas = document.createElement("canvas");
      canvas.className = "rd-canvas";
      mapa.getContainer().appendChild(canvas);
      mapa.on("move zoom resize", pintarSoon);
      mapa.on("moveend", () => {
        clearTimeout(temporizador);
        temporizador = setTimeout(pedirRejilla, 600);
      });
      ajustarCanvas();
      // El tamaño del contenedor cambia con el layout (pestaña recién mostrada, ventana, paneles):
      // no se depende de eventos, se observa el propio elemento.
      if (typeof ResizeObserver === "function") {
        new ResizeObserver(() => {
          requestAnimationFrame(() => {
            if (!mapa || el.mapa.clientWidth === 0) return;
            mapa.invalidateSize({ animate: false });
            ajustarCanvas();
          });
        }).observe(el.mapa);
      }
    }

    function ponerBase() {
      const clara = tema() === "manoli";
      if (!mapa || (base && baseClara === clara)) return;
      if (base) mapa.removeLayer(base);
      baseClara = clara;
      // Esri Canvas: gris sin clave (CARTO pedía API key). Orden de ruta {z}/{y}/{x}.
      base = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/" +
          (clara ? "World_Light_Gray_Base" : "World_Dark_Gray_Base") +
          "/MapServer/tile/{z}/{y}/{x}",
        { maxNativeZoom: 16, maxZoom: 19, attribution: "" }
      ).addTo(mapa);
      base.setZIndex(1);
    }

    function ajustarCanvas() {
      if (!canvas || !mapa) return;
      const s = mapa.getSize();
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = s.x + "px";
      canvas.style.height = s.y + "px";
      canvas.width = Math.max(1, Math.round(s.x * dpr));
      canvas.height = Math.max(1, Math.round(s.y * dpr));
      pintar();
    }

    function ponerPin() {
      if (!mapa || !lugar) return;
      const pos = [lugar.lat, lugar.lon];
      if (!pin) {
        pin = L.marker(pos, {
          icon: L.divIcon({ className: "rd-pin", html: "", iconSize: [14, 14], iconAnchor: [7, 7] }),
          keyboard: false,
          interactive: false,
        }).addTo(mapa);
      } else {
        pin.setLatLng(pos);
      }
      mapa.setView(pos, 7);
    }

    // ── Capas de rejilla ───────────────────────────────────────────────────
    function hayRejilla() {
      return capas.viento || capas.temp || capas.nubes;
    }

    function pintarSoon() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        pintar();
      });
    }

    /** Valor bilinear de `campo` (array plano ny*nx, norte→sur, oeste→este) en lat/lon. */
    function bil(campo, lat, lon) {
      const b = rej.bounds;
      const fy = ((b.n - lat) / (b.n - b.s)) * (rej.ny - 1);
      const fx = ((lon - b.w) / (b.e - b.w)) * (rej.nx - 1);
      if (!(fy >= 0 && fx >= 0 && fy <= rej.ny - 1 && fx <= rej.nx - 1)) return null;
      const j = Math.min(rej.ny - 2, Math.floor(fy));
      const i = Math.min(rej.nx - 2, Math.floor(fx));
      const ty = fy - j, tx = fx - i;
      const a = campo[j * rej.nx + i], bb = campo[j * rej.nx + i + 1];
      const c = campo[(j + 1) * rej.nx + i], d = campo[(j + 1) * rej.nx + i + 1];
      if (a == null || bb == null || c == null || d == null) return null;
      return (a * (1 - tx) + bb * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }

    /** Viento en un punto: interpola las componentes, no el ángulo. */
    function vientoEn(vel, dir, lat, lon) {
      const b = rej.bounds;
      const fy = ((b.n - lat) / (b.n - b.s)) * (rej.ny - 1);
      const fx = ((lon - b.w) / (b.e - b.w)) * (rej.nx - 1);
      if (!(fy >= 0 && fx >= 0 && fy <= rej.ny - 1 && fx <= rej.nx - 1)) return null;
      const j = Math.min(rej.ny - 2, Math.floor(fy));
      const i = Math.min(rej.nx - 2, Math.floor(fx));
      const ty = fy - j, tx = fx - i;
      let u = 0, v = 0;
      const esq = [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]];
      for (const e of esq) {
        const k = (j + e[1]) * rej.nx + i + e[0];
        if (vel[k] == null || dir[k] == null) return null;
        const r = (dir[k] * Math.PI) / 180;
        u += -vel[k] * Math.sin(r) * e[2];
        v += -vel[k] * Math.cos(r) * e[2];
      }
      return { u: u, v: v, vel: Math.hypot(u, v) };
    }

    function pintar() {
      if (!canvas || !mapa) return;
      const ctx = canvas.getContext("2d");
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!rej || !hayRejilla() || !rej.tiempos.length) return;
      ctx.scale(dpr, dpr);
      const idx = Math.min(horaIdx, rej.tiempos.length - 1);
      const s = mapa.getSize();
      const op = Number(el.opacidad.value) / 100;

      if (capas.temp || capas.nubes) {
        const campo = (capas.temp ? rej.temp : rej.nubosidad)[idx];
        if (campo) {
          const paso = 6;
          const w = Math.ceil(s.x / paso), hh = Math.ceil(s.y / paso);
          const off = document.createElement("canvas");
          off.width = w;
          off.height = hh;
          const octx = off.getContext("2d");
          const img = octx.createImageData(w, hh);
          const nube = baseClara ? NUBE_CLARA : NUBE_OSCURA;
          for (let y = 0; y < hh; y++) {
            for (let x = 0; x < w; x++) {
              const ll = mapa.containerPointToLatLng([x * paso + paso / 2, y * paso + paso / 2]);
              const v = bil(campo, ll.lat, ll.lng);
              if (v === null) continue;
              const o = (y * w + x) * 4;
              if (capas.temp) {
                const c = color(PAL_TEMP, v);
                img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
                img.data[o + 3] = 255 * op;
              } else {
                img.data[o] = nube[0]; img.data[o + 1] = nube[1]; img.data[o + 2] = nube[2];
                img.data[o + 3] = 255 * op * Math.max(0, Math.min(1, v / 100)) * 0.9;
              }
            }
          }
          octx.putImageData(img, 0, 0);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(off, 0, 0, w * paso, hh * paso);
        }
      }

      if (capas.viento && rej.viento[idx] && rej.direccion[idx]) {
        const halo = leerTokens().bg;
        const sep = 52;
        ctx.lineCap = "round";
        for (let y = sep / 2; y < s.y; y += sep) {
          for (let x = sep / 2; x < s.x; x += sep) {
            const ll = mapa.containerPointToLatLng([x, y]);
            const w = vientoEn(rej.viento[idx], rej.direccion[idx], ll.lat, ll.lng);
            if (!w || w.vel < 0.5) continue;
            flechaCanvas(ctx, x, y, Math.atan2(-w.v, w.u), 9 + Math.min(w.vel, 60) / 60 * 13, color(PAL_VIENTO, w.vel), halo, op);
          }
        }
      }
    }

    function flechaCanvas(ctx, x, y, ang, largo, c, halo, op) {
      const dx = Math.cos(ang) * largo / 2, dy = Math.sin(ang) * largo / 2;
      const ax = x + dx, ay = y + dy;
      const traza = () => {
        ctx.beginPath();
        ctx.moveTo(x - dx, y - dy);
        ctx.lineTo(ax, ay);
        for (const lado of [-1, 1]) {
          ctx.moveTo(ax, ay);
          ctx.lineTo(ax - Math.cos(ang + lado * 0.5) * 5, ay - Math.sin(ang + lado * 0.5) * 5);
        }
        ctx.stroke();
      };
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = halo;
      ctx.lineWidth = 4;
      traza();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")";
      ctx.lineWidth = 2;
      traza();
      ctx.globalAlpha = 1;
    }

    function pedirRejilla(forzar) {
      if (!mapa || !hayRejilla()) return;
      const vista = mapa.getBounds();
      const b = vista.pad(0.25);
      const c = vista.getCenter();
      // El host rechaza más de 90° de alto, 180° de ancho o latitudes fuera de ±85: se acota al centro.
      const lim = (centro, medio, min, max) => {
        const lo = Math.max(min, centro - medio), hi = Math.min(max, centro + medio);
        return [lo, hi];
      };
      let n = Math.min(85, b.getNorth()), s = Math.max(-85, b.getSouth());
      let e = Math.min(180, b.getEast()), w = Math.max(-180, b.getWest());
      let acotada = false;
      if (n - s > 90) { [s, n] = lim(c.lat, 45, -85, 85); acotada = true; }
      if (e - w > 180) { [w, e] = lim(c.lng, 90, -180, 180); acotada = true; }
      if (!(n > s) || !(e > w)) return;
      const bounds = { n: n, s: s, e: e, w: w };
      const z = mapa.getZoom();
      if (forzar !== true && rejPedida && rejPedida.zoom === z && rej) {
        const q = rejPedida.bounds;
        const dentro = (lat, lon) => lat <= q.n && lat >= q.s && lon <= q.e && lon >= q.w;
        const vc = dentro(vista.getNorth(), vista.getEast()) && dentro(vista.getSouth(), vista.getWest());
        if (vc || (rejPedida.acotada && dentro(c.lat, c.lng))) return;
      }
      rejPedida = { bounds: bounds, zoom: z, acotada: acotada };
      mensaje("Cargando rejilla…");
      vscode.postMessage({ type: "tiempo", op: "rejilla", bounds: bounds });
    }

    /** Las horas de la rejilla vienen en GMT sin zona: se pasan a la hora local del lugar, como la tira de 48 h. */
    function localDe(t) {
      const ms = Date.parse(t + "Z");
      return isNaN(ms) ? t : new Date(ms + offLugar).toISOString().slice(0, 16);
    }

    function alRejilla(m) {
      const p = m && m.pedido;
      if (!p || !rejPedida) return; // sin petición vigente
      const q = rejPedida.bounds;
      if (p.n !== q.n || p.s !== q.s || p.e !== q.e || p.w !== q.w) return; // respuesta de una petición vieja
      if (!m || !Array.isArray(m.tiempos) || !m.bounds || !(m.nx >= 2) || !(m.ny >= 2)) {
        mensaje("Rejilla vacía o no válida.", true);
        return;
      }
      rej = {
        bounds: m.bounds, nx: m.nx, ny: m.ny, tiempos: m.tiempos,
        temp: m.temp || [], nubosidad: m.nubosidad || [], viento: m.viento || [], direccion: m.direccion || [],
      };
      // Mantiene la hora elegida si sigue habiendo tantas; si no, la más cercana a ahora.
      if (horaIdx >= rej.tiempos.length || el.horaSlider.max !== String(rej.tiempos.length - 1)) {
        const ahora = Date.now();
        let mejor = 0, dif = Infinity;
        rej.tiempos.forEach((t, i) => {
          const d = Math.abs(Date.parse(t + "Z") - ahora);
          if (d < dif) { dif = d; mejor = i; }
        });
        horaIdx = mejor;
      }
      el.horaSlider.max = String(rej.tiempos.length - 1);
      el.horaSlider.value = String(horaIdx);
      textoHora();
      mensaje("");
      pintar();
    }

    function textoHora() {
      el.horaValor.textContent = rej && rej.tiempos[horaIdx] ? diaHora(localDe(rej.tiempos[horaIdx])) : "—";
    }

    // ── Radar de lluvia (RainViewer) ───────────────────────────────────────
    function pedirRadar() {
      radarPedido = true;
      vscode.postMessage({ type: "tiempo", op: "radar" });
    }

    function quitarRadar() {
      pararAnim();
      for (const l of radarCapas.values()) if (mapa) mapa.removeLayer(l);
      radarCapas = new Map();
      radarIdx = -1;
    }

    function alRadar(m) {
      if (!m || typeof m.host !== "string" || !/^https:\/\//.test(m.host) || !Array.isArray(m.frames) || !m.frames.length) {
        mensaje("El radar de lluvia no devolvió fotogramas.", true);
        return;
      }
      quitarRadar();
      radar = { host: m.host, frames: m.frames, maxZoom: typeof m.maxZoom === "number" ? m.maxZoom : 7 };
      el.lluviaSlider.max = String(radar.frames.length - 1);
      let ini = 0;
      radar.frames.forEach((f, i) => { if (!f.nowcast) ini = i; });
      if (capas.lluvia) mostrarFrame(ini);
      else textoFrame(ini);
    }

    function textoFrame(i) {
      const f = radar && radar.frames[i];
      el.lluviaSlider.value = String(i);
      if (!f) {
        el.lluviaHora.textContent = "—";
        return;
      }
      const hora = new Date(f.time * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
      el.lluviaHora.textContent = hora + (f.nowcast ? " · previsión" : "");
    }

    function mostrarFrame(i) {
      if (!mapa || !radar || !radar.frames[i]) return;
      const op = Number(el.opacidad.value) / 100;
      let capa = radarCapas.get(i);
      if (!capa) {
        const f = radar.frames[i];
        capa = L.tileLayer(radar.host + f.path + "/256/{z}/{x}/{y}/2/1_1.png", {
          opacity: op, maxNativeZoom: radar.maxZoom, maxZoom: 11, tileSize: 256, zIndex: 3,
        });
        radarCapas.set(i, capa);
      }
      // Solo el fotograma visible está en el mapa: los demás no piden teselas.
      radarCapas.forEach((l, k) => { if (k !== i && mapa.hasLayer(l)) mapa.removeLayer(l); });
      capa.setOpacity(op);
      if (!mapa.hasLayer(capa)) capa.addTo(mapa);
      radarIdx = i;
      textoFrame(i);
    }

    function pararAnim() {
      if (anim) clearInterval(anim);
      anim = null;
      el.play.textContent = "▶";
      el.play.title = "Animar el radar de lluvia";
    }

    function alternarAnim() {
      if (anim) {
        pararAnim();
        return;
      }
      if (!radar) return;
      el.play.textContent = "❚❚";
      el.play.title = "Pausar la animación";
      anim = setInterval(() => {
        mostrarFrame((radarIdx + 1) % radar.frames.length);
      }, 700);
    }

    // ── Chips, leyenda y controles ─────────────────────────────────────────
    function chip(btn, clave) {
      btn.addEventListener("click", () => {
        capas[clave] = !capas[clave];
        // Temperatura y nubosidad son rellenos de color: no se apilan.
        if (capas[clave] && clave === "temp") capas.nubes = false;
        if (capas[clave] && clave === "nubes") capas.temp = false;
        sincronizarCapas();
      });
    }

    function sincronizarCapas() {
      for (const [btn, clave] of [[el.lyLluvia, "lluvia"], [el.lyViento, "viento"], [el.lyTemp, "temp"], [el.lyNubes, "nubes"]]) {
        btn.classList.toggle("on", capas[clave]);
        btn.setAttribute("aria-pressed", capas[clave] ? "true" : "false");
      }
      el.ctlLluvia.hidden = !capas.lluvia;
      el.ctlHora.hidden = !hayRejilla();
      if (capas.lluvia) {
        if (radar) mostrarFrame(radarIdx >= 0 ? radarIdx : radar.frames.length - 1);
        else if (!radarPedido) pedirRadar();
      } else {
        pararAnim();
        radarCapas.forEach((l) => { if (mapa && mapa.hasLayer(l)) mapa.removeLayer(l); });
      }
      if (hayRejilla()) {
        if (rej) pintar();
        pedirRejilla(!rej);
      } else {
        mensaje("");
        pintar();
      }
      leyenda();
      if (mapa) mapa.invalidateSize();
    }

    function leyenda() {
      el.leyenda.textContent = "";
      const fila = (nombre, fondo, min, max) => {
        const f = h("div", "rd-ley");
        f.appendChild(h("span", "rd-ley-nombre", nombre));
        f.appendChild(h("span", "rd-ley-min", min));
        const barra = h("span", "rd-ley-barra");
        barra.style.background = fondo;
        f.appendChild(barra);
        f.appendChild(h("span", "rd-ley-max", max));
        el.leyenda.appendChild(f);
      };
      if (capas.lluvia) fila("LLUVIA", gradiente(PAL_LLUVIA, 0, 3), "débil", "intensa");
      if (capas.temp) fila("TEMP °C", gradiente(PAL_TEMP, -20, 46), "−20", "46");
      if (capas.nubes) {
        const c = (baseClara ? NUBE_CLARA : NUBE_OSCURA).join(",");
        fila("NUBES %", "linear-gradient(90deg, rgba(" + c + ",0), rgba(" + c + ",.9))", "0", "100");
      }
      if (capas.viento) fila("VIENTO km/h", gradiente(PAL_VIENTO, 0, 90), "0", "90");
    }

    // ── Previsión ──────────────────────────────────────────────────────────
    function celda(etiqueta, valor, extra) {
      const c = h("div", "rd-celda");
      c.appendChild(h("span", "rd-celda-et", etiqueta));
      const v = h("span", "rd-celda-val", valor);
      if (extra) v.insertBefore(extra, v.firstChild);
      c.appendChild(v);
      return c;
    }

    function pintarAhora(a) {
      el.ahora.textContent = "";
      if (!a) {
        el.ahora.appendChild(h("p", "rd-vacio", "Sin datos actuales."));
        return;
      }
      const cab = h("div", "rd-ahora-cab");
      cab.appendChild(icono(a.codigo, a.esDia));
      const grande = h("div", "rd-ahora-temp");
      grande.appendChild(h("span", "rd-ahora-num", num(a.temp, 0, "°")));
      grande.appendChild(h("span", "rd-ahora-desc", descripcion(a.codigo)));
      cab.appendChild(grande);
      el.ahora.appendChild(cab);
      const cel = h("div", "rd-celdas");
      cel.appendChild(celda("SENSACIÓN", num(a.sensacion, 0, "°")));
      cel.appendChild(celda("VIENTO", num(a.viento, 0, " km/h") + (typeof a.rachas === "number" ? " · rachas " + num(a.rachas, 0) : ""), flecha(a.direccion)));
      cel.appendChild(celda("HUMEDAD", num(a.humedad, 0, " %")));
      cel.appendChild(celda("PRESIÓN", num(a.presion, 0, " hPa")));
      cel.appendChild(celda("UV", num(a.uv, 1)));
      cel.appendChild(celda("NUBOSIDAD", num(a.nubosidad, 0, " %")));
      cel.appendChild(celda("LLUVIA", num(a.lluvia, 1, " mm")));
      el.ahora.appendChild(cel);
    }

    function pintarHoras(horas) {
      el.horas.textContent = "";
      if (!horas || !horas.length) {
        el.horas.appendChild(h("p", "rd-vacio", "Sin previsión horaria."));
        return;
      }
      let diaPrev = "";
      for (const x of horas) {
        const col = h("div", "rd-hora");
        const dia = typeof x.t === "string" ? x.t.slice(8, 10) : "";
        col.appendChild(h("span", "rd-hora-h", horaDe(x.t)));
        if (dia !== diaPrev) {
          col.classList.add("rd-hora-dia");
          col.title = diaHora(x.t);
          diaPrev = dia;
        }
        const hh = typeof x.t === "string" ? Number(x.t.slice(11, 13)) : 12;
        col.appendChild(icono(x.codigo, hh >= 7 && hh < 21));
        col.appendChild(h("span", "rd-hora-t", num(x.temp, 0, "°")));
        col.appendChild(h("span", "rd-hora-ll", x.lluvia > 0 ? num(x.lluvia, 1) + " mm" : "·"));
        el.horas.appendChild(col);
      }
    }

    function pintarDias(dias) {
      el.dias.textContent = "";
      if (!dias || !dias.length) {
        el.dias.appendChild(h("p", "rd-vacio", "Sin previsión diaria."));
        return;
      }
      for (const d of dias) {
        const f = h("div", "rd-dia");
        const dt = new Date(String(d.fecha) + "T12:00:00");
        f.appendChild(h("span", "rd-dia-n", isNaN(dt) ? String(d.fecha) : DIAS[dt.getDay()] + " " + String(d.fecha).slice(8, 10)));
        f.appendChild(icono(d.codigo, true));
        f.appendChild(h("span", "rd-dia-t", num(d.max, 0, "°") + " / " + num(d.min, 0, "°")));
        f.appendChild(h("span", "rd-dia-ll", num(d.lluviaTotal, 1, " mm") + " · " + num(d.probLluvia, 0, " %")));
        const v = h("span", "rd-dia-v");
        v.textContent = num(d.vientoMax, 0, " km/h");
        f.appendChild(v);
        f.appendChild(h("span", "rd-dia-uv", "UV " + num(d.uv, 0)));
        el.dias.appendChild(f);
      }
    }

    function alDatos(m) {
      const nuevo = !lugar || lugar.lat !== (m.lugar && m.lugar.lat) || lugar.lon !== (m.lugar && m.lugar.lon);
      if (m.horas && m.horas[0] && typeof m.actualizado === "number") {
        // horas[0] es la hora local actual del lugar: contra la hora GMT redondeada sale el desfase.
        // ponytail: desfase exacto en zonas de whole hours; en +x:30 puede errar 30 min.
        const d = Date.parse(m.horas[0].t + "Z") - Math.floor(m.actualizado / 3600000) * 3600000;
        if (!isNaN(d)) offLugar = Math.round(d / 900000) * 900000;
      }
      lugar = m.lugar && typeof m.lugar.lat === "number" && typeof m.lugar.lon === "number" ? m.lugar : lugar;
      el.titulo.textContent = "AHORA · " + (lugar ? lugar.nombre + (lugar.pais ? ", " + lugar.pais : "") : "—");
      pintarAhora(m.actual);
      pintarHoras(m.horas);
      pintarDias(m.dias);
      const hora = m.actualizado ? new Date(m.actualizado).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }) : "";
      mensaje(hora ? "Actualizado a las " + hora + "." : "");
      if (nuevo) {
        if (mapa) ponerPin();
        rej = null;
        rejPedida = null;
        pintar();
        // La rejilla nueva la pide el `moveend` de ponerPin (con su debounce): una sola petición.
      }
    }

    // ── Búsqueda ───────────────────────────────────────────────────────────
    function buscar() {
      const q = el.q.value.trim();
      if (q.length < 2) {
        mensaje("Escribe al menos dos letras del lugar.", true);
        return;
      }
      ultimaQ = q;
      mensaje("Buscando «" + q + "»…");
      vscode.postMessage({ type: "tiempo", op: "buscar", q: q });
    }

    function alLugares(m) {
      if (m.q !== ultimaQ) return;
      el.lugares.textContent = "";
      const lista = Array.isArray(m.lugares) ? m.lugares : [];
      if (!lista.length) {
        el.lugares.hidden = true;
        mensaje("Sin resultados para «" + m.q + "».", true);
        return;
      }
      mensaje("");
      for (const l of lista) {
        if (typeof l.lat !== "number" || typeof l.lon !== "number") continue;
        const li = h("li");
        const b = h("button", "rd-lugar-op");
        b.type = "button";
        b.appendChild(h("span", "rd-lugar-n", l.nombre));
        b.appendChild(h("span", "rd-lugar-r", [l.region, l.pais].filter(Boolean).join(", ")));
        b.addEventListener("click", () => {
          el.lugares.hidden = true;
          el.q.value = "";
          ultimaQ = "";
          mensaje("Cargando el tiempo…");
          vscode.postMessage({ type: "tiempo", op: "lugar", lugar: { nombre: l.nombre, pais: l.pais, lat: l.lat, lon: l.lon } });
        });
        li.appendChild(b);
        el.lugares.appendChild(li);
      }
      el.lugares.hidden = el.lugares.children.length === 0;
    }

    // ── Cableado ───────────────────────────────────────────────────────────
    chip(el.lyLluvia, "lluvia");
    chip(el.lyViento, "viento");
    chip(el.lyTemp, "temp");
    chip(el.lyNubes, "nubes");
    el.buscar.addEventListener("click", buscar);
    el.q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        buscar();
      } else if (e.key === "Escape") {
        el.lugares.hidden = true;
      }
    });
    el.actualizar.addEventListener("click", () => {
      mensaje("Cargando el tiempo…");
      vscode.postMessage({ type: "tiempo", op: "cargar" });
      if (capas.lluvia) pedirRadar();
      if (hayRejilla()) pedirRejilla(true);
    });
    el.play.addEventListener("click", alternarAnim);
    el.lluviaSlider.addEventListener("input", () => {
      pararAnim();
      mostrarFrame(Number(el.lluviaSlider.value));
    });
    el.horaSlider.addEventListener("input", () => {
      horaIdx = Number(el.horaSlider.value);
      textoHora();
      pintarSoon();
    });
    el.opacidad.addEventListener("input", () => {
      pintarSoon();
      if (radarIdx >= 0 && capas.lluvia) mostrarFrame(radarIdx);
    });
    window.addEventListener("resize", () => {
      if (mapa && abierto) {
        mapa.invalidateSize();
        ajustarCanvas();
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) pararAnim();
    });
    window.addEventListener("message", (ev) => {
      if (ev.data && ev.data.type === "theme") {
        tokens = null;
        ponerBase();
        leyenda();
        pintarSoon();
      }
    });

    return {
      abrir() {
        const primera = !abierto;
        abierto = true;
        iniciarMapa();
        if (mapa) {
          mapa.invalidateSize();
          ajustarCanvas();
        }
        if (primera) {
          mensaje("Cargando el tiempo…");
          vscode.postMessage({ type: "tiempo", op: "cargar" });
        }
      },
      cerrar() {
        pararAnim();
      },
      mensaje(m) {
        if (m.type === "tiempoDatos") alDatos(m);
        else if (m.type === "tiempoLugares") alLugares(m);
        else if (m.type === "tiempoRejilla") alRejilla(m);
        else if (m.type === "tiempoRadar") alRadar(m);
        else if (m.type === "tiempoError") {
          const pref = { datos: "", rejilla: "Rejilla: ", radar: "Radar de lluvia: ", lugares: "Búsqueda: " }[m.ambito] || "";
          if (m.ambito === "rejilla") {
            const p = m.pedido;
            const q = rejPedida && rejPedida.bounds;
            if (p && (!q || p.n !== q.n || p.s !== q.s || p.e !== q.e || p.w !== q.w)) return; // error de una petición vieja
            rejPedida = null;
          }
          if (m.ambito === "radar") radarPedido = false;
          mensaje(pref + (m.msg || "Error desconocido."), true);
        }
      },
    };
  }

  window.RadarTiempo = { crear: crear };
})();
