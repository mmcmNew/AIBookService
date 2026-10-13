// ---------- панель ----------
const tagList = (arr) => arr.join('');
function selectBlock(id) {
  const b = M.blocks[id]; state.sel = id;
  if (b.flow || b.astFlow) { state.flow = b.flow || b.astFlow; state.sel = null; render(); showBlock(id); return; }
  render(); showBlock(id);
}
function edgeList(id) {
  const rows = (M.verify?.edges || []).filter((e) => (e.from === id || e.to === id) && e.status !== 'skipped');
  if (!rows.length) return '';
  const mark = (e) => (e.status === 'ok' ? '<span style="color:#10b981">✓</span>' : e.status === 'missing' ? (e.known ? '<span class="mute">~</span>' : '<span style="color:#ef4444">✗</span>') : '<span class="warn">⚠</span>');
  const nm = (x) => esc(M.blocks[x].title);
  const li = (e) => '<li>' + mark(e) + ' ' + nm(e.from) + ' → ' + nm(e.to) + ' <span class="mute">«' + esc(e.label) + '»</span>'
    + (e.status === 'missing' ? (e.known ? ' <span class="mute">принято: ' + esc(e.known) + '</span>' : ' <span style="color:#ef4444">вызова нет в коде</span>') : '')
    + (e.status === 'bypass' ? ' <span class="warn">в обход' + (e.bypassLayers?.length ? ' слоя ' + esc(e.bypassLayers.join(', ')) : '') + (e.bypassBlocks?.length ? ' через блок ' + esc(e.bypassBlocks.map((x) => M.blocks[x]?.title || x).join(', ')) : '') + '</span>' : '')
    + (e.path ? '<br><span class="mono mute" style="font-size:11px">' + esc(e.path.map((x) => x.split('#')[1]).join(' → ')) + '</span>' : '')
    + (e.embedded && !e.embedded.ok ? '<br><span class="warn">не встроен в блок-схему: ' + esc(e.embedded.reason) + '</span>' : '') + '</li>';
  return '<h3>Связи и код</h3><ul style="padding-left:16px;margin:4px 0">' + rows.map(li).join('') + '</ul>';
}
function realList(id) {
  const rows = (M.verify?.actual || []).filter((r) => r.from === id && !['yes', 'accepted'].includes(r.declared));
  if (!rows.length) return '';
  const w = { write: 'пишет', read: 'читает', uses: 'использует', call: 'вызывает' };
  return '<h3 style="color:#ec4899">Реально в коде, но не на схеме (' + rows.length + ')</h3><ul style="padding-left:16px;margin:4px 0">' + rows.map((r) => '<li>→ ' + esc(M.blocks[r.to].title) + ': <b>' + esc((r.missingRw.length ? r.missingRw : r.rw).map((x) => w[x] || x).join(' / ')) + '</b>' + (r.declared === 'partial' ? ' <span class="mute">(на схеме есть другое' + (r.declaredIn.length ? ', сценарий: ' + esc(r.declaredIn.join(', ')) : '') + ')</span>' : '') + (r.calls.length ? '<br><span class="mono mute" style="font-size:11px">' + esc(r.calls.join(', ')) + ' · ' + esc(r.evidence) + '</span>' : '<br><span class="mono mute" style="font-size:11px">' + esc(r.evidence) + '</span>') + '</li>').join('') + '</ul>';
}
function misplacedNote(id) {
  const mp = (M.misplaced || []).find((x) => x.block === id);
  return mp ? '<p class="warn">↯ Код лежит в слое ' + esc(mp.actual) + ' (' + esc(mp.file) + '), а по замыслу блок в слое ' + esc(mp.design) + ': его нужно перенести.</p>' : '';
}
function lintList(id) {
  const rows = (M.lint?.issues || []).filter((i) => i.block === id);
  if (!rows.length) return '';
  return '<h3 style="color:#a78bfa">Проверка плана (' + rows.length + ')</h3><ul style="padding-left:16px;margin:4px 0;font-size:13px">' + rows.map((i) => '<li>' + (i.sev === 'err' ? '<span style="color:#ef4444">✗</span>' : '<span class="warn">⚠</span>') + ' ' + esc(i.text) + '</li>').join('') + '</ul>';
}
function showBlock(id) {
  const b = M.blocks[id];
  const scs = b.scenarios.map((s) => `<span class="tag click" onclick="goScenario('${s}','${id}')">${esc(M.scenarios.find((x) => x.id === s).title)}</span>`).join('');
  const res = (b.res || []).map((r) => `<span class="tag click" onclick="showResource('${r}')">⛁ ${esc(resTitle(r))}</span>`).join('');
  $('panel').innerHTML = `<h2>${esc(b.title)}</h2><span class="tag" style="border-color:var(--${b.layer});color:var(--${b.layer})">${b.layer}</span>${b.entry ? '<span class="tag">точка входа</span>' : ''}${b.fresh ? '<span class="tag">↻ свежая правка</span>' : ''}
    <p>${esc(b.summary)}</p>
    <p class="mono" style="font-size:12px">хеш ${b.hash} · ${b.scope} · ${b.hashStatus === 'ok' ? '<span style="color:#10b981">✓ утверждён</span>' : b.hashStatus === 'changed' ? '<span class="warn">⚠ изменён, затронет сценарии: ' + b.scenarios.map((s) => esc(M.scenarios.find((x) => x.id === s).title)).join(', ') + '</span>' : 'не утверждён'}</p>
    ${misplacedNote(id)}${edgeList(id)}${realList(id)}${lintList(id)}
    <div>${b.planned ? '<span class="mute">блок запланирован, кода ещё нет</span>' : link(b.file, b.line) + ' <span class="mono mute">' + esc(b.symbol) + '</span>'}</div>
    ${b.risk ? `<p class="warn">⚠ ${esc(b.risk)}</p>` : ''}
    <h3>Входит в сценарии (${b.scenarios.length})</h3>${scs}
    ${res ? `<h3>Общие ресурсы</h3>${res}` : ''}
    ${(b.fns || []).length ? `<h3>Функции</h3>${b.fns.map((f) => `<span class="tag click" onclick="showFn('${f}')">ƒ ${esc(M.functions[f].title)}</span>`).join('')}` : ''}
    ${b.flow ? '' : '<p class="mute">Блок-схема этого блока пока не описана.</p>'}`;
}
function selectStep(nid) {
  const n = M.flows[state.flow].nodes.find((x) => x.id === nid); state.sel = 's:' + nid; render();
  const typ = { start: 'начало', end: 'конец', step: 'действие', io: 'данные', cond: 'условие' }[n.t];
  const fl = M.flows[state.flow], ob = M.blocks[fl.owner], other = fl.kind === 'ast' ? M.flows[ob.flow] : M.flows[ob.astFlow];
  const labelOf = (ids) => (ids || []).map((i) => esc(other?.nodes.find((x) => x.id === i)?.label || i));
  const rel = n.coveredBy ? (n.coveredBy.length ? `<h3>Шаг схемы</h3><p>${labelOf(n.coveredBy).join('<br>')}</p>` : '<p class="warn">Нет шага в ручной схеме для этого кода.</p>')
    : n.astNodes ? (n.astNodes.length ? `<h3>Код (узлов AST: ${n.astNodes.length})</h3><p>${labelOf(n.astNodes).join('<br>')}</p>` : n.t === 'start' ? '' : '<p class="warn">Для этого шага нет кода в функции.</p>') : '';
  $('panel').innerHTML = `<h2>${esc(n.label)}</h2><span class="tag">${typ}</span>${n.warn ? `<p class="warn">⚠ ${esc(n.warn)}</p>` : ''}${n.impl ? `<h3>Реализация в другой функции</h3><p class="mono" style="font-size:12px">${esc(n.impl)}</p><p class="${n.implDead ? 'warn' : 'mute'}">${n.implDead ? '⚠ функция существует, но её никто не вызывает' : n.implOk ? '✓ функция существует' : '✗ функция не найдена'}</p>` : ''}${n.ack ? `<p class="mute">✓ принято осознанно: ${esc(n.ack)}</p>` : ''}${n.file ? `<p>${link(n.file, n.line)}${n.endLine && n.endLine !== n.line ? ' <span class="mute">–' + n.endLine + '</span>' : ''}</p>` : ''}${rel}
    ${n.res ? `<h3>Ресурс</h3><span class="tag click" onclick="showResource('${n.res}')">⛁ ${esc(resTitle(n.res))}</span>` : ''}
    ${n.fn ? `<h3>Функция</h3><span class="tag click" onclick="showFn('${n.fn}')">ƒ ${esc(M.functions[n.fn].title)}</span>` : ''}`;
}
function showDiff(id) {
  const b = M.blocks[id], d = b.diff;
  $('panel').innerHTML = `<h2>Намерение и факт</h2><p class="mute">${esc(b.title)}: ручная схема (что хотели) против AST (что получили).</p>
    <h3 style="color:#ec4899">Код без шага схемы (${d.uncovered.length})</h3>
    <ul>${d.uncovered.map((u) => `<li>${link(u.file, u.line)} ${esc(u.label)}${u.warn ? ' <span class="warn">⚠</span>' : ''}</li>`).join('') || '<li class="mute">нет</li>'}</ul>
    <h3 style="color:#f59e0b">Код шага изменился после утверждения (${(d.stale || []).length})</h3>
    <ul>${(d.stale || []).map((s) => `<li>${esc(s.label)} <span class="mute">(хешей не найдено: ${s.missing})</span>${s.candidates.length ? '<br><span class="mute">возможно, теперь:</span> ' + s.candidates.map((c) => esc(c.label) + ' <span class="mono mute">:' + c.line + '</span>').join('; ') : ''}</li>`).join('') || '<li class="mute">нет</li>'}</ul>
    <h3 style="color:#ef4444">Шаги схемы без кода (${d.orphans.length})</h3>
    <ul>${d.orphans.map((o) => `<li>${esc(o.label)}</li>`).join('') || '<li class="mute">нет</li>'}</ul>
    <p class="mute">Для LLM: <span class="mono">out/intent-vs-actual.${id}.json</span> (обе схемы и расхождения).</p>`;
}
function showResource(id) {
  if (M.states?.[id]) { // кусок состояния
    const s = M.states[id], owner = s.owner ? (M.blocks[s.owner]?.title || s.owner) : 'не назначен';
    const cat = (M.stateCatalog?.slices || []).find((x) => x.id === id);
    $('panel').innerHTML = '<h2>⛁ ' + esc(s.title) + '</h2><span class="tag">кусок состояния</span><p>Владелец: <b>' + esc(owner) + '</b></p>'
      + (cat ? '<h3>Кто пишет</h3><p style="font-size:13px">' + (cat.writers.map((w) => esc(M.blocks[w.who]?.title || w.who)).join('; ') || 'никто') + '</p><h3>Кто читает</h3><p style="font-size:13px">' + (cat.readers.slice(0, 8).map((r2) => esc(M.blocks[r2.who]?.title || r2.who) + ' ×' + r2.count).join('; ') || 'никто') + '</p>' : '')
      + '<p class="mute">Полный список: вкладка «Состояния».</p>';
    return;
  }
  const r = M.resources[id];
  const rows = r.consumers.map((c) => `<tr><td>${link(c.file)}</td><td>${c.layer}</td><td>${c.rw.length ? c.rw.map((x) => (x === 'write' ? 'пишет' : 'читает')).join(' / ') : 'использует'}</td><td>${esc(c.blocks.join(', '))}</td></tr>`).join('');
  $('panel').innerHTML = `<h2>⛁ ${esc(r.title)}</h2><span class="tag">общий ресурс · ${r.kind}</span><p>${esc(r.note)}</p><div>${link(r.file, r.line)}</div>
    <h3>Кто ещё его использует (${r.consumers.length})</h3><table><tr><th>файл</th><th>слой</th><th>как</th><th>блок</th></tr>${rows}</table>
    <p class="mute">Автоматически из кода: ${r.kind === 'db' ? 'поиск обращений к таблице, чтение/запись по методу' : 'импорты стора'}.</p>`;
}
function showFn(id) {
  const f = M.functions[id];
  $('panel').innerHTML = `<h2>ƒ ${esc(f.title)}</h2><span class="tag">функция библиотеки</span><div>${link(f.file, f.line)}</div><h3>Используется (${f.usedIn.length})</h3><ul>${f.usedIn.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>`;
}
function goScenario(s, id) { state.sc = s; state.flow = null; state.sel = id; render(); showBlock(id); }

