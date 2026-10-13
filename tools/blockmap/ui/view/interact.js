// ---------- перетаскивание: позиции хранятся только в браузере, на хеши и модель не влияют ----------
let POS = {};
try { POS = JSON.parse(localStorage.getItem('bm_pos') || '{}'); } catch { POS = {}; }
const savePos = () => { try { localStorage.setItem('bm_pos', JSON.stringify(POS)); } catch { /* без хранилища раскладка живёт до перезагрузки */ } };
let lastDrag = 0;
const justDragged = () => Date.now() - lastDrag < 250;
function redraw() { const st = $('stage'), l = st.scrollLeft, t = st.scrollTop; render(); st.scrollLeft = l; st.scrollTop = t; }
function makeDraggable(g, key, id, it, live, clamp, toStore) {
  g.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const sx = ev.clientX, sy = ev.clientY, ox = it.x, oy = it.y, zm = curZoom() || 1; let moved = false, raf = 0;
    const move = (e) => {
      const dx = (e.clientX - sx) / zm, dy = (e.clientY - sy) / zm; // экранные пиксели -> единицы схемы
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      const p = clamp ? clamp(ox + dx, oy + dy) : [Math.max(10, ox + dx), Math.max(10, oy + dy)];
      (POS[key] ||= {})[id] = toStore ? toStore(p) : p;
      if (live) { if (!raf) raf = requestAnimationFrame(() => { raf = 0; redraw(); }); } // стрелки перестраиваются на лету
      else g.setAttribute('transform', `translate(${p[0] - ox},${p[1] - oy})`); // блок-схема тяжелее: стрелки после отпускания
    };
    const up = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      if (moved) { lastDrag = Date.now(); savePos(); redraw(); }
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    ev.preventDefault();
  });
}
// ---------- масштаб ----------
const ZOOM = {};
const viewKey = () => (state.flow ? 'fl:' + state.flow : state.view === 'states' ? null : 'sc:' + state.sc);
const curZoom = () => ZOOM[viewKey()] ?? 1;
function applyZoom() {
  const svg = document.querySelector('#stage svg'), k = viewKey();
  if (!svg || !k) return;
  const vb = svg.viewBox.baseVal;
  if (ZOOM[k] === undefined) ZOOM[k] = Math.max(0.6, Math.min(1, +(($('stage').clientWidth - 30) / vb.width).toFixed(2))); // по умолчанию вписать по ширине, но не мельче 60%
  svg.setAttribute('width', vb.width * ZOOM[k]); svg.setAttribute('height', vb.height * ZOOM[k]);
  const l = $('zoomLbl'); if (l) l.textContent = Math.round(ZOOM[k] * 100) + '%';
}
function zoomBy(d) {
  const k = viewKey(); if (!k) return;
  const st = $('stage'), old = curZoom(), z = Math.min(2.5, Math.max(0.25, +(old + d).toFixed(2)));
  const cx = (st.scrollLeft + st.clientWidth / 2) / old, cy = (st.scrollTop + st.clientHeight / 2) / old;
  ZOOM[k] = z; applyZoom(); st.scrollLeft = cx * z - st.clientWidth / 2; st.scrollTop = cy * z - st.clientHeight / 2;
}
function zoomFit() { const k = viewKey(); if (!k) return; delete ZOOM[k]; applyZoom(); }
function focusEdges(id) { // наведение на блок: его стрелки яркие, остальные гаснут
  document.querySelectorAll('#stage svg [data-from]').forEach((el2) => { el2.style.opacity = !id || el2.dataset.from === id || el2.dataset.to === id ? '' : '0.1'; });
}
function resetPos() { if (state.flow) delete POS['fl:' + state.flow]; else { delete POS['sc3:' + state.sc]; delete POS['lanes:' + state.sc]; delete POS['zw:' + state.sc]; } savePos(); redraw(); }

