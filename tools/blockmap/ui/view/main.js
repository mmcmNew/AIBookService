// ---------- каркас ----------
function renderMain() {
  $('tabs').innerHTML = ''; M.scenarios.forEach((s) => { const b = document.createElement('button'); b.textContent = s.title + (s.status === 'changed' ? ' ⚠' : ''); b.className = s.id === state.sc ? 'on' : ''; b.onclick = () => { state.view = null; state.sc = s.id; state.flow = null; state.sel = null; render(); $('panel').innerHTML = `<h2>${esc(s.title)}</h2><p>${esc(s.desc)}</p><p class="mute">Блоков: ${Object.keys(s.cols).length}. ▸ — у блока есть блок-схема.</p>`; }; $('tabs').appendChild(b); });
  const sc = M.scenarios.find((s) => s.id === state.sc);
  $('crumbs').innerHTML = state.flow ? `<a onclick="state.flow=null;state.sel=null;render()">${esc(sc.title)}</a> › ${esc(M.blocks[M.flows[state.flow].owner].title)} › блок-схема` : esc(sc.title) + ' › сценарий';
  $('legend').innerHTML = state.flow ? '<span>овал — начало/конец</span><span>ромб — условие</span><span>параллелограмм — данные</span><span>прямоугольник — действие</span>' : M.layers.map((l) => `<span><i style="background:var(--${l})"></i>${l}</span>`).join('') + '<span style="color:#94a3b8">━ подтверждено кодом</span><span style="color:#ef4444">┅ в коде нет</span><span style="color:#f59e0b">━ в обход слоя</span><span style="color:#ec4899">··· есть в коде, нет на схеме</span>';
  $('realTog').textContent = 'реальные связи из кода: ' + (state.real ? 'вкл' : 'выкл'); $('realTog').style.display = state.flow ? 'none' : '';
  $('stage').innerHTML = '';
  if (state.flow) {
    const fl = M.flows[state.flow], ob = M.blocks[fl.owner], bar = document.createElement('div');
    bar.style.cssText = 'margin-bottom:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
    const opts = [['manual', 'Ручная', ob.flow], ['ast', 'Из AST', ob.astFlow]].filter((o) => o[2]);
    const apv = ob.approval, apChip = !apv ? '' : apv.status === 'ok' ? `<span class="tag" style="border-color:#10b981;color:#10b981">✓ утверждено ${esc(apv.at)} · хеши совпадают</span>`
      : apv.status === 'new' ? '<span class="tag">не утверждено</span>' : `<span class="tag click" style="border-color:#f59e0b;color:#f59e0b" onclick="showDiff('${fl.owner}')">⚠ изменилось с утверждения: ${[apv.codeChanged ? 'код' : '', apv.schemaChanged ? 'схема' : ''].filter(Boolean).join(' и ')}</span>`;
    bar.innerHTML = apChip + opts.map(([k, t, id]) => `<span class="tag click" style="${fl.kind === k ? 'background:var(--accent);color:#fff' : ''}" onclick="state.flow='${id}';state.sel=null;render()">${t}</span>`).join('') + (ob.diff ? `<span class="tag click" style="border-color:#ec4899;color:#ec4899" onclick="showDiff('${fl.owner}')">Сверка: покрыто ${ob.diff.covered}/${ob.diff.total} · код без шага схемы: ${ob.diff.uncovered.length} · шаги без кода: ${ob.diff.orphans.length}</span>` : '') + `<span class="mute">${esc(fl.kind === 'ast' ? 'Сгенерировано из кода: ' + fl.source + ' (узлов: ' + fl.nodes.length + ')' : fl.title)}</span>`;
    $('stage').appendChild(bar); $('stage').appendChild(drawFlow());
  } else $('stage').appendChild(drawScenario());
}
// ---------- каталог состояний ----------
function renderStates() {
  const C = M.stateCatalog, wrap = document.createElement('div');
  const nm = (x) => (M.blocks[x] ? esc(M.blocks[x].title) + ' <span class="mute">[' + M.blocks[x].layer + ']</span>' : '<span class="mute">' + esc(x) + '</span>');
  wrap.innerHTML = '<p class="mute" style="margin:0 0 10px">Все состояния в одном месте: где лежит, кто владелец (единственный, кто пишет), кто пишет и кто читает. Данные собираются из кода автоматически, владельцев назначает model.json (states).</p>'
    + '<div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(440px,1fr))">' + C.slices.map((s) => {
      const own = s.owner ? '<span class="tag" style="border-color:#10b981;color:#10b981">владелец: ' + esc(M.blocks[s.owner]?.title || s.owner) + '</span>' : '<span class="tag">владелец не назначен' + (s.note ? ' · ' + esc(s.note) : '') + '</span>';
      const wr = s.writers.map((w) => '<tr><td>' + nm(w.who) + '</td><td class="mono" style="font-size:11px">' + esc(w.via.slice(0, 4).join(', ')) + '</td></tr>').join('') || '<tr><td colspan="2" class="mute">никто</td></tr>';
      const rd = s.readers.sort((a, b) => b.count - a.count).slice(0, 8).map((r) => nm(r.who) + ' <span class="mute">×' + r.count + '</span>').join('; ') || '<span class="mute">никто</span>';
      const vio = s.violations.map((v) => '<div style="color:#ef4444;font-size:12px">✗ запись не из владельца: ' + nm(v.who) + ' <span class="mono">(' + esc(v.via.slice(0, 3).join(', ')) + ')</span></div>').join('');
      return '<div class="card" style="cursor:default;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px"><h2 style="font-size:15px;margin:0 0 4px">' + esc(s.title) + '</h2>'
        + '<div class="mono mute" style="font-size:11px">' + esc(s.file) + ' · ' + esc(s.store) + '</div><div style="margin:6px 0">' + own + '</div>'
        + '<div class="mute" style="font-size:12px">поля: ' + esc(s.fields.slice(0, 10).join(', ')) + (s.fields.length > 10 ? ' … +' + (s.fields.length - 10) : '') + '</div>'
        + '<h3 style="font-size:12px;color:var(--mute);margin:10px 0 2px">ПИШУТ</h3><table>' + wr + '</table>' + vio
        + '<h3 style="font-size:12px;color:var(--mute);margin:10px 0 2px">ЧИТАЮТ</h3><div style="font-size:12px">' + rd + '</div></div>';
    }).join('') + '</div>'
    + '<h3 style="margin:16px 0 4px">Логика в сторе (' + C.leaks.length + ')</h3><div class="mute" style="font-size:12px;margin-bottom:4px">Состояние только хранит; эти действия вызывают функции других слоёв:</div><table>'
    + C.leaks.map((l) => '<tr><td class="mono" style="font-size:12px">' + esc(l.store + '.' + l.action) + '</td><td class="mono mute" style="font-size:11px">→ ' + esc(l.leaks.slice(0, 3).join(', ')) + '</td></tr>').join('') + '</table>'
    + (C.unassigned.length ? '<p class="warn" style="font-size:12px">Не разнесено по кускам: ' + esc(C.unassigned.join(', ')) + '</p>' : '');
  return wrap;
}
function showVersion() {
  const v = M.version;
  $('panel').innerHTML = v ? '<h2>Схема v' + esc(v.current) + '</h2><p>Веха: ' + esc(v.milestone) + '</p><h3>История</h3>' + v.changelog.slice().reverse().map((c) => '<p><b>v' + esc(c.version) + '</b> <span class="mute">' + esc(c.date) + ' · ' + esc(c.bump) + '</span><br>' + esc(c.note) + (c.changes?.length ? '<br><span class="mute" style="font-size:12px">' + c.changes.map(esc).join('<br>') + '</span>' : '') + '</p>').join('') : '<h2>Версия не выпущена</h2><p class="mute">Выпустить: node tools/blockmap/blockmap.mjs release "заметка"</p>';
}
function render() {
  renderMain(); applyZoom(); $('verTag').textContent = M.version ? 'схема v' + M.version.current : 'версия не выпущена'; $('lblTog').textContent = 'подписи: ' + (state.labels ? 'вкл' : 'выкл');
  const tabs = $('tabs'), b = document.createElement('button');
  b.textContent = 'Состояния'; b.className = state.view === 'states' ? 'on' : ''; b.onclick = () => { state.view = 'states'; render(); $('panel').innerHTML = '<h2>Каталог состояний</h2><p class="mute">Куски состояния, их владельцы и кто пишет и читает. Правило: пишет только блок-владелец, остальные просят его командой.</p>'; };
  tabs.appendChild(b);
  if (state.view === 'states') {
    [...tabs.children].forEach((x) => { if (x !== b) x.classList.remove('on'); });
    $('crumbs').innerHTML = 'Каталог состояний'; $('legend').innerHTML = ''; $('realTog').style.display = 'none';
    $('stage').innerHTML = ''; $('stage').appendChild(renderStates());
  }
}
$('stage').addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 0.1 : -0.1); } }, { passive: false });
render();
