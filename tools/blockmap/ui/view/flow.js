// ---------- уровень 3: блок-схема ----------
const COLW = 360, ROWH = 160, SIZE = { start: [210, 46], end: [210, 46], step: [260, 62], io: [260, 62], cond: [290, 96] };
function drawFlow() {
  const fl = M.flows[state.flow], svg = el('svg'), key = 'fl:' + state.flow;
  const maxC = Math.max(...fl.nodes.map((n) => n.col)), maxR = Math.max(...fl.nodes.map((n) => n.row));
  const items = {};
  for (const n of fl.nodes) {
    const [w, h] = SIZE[n.t], o = POS[key]?.[n.id];
    items[n.id] = { x: o ? Math.max(w / 2 + 10, o[0]) : 150 + n.col * COLW, y: o ? Math.max(h / 2 + 10, o[1]) : 50 + n.row * ROWH, w, h, type: n.t };
  }
  const W = Math.max((maxC + 1) * COLW + 60, ...Object.values(items).map((it) => it.x + it.w / 2 + 40)), H = Math.max((maxR + 1) * ROWH + 40, ...Object.values(items).map((it) => it.y + it.h / 2 + 50));
  svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  arrows(svg, items, fl.edges, false, W, H);
  for (const n of fl.nodes) {
    const it = items[n.id], g = el('g', { class: 'card' + (state.sel === 's:' + n.id ? ' sel' : '') }, svg);
    g.onclick = () => { if (!justDragged()) selectStep(n.id); };
    makeDraggable(g, key, n.id, it, false, null);
    g.addEventListener('pointerenter', () => focusEdges(n.id)); g.addEventListener('pointerleave', () => focusEdges(null));
    const x = it.x, y = it.y, hw = it.w / 2, hh = it.h / 2, st = { fill: 'var(--card)', stroke: n.t === 'cond' ? 'var(--Data)' : n.t === 'io' ? 'var(--State)' : 'var(--mute)', 'stroke-width': 1.6, class: 'body' };
    if (n.uncovered) Object.assign(st, { stroke: '#ec4899', 'stroke-dasharray': '3 3', 'stroke-width': 2.6 }); // код без шага схемы
    if (n.stale) Object.assign(st, { stroke: '#f59e0b', 'stroke-dasharray': '7 3', 'stroke-width': 3 }); // код шага изменился после утверждения
    if (n.implDead) Object.assign(st, { stroke: '#f59e0b', 'stroke-dasharray': '7 3', 'stroke-width': 3 }); // реализован, но не вызывается
    if (n.orphan) Object.assign(st, { stroke: '#ef4444', 'stroke-dasharray': '3 3', 'stroke-width': 2.6 }); // шаг схемы без кода
    if (n.warn) Object.assign(st, n.ack ? { stroke: '#94a3b8', 'stroke-dasharray': '2 3', 'stroke-width': 2 } : n.warnLevel === 'logged' ? { stroke: '#f59e0b', 'stroke-width': 2.4 } : { stroke: '#f43f5e', 'stroke-width': 2.8 }); // красный — тихо глотает, жёлтый — только лог, серый — принято осознанно
    if (n.t === 'start' || n.t === 'end') el('ellipse', { cx: x, cy: y, rx: hw, ry: hh, ...st }, g);
    else if (n.t === 'cond') el('polygon', { points: `${x},${y - hh} ${x + hw},${y} ${x},${y + hh} ${x - hw},${y}`, ...st }, g);
    else if (n.t === 'io') el('polygon', { points: `${x - hw + 16},${y - hh} ${x + hw},${y - hh} ${x + hw - 16},${y + hh} ${x - hw},${y + hh}`, ...st }, g);
    else el('rect', { x: x - hw, y: y - hh, width: it.w, height: it.h, rx: 7, ...st, ...(n.kind === 'try' ? { 'stroke-dasharray': '5 3' } : {}) }, g);
    const lines = wrap(n.label, n.t === 'cond' ? 26 : 33);
    text(g, x, y - (lines.length - 1) * 7 + 4, lines, { size: 12 });
    let cy = y + hh + 4;
    const chip = (label, onclick, color) => {
      const w = Math.min(label.length * 6 + 12, 220), c = el('g', { class: 'chip' }, svg); c.onclick = (ev) => { ev.stopPropagation(); onclick(); };
      el('rect', { x: x - w / 2, y: cy, width: w, height: 17, rx: 8, fill: 'var(--panel)', stroke: color }, c);
      text(c, x, cy + 12, [label], { size: 10, fill: color }); cy += 19;
    };
    if (n.res) chip(`⛁ ${resTitle(n.res).split(' ')[0]}${n.rw ? ' (' + (n.rw === 'write' ? 'запись' : 'чтение') + ')' : ''}`, () => showResource(n.res), 'var(--Data)');
    if (n.fn) chip(`ƒ ${M.functions[n.fn].title}`, () => showFn(n.fn), 'var(--Domain)');
  }
  return svg;
}

