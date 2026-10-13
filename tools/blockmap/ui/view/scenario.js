// ---------- уровень 1: сценарий по слоям ----------
const LANE_H = 220, MIN_LANE = 150, CARD_W = 240, CARD_H = 100, COL_W = 330, X0 = 130;
function drawScenario() {
  const sc = M.scenarios.find((s) => s.id === state.sc), svg = el('svg'), key = 'sc3:' + sc.id, lk = 'lanes:' + sc.id, zk = 'zw:' + sc.id;
  const Z = M.zones || {}, zoneIds = Object.keys(Z), zoneOf = (id) => M.blocks[id].zone || '_none';
  const ZHEAD = zoneIds.length ? 40 : 0, ZPAD = 28, ZGAP = 40, ZCOL = ['#0ea5e9', '#10b981', '#8b5cf6', '#f59e0b', '#f43f5e', '#14b8a6', '#a3a3a3'];
  const zcolor = (z) => ZCOL[Math.max(0, zoneIds.indexOf(z)) % ZCOL.length];
  // зоны: порядок, ширина (по колонкам внутри зоны, можно расширить ручкой), положение рамок
  const present = [...new Set(Object.keys(sc.cols).map(zoneOf))], pref = sc.zoneOrder || zoneIds;
  const order = pref.filter((z) => present.includes(z)).concat(present.filter((z) => !pref.includes(z)));
  const localW = {}; for (const id of Object.keys(sc.cols)) { const z = zoneOf(id); localW[z] = Math.max(localW[z] || 0, sc.cols[id] + 1); }
  const zLeft = {}, zWidth = {}, zBase = {}; let xAcc = X0 - 6;
  order.forEach((z) => { zBase[z] = (localW[z] - 1) * COL_W + CARD_W + 2 * ZPAD; zWidth[z] = Math.max(zBase[z], POS[zk]?.[z] ?? 0); zLeft[z] = xAcc; xAcc += zWidth[z] + ZGAP; });
  // высота каждого слоя регулируется (кнопки − / + и ручка внизу слоя)
  const lh = (i) => Math.min(1400, Math.max(MIN_LANE, POS[lk]?.[i] ?? LANE_H));
  const tops = []; let acc = ZHEAD; M.layers.forEach((l, i) => { tops.push(acc); acc += lh(i); });
  // позиции блоков: по умолчанию колонка внутри зоны + середина слоя; хранятся относительно рамки зоны и слоя
  const items = {}, clampOf = {};
  for (const [id, col] of Object.entries(sc.cols)) {
    const bl = M.blocks[id], li = M.layers.indexOf(bl.layer), z = zoneOf(id);
    const lo = tops[li] + CARD_H / 2 + 6, hi = tops[li] + lh(li) - CARD_H / 2 - 6, xl = zLeft[z] + ZPAD / 2 + CARD_W / 2, xr = zLeft[z] + zWidth[z] - ZPAD / 2 - CARD_W / 2;
    clampOf[id] = (x, y) => [Math.min(xr, Math.max(xl, x)), Math.min(hi, Math.max(lo, y))]; // блок не выходит за рамку своей зоны и слоя
    const o = POS[key]?.[id], def = [zLeft[z] + ZPAD + CARD_W / 2 + col * COL_W, tops[li] + lh(li) / 2 + 8];
    const [x, y] = o ? clampOf[id](zLeft[z] + o[0], tops[li] + o[1]) : clampOf[id](def[0], def[1]);
    items[id] = { x, y, w: CARD_W, h: CARD_H, type: 'step' };
  }
  const W = xAcc - ZGAP + 20, H = acc;
  svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const setLane = (i, h) => { (POS[lk] ||= {})[i] = Math.min(1400, Math.max(MIN_LANE, Math.round(h))); };
  M.layers.forEach((l, i) => {
    el('rect', { x: 0, y: tops[i], width: W, height: lh(i), fill: i % 2 ? 'transparent' : 'var(--band)' }, svg);
    el('rect', { x: 0, y: tops[i], width: 5, height: lh(i), fill: `var(--${l})` }, svg);
    text(svg, 14, tops[i] + 20, [l.toUpperCase()], { anchor: 'start', size: 12, bold: true, fill: `var(--${l})` });
    [['−', -80, 80], ['+', 80, 104]].forEach(([sym, d, dx]) => { // высота слоя: − и +
      const gb = el('g', { style: 'cursor:pointer' }, svg); gb.onclick = () => { setLane(i, lh(i) + d); savePos(); redraw(); };
      el('rect', { x: dx - 2, y: tops[i] + 6, width: 20, height: 20, rx: 4, fill: 'var(--panel)', stroke: 'var(--line)' }, gb); text(gb, dx + 8, tops[i] + 21, [sym], { size: 14, bold: true });
      el('title', {}, gb).textContent = d > 0 ? 'Выше слой' : 'Ниже слой';
    });
  });
  // жёсткие рамки зон: подпись, глава зоны, ручка ширины справа
  if (zoneIds.length) order.forEach((z) => {
    const col = zcolor(z), zi = Z[z], head = zi && M.blocks[zi.head];
    el('rect', { x: zLeft[z], y: 2, width: zWidth[z], height: H - 4, rx: 14, fill: col, 'fill-opacity': 0.045, stroke: col, 'stroke-width': 2.2, 'pointer-events': 'none' }, svg);
    text(svg, zLeft[z] + 14, 17, [zi ? zi.title : 'Без зоны'], { anchor: 'start', size: 13.5, bold: true, fill: col });
    if (head) text(svg, zLeft[z] + 14, 31, ['★ глава: ' + head.title], { anchor: 'start', size: 10, fill: 'var(--mute)' });
    const hw = el('rect', { x: zLeft[z] + zWidth[z] - 6, y: ZHEAD, width: 12, height: H - ZHEAD, fill: 'transparent', style: 'cursor:ew-resize' }, svg);
    el('title', {}, hw).textContent = 'Потяните, чтобы изменить ширину зоны «' + (zi ? zi.title : z) + '»';
    hw.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const sx = ev.clientX, w0 = zWidth[z], zm = curZoom() || 1; let raf = 0;
      const move = (e) => { (POS[zk] ||= {})[z] = Math.max(zBase[z], Math.min(2400, Math.round(w0 + (e.clientX - sx) / zm))); if (!raf) raf = requestAnimationFrame(() => { raf = 0; redraw(); }); };
      const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); savePos(); redraw(); };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); ev.preventDefault();
    });
  });
  arrows(svg, items, state.real ? [...sc.edges, ...(sc.actualEdges || [])] : sc.edges, true, W, H);
  for (const [id, it] of Object.entries(items)) {
    const bl = M.blocks[id], g = el('g', { class: 'card' + (state.sel === id ? ' sel' : '') }, svg), z = zoneOf(id), li = M.layers.indexOf(bl.layer);
    g.onclick = () => { if (!justDragged()) selectBlock(id); };
    makeDraggable(g, key, id, it, true, clampOf[id], (p) => [p[0] - zLeft[z], p[1] - tops[li]]);
    g.addEventListener('pointerenter', () => focusEdges(id)); g.addEventListener('pointerleave', () => focusEdges(null));
    el('rect', { class: 'body', x: it.x - it.w / 2, y: it.y - it.h / 2, width: it.w, height: it.h, rx: 9, fill: 'var(--card)', stroke: `var(--${bl.layer})`, 'stroke-width': bl.entry ? 3 : 1.5 }, g);
    el('rect', { x: it.x - it.w / 2, y: it.y - it.h / 2, width: 6, height: it.h, rx: 3, fill: `var(--${bl.layer})` }, g);
    const tl = wrap(bl.title, 31); if (tl.length > 2) { tl.length = 2; tl[1] = tl[1].slice(0, 25) + '…'; } // не более двух строк, чтобы не налезать на файл
    text(g, it.x + 3, it.y - 22, tl, { size: 13, bold: true });
    text(g, it.x + 3, it.y + 20, [bl.planned ? 'план: кода ещё нет' : `${base(bl.file)}:${bl.line}`], { size: 10, mono: true, fill: bl.planned ? '#60a5fa' : 'var(--mute)' });
    const hasFlow = bl.flow || bl.astFlow;
    if (bl.planned) { const r = g.querySelector('rect.body'); r.setAttribute('stroke', '#60a5fa'); r.setAttribute('stroke-dasharray', '6 4'); r.setAttribute('stroke-width', 2.4); }
    if (bl.hashStatus === 'changed') { const r = g.querySelector('rect.body'); r.setAttribute('stroke', '#f59e0b'); r.setAttribute('stroke-dasharray', '7 3'); r.setAttribute('stroke-width', 3); }
    const tags = [Z[z]?.head === id ? '★ глава зоны' : '', (M.misplaced || []).some((x) => x.block === id) ? '↯ не в своём слое' : '', bl.hashStatus === 'changed' ? '⚠ изменён' : '', bl.entry ? '● вход' : '', bl.risk ? '⚠' : '', bl.fresh ? '↻' : '', bl.scenarios.length > 1 ? `×${bl.scenarios.length} сцен.` : '', hasFlow ? '▸ схема' + (bl.flow && bl.astFlow ? ' ×2' : '') : ''].filter(Boolean).join('  ');
    text(g, it.x + 3, it.y + 37, [tags], { size: 10, fill: hasFlow ? 'var(--accent)' : 'var(--mute)' });
  }
  // ручка внизу каждого слоя: потяните вниз или вверх, чтобы изменить высоту слоя
  M.layers.forEach((l, i) => {
    const hy = tops[i] + lh(i) - 5, h = el('rect', { x: 0, y: hy, width: W, height: 10, fill: 'transparent', style: 'cursor:ns-resize' }, svg);
    el('line', { x1: W / 2 - 24, x2: W / 2 + 24, y1: hy + 5, y2: hy + 5, stroke: 'var(--mute)', 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0.45, 'pointer-events': 'none' }, svg);
    h.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const sy = ev.clientY, h0 = lh(i), zm = curZoom() || 1; let raf = 0;
      const move = (e) => { setLane(i, h0 + (e.clientY - sy) / zm); if (!raf) raf = requestAnimationFrame(() => { raf = 0; redraw(); }); };
      const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); savePos(); redraw(); };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); ev.preventDefault();
    });
    el('title', {}, h).textContent = 'Потяните, чтобы изменить высоту слоя ' + l;
  });
  return svg;
}

