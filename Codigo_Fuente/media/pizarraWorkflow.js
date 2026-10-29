/* Pizarra — capa DIAGRAMA: geometría pura de nodos y conectores.
   Aquí no hay DOM: solo cuentas. `pizarra.js` aporta el contexto de dibujo y el estado.

   Nodo:   { id, shape, x, y, w, h, text, icon, fill, stroke }
   Arista: { id, from, to, fromSide, toSide, waypoints, label, color, width, dashed,
             arrows: "arrow" | "both" | "none" }
   `from`/`to` valen un id de `nodesById`, un nodo suelto o un punto libre { x, y }.
   `waypoints` es la polilínea explícita del usuario; los codos que añade el router para
   ortogonalizar entre el stub y el primer/último punto NO se persisten ni son asas.

   Se puede cargar con `require` en node para comprobarla sin navegador. */
(function () {
  "use strict";

  /** Formas de nodo, en el orden del selector de la barra. */
  const SHAPES = ["rect", "round", "stadium", "diamond", "ellipse", "icon"];
  /** Lados de una caja, en el sentido del reloj desde arriba. */
  const SIDES = ["t", "r", "b", "l"];
  /** Dirección de salida de cada lado (unitaria, en ejes del lienzo). */
  const OUT = { t: { x: 0, y: -1 }, r: { x: 1, y: 0 }, b: { x: 0, y: 1 }, l: { x: -1, y: 0 } };
  /** Cuánto sale el conector del lado antes de girar, en píxeles de lienzo. */
  const STUB = 18;
  /** Separación entre conectores que unen el mismo par de nodos. */
  const LANE = 12;

  /**
   * Iconos de nodo: una sola cadena `d` por icono sobre un viewBox de 24 × 24.
   * Van a trazo (nada de relleno): `pizarra.js` los pinta con `ctx.stroke`.
   */
  const ICONS = {
    mail: "M3 6h18v12H3zM3 7l9 6 9-6",
    key: "M16 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM13.2 10.8 4 20v1h2v-2h2v-2h2l3.2-3.2",
    user: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 20c0-3.3 3.6-6 8-6s8 2.7 8 6",
    database: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
    cloud: "M7 18h10a4 4 0 0 0 .6-7.9A6 6 0 0 0 6 10.5 3.75 3.75 0 0 0 7 18z",
    api: "M3 12h9M8 8l4 4-4 4M16 8h5v8h-5z",
    clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l4 2",
    gear: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1",
    doc: "M6 3h8l4 4v14H6zM14 3v5h4",
    lock: "M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3",
    globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3.2 3 3.2 15 0 18M12 3c-3.2 3-3.2 15 0 18",
    terminal: "M3 4h18v16H3zM7 9l3 3-3 3M13 15h4",
  };

  // ── Utilidades de cuenta ───────────────────────────────────

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function dist(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  /** Punto desplazado `k` en la dirección `dir`. */
  function offset(p, dir, k) {
    return { x: p.x + dir.x * k, y: p.y + dir.y * k };
  }

  /** Punto con la coordenada `a` (eje `A`: "x" o "y") y la `v` en el otro eje. */
  function at(A, a, v) {
    return A === "x" ? { x: a, y: v } : { x: v, y: a };
  }

  function nodeCenter(n) {
    return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
  }

  /** Radio de esquina: solo lo redondeado lo usa. */
  function nodeRadius(n) {
    if (n.shape === "round") return Math.min(14, n.w / 4, n.h / 4);
    if (n.shape === "stadium") return n.h / 2;
    return 0;
  }

  // ── Anclajes y lados ───────────────────────────────────────

  /**
   * Punto medio de un lado, deslizado hacia `toward` y sin salirse del 15-85 % del lado:
   * dos conectores que salen por el mismo lado no se pisan en la esquina.
   */
  function anchorPoint(n, side, toward) {
    const c = nodeCenter(n);
    const t = toward && typeof toward.x === "number" ? toward : c;
    const slideX = clamp(t.x, n.x + n.w * 0.15, n.x + n.w * 0.85);
    const slideY = clamp(t.y, n.y + n.h * 0.15, n.y + n.h * 0.85);
    if (side === "t") return { x: slideX, y: n.y, side: "t" };
    if (side === "r") return { x: n.x + n.w, y: slideY, side: "r" };
    if (side === "b") return { x: slideX, y: n.y + n.h, side: "b" };
    return { x: n.x, y: slideY, side: "l" };
  }

  /**
   * Lados enfrentados según el delta dominante entre las dos cajas. Si las cajas ya se
   * solapan en ese eje, los lados de ese eje no enfrentan nada: manda el perpendicular.
   */
  function autoSides(a, b) {
    const ca = nodeCenter(a);
    const cb = nodeCenter(b);
    const dx = cb.x - ca.x;
    const dy = cb.y - ca.y;
    const solapaX = a.x < b.x + b.w && b.x < a.x + a.w;
    const solapaY = a.y < b.y + b.h && b.y < a.y + a.h;
    let horizontal = Math.abs(dx) >= Math.abs(dy);
    if (horizontal ? solapaX : solapaY) horizontal = !horizontal;
    if (horizontal) {
      return dx >= 0 ? { from: "r", to: "l" } : { from: "l", to: "r" };
    }
    return dy >= 0 ? { from: "b", to: "t" } : { from: "t", to: "b" };
  }

  // ── Ruta de un conector ────────────────────────────────────

  /** Extremo de arista: `{ node }` si casa un nodo, `{ point }` si es un punto suelto. */
  function resolveEnd(ref, nodesById) {
    if (typeof ref === "string") {
      const n = nodesById ? nodesById[ref] : null;
      return n ? { node: n } : null;
    }
    if (ref && typeof ref === "object" && typeof ref.x === "number" && typeof ref.y === "number") {
      if (typeof ref.w === "number" && typeof ref.h === "number") return { node: ref };
      return { point: { x: ref.x, y: ref.y } };
    }
    return null;
  }

  /** Hacia dónde se ancla: el centro del otro nodo o el punto libre. */
  function towardOf(end) {
    if (!end) return null;
    return end.node ? nodeCenter(end.node) : end.point;
  }

  /**
   * Lado a usar: el pedido si es válido, el automático, o el que mire al otro extremo.
   * `autoSides` lee `x/y/w/h`: se le pasa una caja de tamaño cero en las coordenadas del
   * punto (punta libre) o del centro del otro nodo.
   */
  function sideOf(pref, auto, node, other) {
    if (SIDES.indexOf(pref) >= 0) return pref;
    if (auto) return auto;
    const t = towardOf(other);
    return autoSides(node, { x: t.x, y: t.y, w: 0, h: 0 }).from;
  }

  /** Dirección de arranque cuando el origen es un punto libre: el eje de mayor delta. */
  function freeDir(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) >= Math.abs(dy)) return { x: dx >= 0 ? 1 : -1, y: 0 };
    return { x: 0, y: dy >= 0 ? 1 : -1 };
  }

  /** Añade un punto saltándose los duplicados: el trazo no gana segmentos de longitud cero. */
  function push(points, p) {
    const last = points[points.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) return;
    points.push({ x: p.x, y: p.y });
  }

  /** Un codo entre dos puntos: si no comparten eje, gira en la coordenada del destino. */
  function elbow(points, from, to) {
    if (Math.abs(from.x - to.x) > 0.01 && Math.abs(from.y - to.y) > 0.01) {
      points.push({ x: to.x, y: from.y });
    }
  }

  /**
   * Tramo interior entre los dos extremos de los stubs (`a1` y `b1`), siempre ortogonal.
   * `da`/`db` son las direcciones de salida; `db` nulo cuando el destino es un punto libre.
   */
  function connect(a1, da, b1, db, lane) {
    if (!db) return freeRun(a1, da, b1);
    const ha = da.x !== 0;
    const hb = db.x !== 0;
    if (ha === hb) return bothAxis(a1, da, b1, db, ha, lane);
    return mixed(a1, da, b1, db, ha);
  }

  /**
   * Los dos stubs corren por el mismo eje. Enfrentados, se juntan por un canal a mitad de
   * camino; si salen hacia el mismo lado, el canal va por fuera. Las salidas cruzadas
   * (destino detrás) rodean por el otro eje.
   */
  function bothAxis(a1, da, b1, db, horizontal, lane) {
    const A = horizontal ? "x" : "y";
    const V = horizontal ? "y" : "x";
    const daA = horizontal ? da.x : da.y;
    const dbA = horizontal ? db.x : db.y;
    const empuje = lane * LANE;
    const enfrentados = (b1[A] - a1[A]) * daA > 0 && (a1[A] - b1[A]) * dbA > 0;
    if (enfrentados) {
      if (a1[V] === b1[V]) return [];
      const medio = (a1[A] + b1[A]) / 2 + empuje * (daA > 0 ? 1 : -1);
      return [at(A, medio, a1[V]), at(A, medio, b1[V])];
    }
    if (daA === dbA) {
      const canal =
        (daA > 0 ? Math.max(a1[A], b1[A]) : Math.min(a1[A], b1[A])) + daA * (STUB + empuje);
      if (a1[V] === b1[V]) return [at(A, canal, a1[V])];
      return [at(A, canal, a1[V]), at(A, canal, b1[V])];
    }
    // Destino detrás: se sale, se baja (o sube) por fuera de las dos cajas y se entra en vertical.
    const fuera = a1[A] + daA * (STUB + empuje);
    const vFuera = (b1[V] >= a1[V] ? Math.max(a1[V], b1[V]) : Math.min(a1[V], b1[V])) +
      (b1[V] >= a1[V] ? 1 : -1) * (STUB + empuje);
    return [at(A, fuera, a1[V]), at(A, fuera, vFuera), at(A, b1[A], vFuera)];
  }

  /** Un stub horizontal y otro vertical: un codo si cabe, si no se rodea con dos. */
  function mixed(a1, da, b1, db, ha) {
    if (ha) {
      if ((b1.x - a1.x) * da.x > 0 && (a1.y - b1.y) * db.y > 0) {
        return Math.abs(a1.y - b1.y) < 0.01 ? [] : [{ x: b1.x, y: a1.y }];
      }
    } else if ((b1.y - a1.y) * da.y > 0 && (a1.x - b1.x) * db.x > 0) {
      return Math.abs(a1.x - b1.x) < 0.01 ? [] : [{ x: a1.x, y: b1.y }];
    }
    const pa = offset(a1, da, STUB);
    const pb = offset(b1, db, STUB);
    return ha
      ? [pa, { x: pa.x, y: pb.y }, pb]
      : [pa, { x: pb.x, y: pa.y }, pb];
  }

  /** Camino hasta un punto libre: el último tramo puede ser diagonal. */
  function freeRun(a1, da, point) {
    if (da.x !== 0) {
      if ((point.x - a1.x) * da.x > 0) {
        return Math.abs(a1.y - point.y) < 0.01 ? [] : [{ x: point.x, y: a1.y }];
      }
      const pa = offset(a1, da, STUB);
      return [pa, { x: pa.x, y: point.y }];
    }
    if ((point.y - a1.y) * da.y > 0) {
      return Math.abs(a1.x - point.x) < 0.01 ? [] : [{ x: a1.x, y: point.y }];
    }
    const pa = offset(a1, da, STUB);
    return [pa, { x: point.x, y: pa.y }];
  }

  /**
   * Ruta completa de una arista. Devuelve `{ points, label, labelAngle }`:
   * `label` es el punto a mitad de recorrido y `labelAngle`, el ángulo de ese segmento.
   */
  function routeEdge(edge, nodesById, lane) {
    const carril = Number(lane) || 0;
    const e = edge || {};
    const A = resolveEnd(e.from, nodesById);
    const B = resolveEnd(e.to, nodesById);
    if (!A || !B) return { points: [], label: { x: 0, y: 0 }, labelAngle: 0 };

    const auto = A.node && B.node ? autoSides(A.node, B.node) : null;
    const fromSide = A.node ? sideOf(e.fromSide, auto && auto.from, A.node, B) : null;
    const toSide = B.node ? sideOf(e.toSide, auto && auto.to, B.node, A) : null;

    const a0 = A.node ? anchorPoint(A.node, fromSide, towardOf(B)) : A.point;
    const b0 = B.node ? anchorPoint(B.node, toSide, towardOf(A)) : B.point;
    const a1 = A.node ? offset(a0, OUT[fromSide], STUB) : a0;
    const b1 = B.node ? offset(b0, OUT[toSide], STUB) : b0;
    const da = A.node ? OUT[fromSide] : freeDir(a0, b1);
    const db = B.node ? OUT[toSide] : null;

    const points = [a0];
    if (A.node) push(points, a1);

    if (e.waypoints && e.waypoints.length) {
      // Con codos a mano manda el usuario: se pasa por ellos en orden, con un codo por tramo.
      let cur = a1;
      for (const w of e.waypoints) {
        if (!w || typeof w.x !== "number" || typeof w.y !== "number") continue;
        elbow(points, cur, w);
        push(points, w);
        cur = w;
      }
      elbow(points, cur, b1);
      push(points, b1);
    } else {
      for (const p of connect(a1, da, b1, db, carril)) push(points, p);
      push(points, b1);
    }

    if (B.node) push(points, b0);

    const mid = pointAt(points, 0.5);
    return { points, label: { x: mid.x, y: mid.y }, labelAngle: mid.angle };
  }

  // ── Dibujo (sin tocar estilos: solo traza) ─────────────────

  /** Rectángulo redondeado a mano: `arcTo` no admite un radio mayor que medio lado. */
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    if (!rr) {
      ctx.rect(x, y, w, h);
      return;
    }
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /** Traza una polilínea con las esquinas redondeadas. No hace `fill` ni `stroke`. */
  function roundedPath(ctx, points, radius) {
    if (!points || !points.length) return;
    const r = radius == null ? 10 : radius;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1];
      const cur = points[i];
      const next = points[i + 1];
      const d1 = dist(prev, cur);
      const d2 = dist(cur, next);
      if (!d1 || !d2) {
        ctx.lineTo(cur.x, cur.y);
        continue;
      }
      const rr = Math.min(r, d1 / 2, d2 / 2);
      ctx.lineTo(cur.x + ((prev.x - cur.x) / d1) * rr, cur.y + ((prev.y - cur.y) / d1) * rr);
      ctx.quadraticCurveTo(cur.x, cur.y, cur.x + ((next.x - cur.x) / d2) * rr, cur.y + ((next.y - cur.y) / d2) * rr);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  /** Traza la silueta del nodo. El icono no traza nada: lo dibuja `pizarra.js`. */
  function nodePath(ctx, n) {
    const x = n.x;
    const y = n.y;
    const w = Math.max(0.01, n.w);
    const h = Math.max(0.01, n.h);
    ctx.beginPath();
    if (n.shape === "icon") return;
    if (n.shape === "ellipse") {
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      return;
    }
    if (n.shape === "diamond") {
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w / 2, y + h);
      ctx.lineTo(x, y + h / 2);
      ctx.closePath();
      return;
    }
    if (n.shape === "stadium") {
      roundRect(ctx, x, y, w, h, Math.min(w, h) / 2);
      return;
    }
    roundRect(ctx, x, y, w, h, nodeRadius(n));
  }

  /** Golpe sobre el nodo con la geometría de su forma, no con la caja. */
  function hitNode(n, p) {
    const hw = n.w / 2;
    const hh = n.h / 2;
    if (hw <= 0 || hh <= 0) return false;
    const dx = p.x - (n.x + hw);
    const dy = p.y - (n.y + hh);
    if (n.shape === "ellipse") return (dx * dx) / (hw * hw) + (dy * dy) / (hh * hh) <= 1;
    if (n.shape === "diamond") return Math.abs(dx) / hw + Math.abs(dy) / hh <= 1;
    if (n.shape === "stadium") {
      if (hw >= hh) {
        const qx = clamp(dx, -(hw - hh), hw - hh);
        return (dx - qx) * (dx - qx) + dy * dy <= hh * hh;
      }
      const qy = clamp(dy, -(hh - hw), hh - hw);
      return dx * dx + (dy - qy) * (dy - qy) <= hw * hw;
    }
    return Math.abs(dx) <= hw && Math.abs(dy) <= hh;
  }

  // ── Medidas sobre polilíneas ───────────────────────────────

  /** Distancia de un punto a un segmento. */
  function distSegment(p, a, b) {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / len2, 0, 1);
    return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
  }

  /** Distancia mínima a la polilínea. */
  function distanceToPolyline(p, points) {
    let best = Infinity;
    if (!points || points.length < 2) return best;
    for (let i = 1; i < points.length; i++) {
      const d = distSegment(p, points[i - 1], points[i]);
      if (d < best) best = d;
    }
    return best;
  }

  /** Segmento más cercano: `{ index, distance }`, o `{ index: -1, distance: Infinity }`. */
  function segmentHit(points, p, tol) {
    let index = -1;
    let best = Infinity;
    if (points && points.length > 1) {
      for (let i = 1; i < points.length; i++) {
        const d = distSegment(p, points[i - 1], points[i]);
        if (d < best) {
          best = d;
          index = i - 1;
        }
      }
    }
    const tope = tol == null ? Infinity : tol;
    if (!(best <= tope)) return { index: -1, distance: Infinity };
    return { index, distance: best };
  }

  /** Punto a la fracción `t` de la longitud total, con el ángulo del segmento que lo pisa. */
  function pointAt(points, t) {
    if (!points || !points.length) return { x: 0, y: 0, angle: 0 };
    if (points.length === 1) return { x: points[0].x, y: points[0].y, angle: 0 };
    let total = 0;
    for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
    if (!total) return { x: points[0].x, y: points[0].y, angle: 0 };
    let falta = clamp(t, 0, 1) * total;
    for (let i = 1; i < points.length; i++) {
      const d = dist(points[i - 1], points[i]);
      if (falta <= d || i === points.length - 1) {
        const k = d ? falta / d : 0;
        const a = points[i - 1];
        const b = points[i];
        return {
          x: a.x + (b.x - a.x) * k,
          y: a.y + (b.y - a.y) * k,
          angle: Math.atan2(b.y - a.y, b.x - a.x),
        };
      }
      falta -= d;
    }
    const last = points[points.length - 1];
    return { x: last.x, y: last.y, angle: 0 };
  }

  /** Triángulo de la punta de flecha: `tip` es el extremo de la arista. */
  function arrowHead(from, to, size) {
    const s = size == null ? 10 : size;
    const a = Math.atan2(to.y - from.y, to.x - from.x);
    const bx = to.x - Math.cos(a) * s;
    const by = to.y - Math.sin(a) * s;
    const px = Math.cos(a + Math.PI / 2) * s * 0.5;
    const py = Math.sin(a + Math.PI / 2) * s * 0.5;
    return {
      tip: { x: to.x, y: to.y },
      a: { x: bx + px, y: by + py },
      b: { x: bx - px, y: by - py },
    };
  }

  // ── Exportación a Mermaid ──────────────────────────────────

  /** Apertura y cierre del rótulo de cada forma en Mermaid. */
  const MERMAID = {
    rect: ['["', '"]'],
    round: ['("', '")'],
    stadium: ['(["', '"])'],
    diamond: ['{"', '"}'],
    ellipse: ['(("', '"))'],
    icon: ['["', '"]'],
  };

  /** Sanea un id a `[A-Za-z0-9_]`; vacío si no queda nada válido. */
  function saneId(id) {
    return String(id == null ? "" : id).replace(/[^A-Za-z0-9_]/g, "");
  }

  /** Texto de rótulo: comillas escapadas y saltos de línea convertidos en `<br/>`. */
  function mermaidText(text) {
    return String(text == null ? "" : text)
      .replace(/"/g, "#quot;")
      .replace(/\r?\n/g, "<br/>");
  }

  /** Conector entre dos nodos según flechas y discontinuidad. */
  function mermaidArrow(edge) {
    const dash = edge.dashed === true;
    if (edge.arrows === "none") return dash ? "-.-" : "---";
    if (edge.arrows === "both") return dash ? "<-.->" : "<-->";
    return dash ? "-.->" : "-->";
  }

  /** `flowchart TD` del diagrama: nodos primero, aristas después. */
  function toMermaid(flow) {
    const doc = flow || {};
    const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
    const edges = Array.isArray(doc.edges) ? doc.edges : [];
    const vivos = Object.create(null);
    const lineas = ["flowchart TD"];

    for (const n of nodes) {
      if (!n) continue;
      const id = saneId(n.id);
      if (!id || vivos[id]) continue;
      vivos[id] = true;
      const par = MERMAID[n.shape] || MERMAID.rect;
      let texto = n.text;
      if ((texto == null || String(texto) === "") && n.shape === "icon") {
        texto = n.icon ? String(n.icon) : "";
      }
      lineas.push(id + par[0] + mermaidText(texto) + par[1]);
    }

    for (const e of edges) {
      if (!e) continue;
      const desde = saneId(e.from);
      const hasta = saneId(e.to);
      if (!vivos[desde] || !vivos[hasta]) continue; // arista huérfana
      const etiqueta = mermaidText(e.label);
      lineas.push(desde + mermaidArrow(e) + (etiqueta ? "|" + etiqueta + "|" : "") + hasta);
    }

    return lineas.join("\n") + "\n";
  }

  // ── Documento ──────────────────────────────────────────────

  /** Copia profunda por JSON: el documento solo lleva datos. */
  function cloneDoc(doc) {
    return JSON.parse(JSON.stringify(doc));
  }

  /** Id corto con prefijo: 8 caracteres de `[a-z0-9]`. */
  function newId(prefix) {
    const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
    let out = String(prefix == null ? "" : prefix);
    for (let i = 0; i < 8; i++) out += abc.charAt(Math.floor(Math.random() * abc.length));
    return out;
  }

  const PZFlow = {
    SHAPES,
    SIDES,
    ICONS,
    STUB,
    nodeCenter,
    nodeRadius,
    anchorPoint,
    autoSides,
    routeEdge,
    roundedPath,
    nodePath,
    hitNode,
    distanceToPolyline,
    segmentHit,
    pointAt,
    arrowHead,
    toMermaid,
    cloneDoc,
    newId,
  };

  globalThis.PZFlow = PZFlow;
  if (typeof module !== "undefined") module.exports = PZFlow;
})();
