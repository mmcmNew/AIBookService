function edgeScale(type, hw, hh, dx, dy) {
  const ax = Math.abs(dx) || 1e-6, ay = Math.abs(dy) || 1e-6;
  if (type === 'cond') return 1 / (ax / hw + ay / hh);
  if (type === 'start' || type === 'end') return 1 / Math.sqrt((ax / hw) ** 2 + (ay / hh) ** 2);
  return Math.min(hw / ax, hh / ay);
}
// ---------- ортогональные стрелки: A* по сетке, повороты только на 90°, штрафы за пересечения и наложение ----------
const CELL = 10, BEND = 7, CROSS = 14, OVERLAP = 40, ADJ = 9;
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
function arrows(svg, items, edges, _offset, W, H) {
  const gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL), N = gw * gh;
  const defs = el('defs', {}, svg);
  defs.innerHTML = '<marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#94a3b8"/></marker>';
  const list = Object.values(items);
  list.forEach((it) => { it.x = Math.round((it.x - CELL / 2) / CELL) * CELL + CELL / 2; it.y = Math.round((it.y - CELL / 2) / CELL) * CELL + CELL / 2; });
  const blocked = new Uint8Array(N), usage = new Uint8Array(N);
  const ci = (cx, cy) => cy * gw + cx;
  for (const it of list) {
    for (let cx = Math.floor((it.x - it.w / 2 - 8) / CELL); cx <= Math.floor((it.x + it.w / 2 + 8) / CELL); cx++)
      for (let cy = Math.floor((it.y - it.h / 2 - 8) / CELL); cy <= Math.floor((it.y + it.h / 2 + 8) / CELL); cy++)
        if (cx >= 0 && cy >= 0 && cx < gw && cy < gh) blocked[ci(cx, cy)] = 1;
  }
  // порты фигуры: точка на границе + направление наружу + клетка сразу за блокировкой
  const portsOf = (it, id) => {
    const hw = it.w / 2, hh = it.h / 2, type = it.type, out = [];
    const yOff = (dx) => (type === 'cond' ? hh * (1 - Math.abs(dx) / hw) : type === 'start' || type === 'end' ? hh * Math.sqrt(Math.max(0, 1 - (dx / hw) ** 2)) : hh);
    const xOff = (dy) => (type === 'cond' ? hw * (1 - Math.abs(dy) / hh) : type === 'start' || type === 'end' ? hw * Math.sqrt(Math.max(0, 1 - (dy / hh) ** 2)) : type === 'io' ? hw - 8 : hw);
    const range = (from, to, step) => { const r2 = []; for (let v = from; v <= to; v += step) r2.push(v); return r2; };
    const m2 = Math.floor((hw - 40) / 20) * 20;
    const dxs = type === 'cond' ? [-80, -40, 0, 40, 80] : type === 'start' || type === 'end' ? [-60, -30, 0, 30, 60] : range(-m2, m2, 20);
    const dys = type === 'start' || type === 'end' ? [0] : hh >= 45 && type !== 'cond' ? [-30, -10, 10, 30] : [-20, 0, 20];
    const add = (px, py, d, key) => {
      let cx = Math.floor(px / CELL), cy = Math.floor(py / CELL);
      for (let k = 0; k < 6 && cx >= 0 && cy >= 0 && cx < gw && cy < gh && blocked[ci(cx, cy)]; k++) { cx += DIRS[d][0]; cy += DIRS[d][1]; }
      if (cx < 0 || cy < 0 || cx >= gw || cy >= gh || blocked[ci(cx, cy)]) return;
      out.push({ px, py, d, cx, cy, key: id + '|' + key });
    };
    dxs.forEach((dx) => { add(it.x + dx, it.y - yOff(dx), 3, 't' + dx); add(it.x + dx, it.y + yOff(dx), 1, 'b' + dx); });
    dys.forEach((dy) => { add(it.x - xOff(dy), it.y + dy, 2, 'l' + dy); add(it.x + xOff(dy), it.y + dy, 0, 'r' + dy); });
    return out;
  };
  const heap = { a: [], push(f, s) { const a = this.a; a.push([f, s]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }, pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; } };
  const route = (srcPorts, dstPorts) => {
    const g = new Float32Array(N * 4).fill(Infinity), prev = new Int32Array(N * 4).fill(-1), dst = new Map(dstPorts.map((p, i) => [ci(p.cx, p.cy), i]));
    const h = (cx, cy) => Math.min(...dstPorts.map((p) => Math.abs(p.cx - cx) + Math.abs(p.cy - cy)));
    heap.a = [];
    srcPorts.forEach((p) => { const s = ci(p.cx, p.cy) * 4 + p.d; g[s] = 0; heap.push(h(p.cx, p.cy), s); });
    while (heap.a.length) {
      const [, s] = heap.pop(), cell = s >> 2, d = s & 3, cx = cell % gw, cy = (cell / gw) | 0;
      if (dst.has(cell)) { const path = []; for (let q = s; q !== -1; q = prev[q]) path.push(q >> 2); return { path: path.reverse(), srcCell: path[path.length - 1] && null, dstPort: dstPorts[dst.get(cell)] }; }
      for (let nd = 0; nd < 4; nd++) {
        if (nd === ((d + 2) & 3)) continue;
        const nx = cx + DIRS[nd][0], ny = cy + DIRS[nd][1];
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const nc = ci(nx, ny); if (blocked[nc]) continue;
        const horiz = nd % 2 === 0, u = usage[nc];
        let adj = 0; // параллельные линии вплотную сливаются: штраф за соседнюю клетку той же ориентации
        if (horiz) { if (ny > 0 && (usage[nc - gw] & 1)) adj += ADJ; if (ny < gh - 1 && (usage[nc + gw] & 1)) adj += ADJ; }
        else { if (nx > 0 && (usage[nc - 1] & 2)) adj += ADJ; if (nx < gw - 1 && (usage[nc + 1] & 2)) adj += ADJ; }
        const cost = 1 + adj + (nd !== d ? BEND : 0) + (horiz ? (u & 1 ? OVERLAP : u & 2 ? CROSS : 0) : (u & 2 ? OVERLAP : u & 1 ? CROSS : 0));
        const ns = nc * 4 + nd, ng = g[s] + cost;
        if (ng < g[ns]) { g[ns] = ng; prev[ns] = s; heap.push(ng + h(nx, ny), ns); }
      }
    }
    return null;
  };
  const order = edges.map((e, i) => ({ e, i })).filter(({ e }) => items[e.from] && items[e.to])
    .sort((a, b) => (Math.abs(items[a.e.from].x - items[a.e.to].x) + Math.abs(items[a.e.from].y - items[a.e.to].y)) - (Math.abs(items[b.e.from].x - items[b.e.to].x) + Math.abs(items[b.e.from].y - items[b.e.to].y)));
  const routed = [], taken = new Set(), freePorts = (ports) => { const fr = ports.filter((p) => !taken.has(p.key)); return fr.length ? fr : ports; };
  for (const { e } of order) {
    const A = items[e.from], B = items[e.to], sp = freePorts(portsOf(A, e.from)), dp = freePorts(portsOf(B, e.to));
    const r = sp.length && dp.length ? route(sp, dp) : null;
    let pts;
    if (r) {
      const cells = r.path.map((c) => [(c % gw) * CELL + CELL / 2, ((c / gw) | 0) * CELL + CELL / 2]);
      const sPort = sp.find((p) => ci(p.cx, p.cy) === r.path[0]) || sp[0];
      taken.add(sPort.key); taken.add(r.dstPort.key); // порт занят: следующая стрелка войдёт в другую точку
      pts = [[sPort.px, sPort.py], ...cells, [r.dstPort.px, r.dstPort.py]];
      for (let i = 1; i < r.path.length; i++) { const a = r.path[i - 1], b = r.path[i], bit = (a / gw | 0) === (b / gw | 0) ? 1 : 2; usage[a] |= bit; usage[b] |= bit; } // 1 = горизонталь, 2 = вертикаль
      pts = pts.filter((p, i) => i === 0 || i === pts.length - 1 || !((pts[i - 1][0] === p[0] && p[0] === pts[i + 1][0]) || (pts[i - 1][1] === p[1] && p[1] === pts[i + 1][1])));
    } else pts = [[A.x, A.y], [B.x, B.y]];
    routed.push({ e, pts });
    const pe = el('path', { d: 'M' + pts.map((p) => p.join(',')).join(' L'), fill: 'none', stroke: e.status === 'actual' ? '#ec4899' : e.status === 'planned' ? '#60a5fa' : e.label === 'ошибка' ? '#f43f5e' : e.status === 'missing' && !e.known ? '#ef4444' : e.status === 'bypass' ? '#f59e0b' : '#94a3b8', 'stroke-width': e.status === 'actual' ? 2.2 : e.status === 'missing' || e.status === 'bypass' ? 2.2 : 1.6, 'stroke-dasharray': e.status === 'planned' ? '3 3' : e.status === 'actual' ? '2 4' : e.status === 'missing' ? '6 4' : e.back ? '5 4' : '', 'stroke-linejoin': 'miter', 'marker-end': 'url(#ar)' }, svg);
    el('title', {}, pe).textContent = [e.label, e.evidence].filter(Boolean).join(' · ');
    pe.setAttribute('data-from', e.from); pe.setAttribute('data-to', e.to); if (e.status === 'actual') pe.setAttribute('stroke-opacity', 0.55);
  }
  // подписи на самом длинном свободном отрезке
  const placed = [], hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const nodeBoxes = list.map((it) => ({ x: it.x - it.w / 2, y: it.y - it.h / 2, w: it.w, h: it.h }));
  for (const { e, pts } of routed) {
    if (!e.label || !state.labels) continue;
    const w = e.label.length * 5.8 + 10, segs = [];
    for (let i = 0; i < pts.length - 1; i++) segs.push({ len: Math.abs(pts[i + 1][0] - pts[i][0]) + Math.abs(pts[i + 1][1] - pts[i][1]), a: pts[i], b: pts[i + 1] });
    segs.sort((a, b) => b.len - a.len);
    const at = (s, t) => ({ x: s.a[0] + (s.b[0] - s.a[0]) * t - w / 2, y: s.a[1] + (s.b[1] - s.a[1]) * t - 8, w, h: 16 });
    let pick = null;
    // подпись всегда сидит НА своей линии: двигаем вдоль линии, а не в сторону от неё
    const over = (a, b) => (hit(a, b) ? Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) : 0);
    const cand = segs.flatMap((s) => [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9].map((tt) => at(s, tt)));
    pick = cand.find((b) => !placed.some((p) => hit(p, b)) && !nodeBoxes.some((n) => hit(n, b)));
    if (!pick) { // места нет: берём позицию на линии с наименьшим наложением
      const score = (b) => placed.reduce((a, p) => a + over(p, b), 0) + nodeBoxes.reduce((a, n) => a + 3 * over(n, b), 0);
      pick = cand.reduce((best, b) => (score(b) < score(best) ? b : best), cand[0]);
    }
    placed.push(pick);
    const lg = el('g', { 'data-from': e.from, 'data-to': e.to }, svg);
    el('rect', { x: pick.x, y: pick.y, width: w, height: 16, rx: 4, fill: 'var(--panel)', stroke: e.status === 'actual' ? '#ec4899' : e.status === 'missing' && !e.known ? '#ef4444' : e.status === 'bypass' ? '#f59e0b' : 'var(--line)' }, lg); // цвет рамки = цвет стрелки
    text(lg, pick.x + w / 2, pick.y + 12, [e.label], { size: 10.5 });
  }
}

function arrowsStraight(svg, items, edges, offsetPairs) {
  const defs = el('defs', {}, svg);
  defs.innerHTML = '<marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#94a3b8"/></marker>';
  const seen = {};
  for (const e of edges) {
    const a = items[e.from], b = items[e.to]; if (!a || !b) continue;
    let dx = b.x - a.x, dy = b.y - a.y; const len = Math.hypot(dx, dy) || 1;
    let ox = 0, oy = 0;
    if (offsetPairs && edges.some((o) => o.from === e.to && o.to === e.from)) { const sgn = e.from < e.to ? 1 : -1; ox = (-dy / len) * 9 * sgn; oy = (dx / len) * 9 * sgn; }
    const sa = edgeScale(a.type, a.w / 2, a.h / 2, dx, dy), sb = edgeScale(b.type, b.w / 2, b.h / 2, dx, dy);
    const x1 = a.x + dx * sa + ox, y1 = a.y + dy * sa + oy, x2 = b.x - dx * sb + ox, y2 = b.y - dy * sb + oy;
    el('line', { x1, y1, x2, y2, stroke: e.label === 'ошибка' ? '#f43f5e' : '#94a3b8', 'stroke-width': 1.6, 'stroke-dasharray': e.back ? '5 4' : '', 'marker-end': 'url(#ar)' }, svg);
    if (e.label) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, w = e.label.length * 5.8 + 10;
      const k = `${Math.round(mx)}_${Math.round(my)}`; const shift = (seen[k] = (seen[k] || 0) + 1) - 1;
      el('rect', { x: mx - w / 2, y: my - 8 + shift * 15, width: w, height: 16, rx: 4, fill: 'var(--panel)', stroke: 'var(--line)' }, svg);
      text(svg, mx, my + 4 + shift * 15, [e.label], { size: 10.5 });
    }
  }
}

