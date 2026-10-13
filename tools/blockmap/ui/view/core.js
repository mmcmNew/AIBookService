const M = /*DATA*/null;
const NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const base = (f) => f.split('/').pop();
const link = (f, l) => `<a href="vscode://file/${M.root}/${f}:${l || 1}" class="mono">${esc(base(f))}${l ? ':' + l : ''}</a>`;
const resTitle = (id) => M.states?.[id]?.title || M.resources?.[id]?.title || id;
const state = { sc: M.scenarios[0].id, flow: null, sel: null, real: true, labels: true };

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function wrap(text, max) {
  const out = []; let cur = '';
  for (const w of String(text).split(' ')) { if ((cur + ' ' + w).trim().length > max && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) out.push(cur); return out.slice(0, 3);
}
function text(parent, x, y, lines, opts = {}) {
  const t = el('text', { x, y, 'text-anchor': opts.anchor || 'middle', 'font-size': opts.size || 12, 'font-weight': opts.bold ? 600 : 400, class: opts.mono ? 'mono' : '' }, parent);
  if (opts.fill) t.setAttribute('style', `fill:${opts.fill}`);
  lines.forEach((l, i) => { const s = el('tspan', { x, dy: i === 0 ? 0 : (opts.size || 12) + 2 }, t); s.textContent = l; });
  return t;
}
// точка на границе фигуры в сторону (dx,dy)
