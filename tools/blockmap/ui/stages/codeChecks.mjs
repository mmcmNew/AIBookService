// Сверка кода с планом. Три шага подряд: стрелки и реальные связи, каталог состояний, слои и зоны.
// Факты о коде берёт только через ui/facts.mjs; стрелки проверяет блок «Сверка связей» (ui/verify.mjs).
import { verifyModel } from '../verify.mjs';
import { statesOf, deadExports } from '../facts.mjs';
import { WRITE_ACTION, layerOf } from '../shared.mjs';

// Этап 8а: стрелки сценариев против кода (граф вызовов), встроенность вызова в блок-схему, шаги с impl.

const rwWord = { write: 'пишет', read: 'читает', uses: 'использует', call: 'вызывает' };

// Реальные связи, которых нет на схеме, — для рисования поверх сценария
function actualEdges(model) {
  for (const sc of model.scenarios) {
    sc.actualEdges = model.verify.actual.filter((r) => !['yes', 'accepted'].includes(r.declared) && sc.cols[r.from] !== undefined && sc.cols[r.to] !== undefined).map((r) => ({
      from: r.from, to: r.to, status: 'actual', kind: r.type, rw: r.rw, missingRw: r.missingRw, evidence: r.evidence,
      label: 'в коде: ' + ((r.missingRw?.length ? r.missingRw : r.rw).map((x) => rwWord[x] || x).join(' / ')) + (r.calls.length ? ' ' + r.calls.slice(0, 2).join(', ') + (r.calls.length > 2 ? '…' : '') : ''),
    }));
  }
}

function reality(ctx) {
  const { model, graph, cg } = ctx;
  model.verify = verifyModel(model, cg, graph, layerOf);
  for (const sc of model.scenarios) for (const e of sc.edges) {
    const r = model.verify.edges.find((x) => x.scenario === sc.id && x.from === e.from && x.to === e.to && x.label === e.label);
    if (r) { e.status = r.status; e.evidence = r.evidence || (r.path ? r.path.join(' → ') : undefined); e.embedded = r.embedded; }
  }
  // шаги схемы, реализованные другой функцией (impl: «файл#функция»): функция существует, и её кто-то вызывает?
  model.verify.implDead = [];
  for (const [bid, b] of Object.entries(model.blocks)) if (b.flow) for (const nd of model.flows[b.flow].nodes) if (nd.impl) {
    const fn = cg.fns.get(nd.impl);
    nd.implOk = !!fn; nd.implDead = !!fn && !(cg.callers.get(nd.impl) || []).length;
    if (nd.implOk) nd.orphan = false;
    if (nd.implDead) model.verify.implDead.push({ block: bid, step: nd.label, impl: nd.impl });
    if (b.diff) b.diff.orphans = model.flows[b.flow].nodes.filter((q) => q.orphan).map((q) => ({ id: q.id, label: q.label }));
  }
}

// Этап 8б: каталог состояний (кто пишет и читает кусок, владелец), обращения к ресурсам с ответственным,
// чужие вызовы действий стора вычищаются из реальных связей.

function states(ctx) {
  const { model, graph, cg, log } = ctx;
  const stores = statesOf(graph.files, cg, layerOf), blocksByFileMap = {};
  for (const [bid, b] of Object.entries(model.blocks)) if (!b.planned) (blocksByFileMap[b.file] ||= []).push(bid);
  const blockOfFn = (fid) => { if (!fid) return null; const f = cg.fns.get(fid); return model.verify.owner?.[fid] || blocksByFileMap[f.file]?.[0] || null; };
  const who = (fid, file) => blockOfFn(fid) || 'файл ' + (file || (fid && cg.fns.get(fid)?.file) || '?');
  const slices = [], taken = new Set();
  for (const [sid, d] of Object.entries(model.states || {})) {
    const st = stores.find((s) => s.name === d.store); if (!st) continue;
    const names = d.all ? st.fields.map((f) => f.name) : d.fields.filter((n) => st.fields.some((f) => f.name === n));
    const fields = st.fields.filter((f) => names.includes(f.name)); fields.forEach((f) => taken.add(d.store + '.' + f.name));
    const writers = {}, readers = {};
    for (const f of fields) {
      for (const i of f.initiators) { const bb = model.blocks[blockOfFn(i.fn)]; if (bb && bb.layer === 'State' && !bb.members && cg.fns.get(i.fn)?.file === st.file) continue; /* внутренние вызовы самого стора */ const w = (writers[who(i.fn, i.file)] ||= { who: who(i.fn, i.file), fields: new Set(), via: new Set(), sites: [] }); w.fields.add(f.name); w.via.add(i.via); if (w.sites.length < 3) w.sites.push(i.file + ':' + i.line); }
      for (const r of f.readers) { const rd = (readers[who(r.fn, r.file)] ||= { who: who(r.fn, r.file), fields: new Set(), count: 0 }); rd.fields.add(f.name); rd.count++; }
    }
    const wl = Object.values(writers).map((w) => ({ ...w, fields: [...w.fields], via: [...w.via] })), rl = Object.values(readers).map((r) => ({ ...r, fields: [...r.fields] }));
    const violations = [];
    if (d.owner) for (const w of wl) if (w.who !== d.owner) violations.push({ who: w.who, via: w.via, fields: w.fields, sites: w.sites, layer: model.blocks[w.who]?.layer || null });
    slices.push({ id: sid, title: d.title, store: d.store, file: st.file, owner: d.owner || null, note: d.note || null, fields: fields.map((f) => f.name), writers: wl, readers: rl, violations });
  }
  const unassigned = stores.flatMap((s) => s.fields.filter((f) => !taken.has(s.name + '.' + f.name)).map((f) => s.name + '.' + f.name));
  const leaks = stores.flatMap((s) => s.actions.filter((a) => a.leaks.length).map((a) => ({ store: s.name, file: s.file, action: a.name, leaks: a.leaks, sets: a.sets })));
  // ресурсы (таблицы БД) с ответственным: обращения из чужих блоков по реальному коду
  model.resourceViolations = [];
  for (const [rid, r] of Object.entries(model.resources)) {
    if (!r.owner || !r.consumers) continue;
    for (const c of r.consumers) {
      if (r.readers === 'any' && !c.rw.includes('write')) continue; // ресурс читают все, пишет владелец
      const fns2 = [...cg.fns.values()].filter((x) => x.file === c.file && (c.lines || []).some((ln) => x.line <= ln && ln <= x.endLine)), seenWho = new Set();
      for (const fn of fns2) { const w = who(fn.id, c.file); if (w !== r.owner && !seenWho.has(w) && !model.blocks[w]?.res?.includes(rid)) { seenWho.add(w); model.resourceViolations.push({ resource: rid, owner: r.owner, who: w, rw: c.rw, file: c.file, line: (c.lines || [])[0] }); } }
      if (!fns2.length && (c.lines || []).length) model.resourceViolations.push({ resource: rid, owner: r.owner, who: 'файл ' + c.file, rw: c.rw, file: c.file, line: c.lines[0] });
    }
  }
  // действие стора относится к тому состоянию, поля которого оно меняет: убираем чужие вызовы из реальных связей
  const writerOf = {}, allSetters = new Set();
  for (const s of stores) for (const a of s.actions) if (a.sets.length) { allSetters.add(a.name); for (const sl of slices) if (sl.store === s.name && a.sets.some((f) => sl.fields.includes(f))) (writerOf[sl.id] ||= new Set()).add(a.name); }
  model.verify.actual = model.verify.actual.filter((r) => {
    const T = model.blocks[r.to];
    if (r.type !== 'access' || !T.slice || !writerOf[T.slice]) return true;
    const mine = r.calls.filter((c) => writerOf[T.slice].has(c) || !allSetters.has(c)); // свои действия и действия-чтения
    if (r.calls.length && !mine.length) return false;
    r.calls = mine; // запись только если среди своих вызовов есть изменяющее действие
        r.rw = mine.some((c) => WRITE_ACTION.test(c)) ? ['write'] : mine.length ? ['read'] : r.rw; return true;
    });
    actualEdges(model);
  model.stateCatalog = { stores: stores.map((s) => ({ name: s.name, file: s.file, fields: s.fields.length, actions: s.actions.length })), slices, unassigned, leaks };
  log(`  состояния: сторов ${stores.length}, кусков ${slices.length}, не разнесено полей ${unassigned.length}, действий с логикой в сторе ${leaks.length}`);
}

// Этап 8в: код блока в чужом слое; вызовы и записи между зонами идут не в главу зоны; мёртвые функции.

function zones(ctx) {
  const { model, graph, cg, log } = ctx;
  model.misplaced = Object.entries(model.blocks).filter(([, b]) => !b.planned && b.file && layerOf(b.file) !== b.layer && layerOf(b.file) !== '—').map(([id, b]) => ({ block: id, design: b.layer, actual: layerOf(b.file), file: b.file }));
  model.zoneViolations = [];
  if (model.zones) for (const r of model.verify.actual) {
    const A = model.blocks[r.from], T = model.blocks[r.to];
    if (!A.zone || !T.zone || A.zone === T.zone || r.declared === 'accepted') continue;
    if (r.type === 'access' && !r.rw.includes('write')) continue; // чтение состояния разрешено
    if (model.zones[T.zone]?.head !== r.to) model.zoneViolations.push({ from: r.from, to: r.to, zFrom: A.zone, zTo: T.zone, head: model.zones[T.zone]?.head, calls: r.calls, rw: r.rw, evidence: r.evidence });
  }
  model.deadFunctions = deadExports(graph.files, cg);
  const v = model.verify.edges, n = (s) => v.filter((x) => x.status === s).length;
  log(`  стрелки: подтверждено ${n('ok')}, косвенно ${n('indirect')}, в обход слоя ${n('bypass')}, НЕ подтверждено ${n('missing')}, пропущено (возврат/событие) ${n('skipped')}; мёртвых на карте ${model.verify.dead.length}, мёртвых в коде ${model.verify.deadInCode.length}`);
}

export function checkCodeAgainstPlan(ctx) {
  reality(ctx);
  states(ctx);
  zones(ctx);
}
