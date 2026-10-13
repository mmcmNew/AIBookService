// Проверка сценариев против кода:
//  1) каждая стрелка подтверждена кодом (вызов функции блока, импорт стора, запись состояния);
//  2) блок достижим от точки входа сценария по подтверждённым стрелкам (иначе «мёртвый блок на карте»);
//  3) блок реально кем-то вызывается в коде (иначе «мёртвый в коде»);
//  4) вызов встроен в блок-схему блока-вызывающего (есть шаг схемы, покрывающий вызов).

import { WRITE_ACTION } from './shared.mjs';

export function verifyModel(model, cg, graph, layerOf) {
  const fnsAll = [...cg.fns.values()];
  const idsFor = (file, symbol) => fnsAll.filter((f) => f.file === file && (f.qual === symbol || f.qual.startsWith(symbol + '.') || f.simple === symbol)).map((f) => f.id);
  const byQual = (file, qual) => fnsAll.filter((f) => f.file === file && f.qual === qual).map((f) => f.id);

  // регион блока (его код) и API (что могут вызывать другие блоки)
  const region = {}, api = {}, coreOf = {};
  for (const [id, b] of Object.entries(model.blocks)) {
    let core = idsFor(b.file, b.symbol);
    const af = model.astFlows?.[id]; if (af) core.push(...byQual(af.file, af.fn));
    if (b.members) core = b.members.flatMap((q) => fnsAll.filter((f) => f.file === b.file && (f.qual === q || f.simple === q)).map((f) => f.id)); // явный список функций блока
    const specific = [...core]; // точное ядро блока (до расширения на файл)
    if (!b.members && (!core.length || b.layer === 'UI' || b.layer === 'State')) core = [...new Set([...core, ...fnsAll.filter((f) => f.file === b.file).map((f) => f.id)])]; // экраны и сторы: весь файл
    coreOf[id] = specific;
    const reg = new Set(core);
    let frontier = [...core];
    for (let depth = 0; depth < 2; depth++) { // вспомогательные функции того же файла
      const next = [];
      for (const fid of frontier) for (const c of cg.fns.get(fid).calls) for (const t of c.to) if (cg.fns.get(t).file === b.file && !reg.has(t)) { reg.add(t); next.push(t); }
      frontier = next;
    }
    region[id] = reg;
    let a;
    if (b.members) a = [...core];
    else if (b.api) a = b.api.flatMap((q) => fnsAll.filter((f) => f.file === b.file && (f.qual === q || f.simple === q)).map((f) => f.id));
    else { const cls = idsFor(b.file, b.symbol); a = cls.length > 1 ? cls.filter((x) => !cg.fns.get(x).priv) : [...cls]; if (af) a.push(...byQual(af.file, af.fn)); }
    api[id] = new Set(a.length ? a : core);
  }

  const own = {};
  for (const [id, b] of Object.entries(model.blocks)) {
    own[id] = b.entry ? new Set([...coreOf[id], ...[...region[id]].filter((x) => coreOf[id].length && cg.fns.get(x).file === b.file && coreOf[id].some((c) => cg.fns.get(c).calls.some((k) => k.to.includes(x))))]) : region[id];
    if (!own[id].size) own[id] = region[id];
  }
  const owner = {};
  for (const fid of cg.fns.keys()) {
    const cands = Object.keys(model.blocks).filter((id) => own[id].has(fid)).sort((x, y) => own[x].size - own[y].size);
    if (cands.length) owner[fid] = cands[0];
  }
  const importsOf = (file) => graph.edges.filter(([f]) => f === file).map(([, t]) => t);
  const regionFiles = (id) => new Set([model.blocks[id].file, ...[...region[id]].map((x) => cg.fns.get(x).file)]);
  const resFiles = (id) => new Set([model.blocks[id].file]); // импортировать нужно файл самого блока
  const nameOf = (fid) => { const f = cg.fns.get(fid); return `${f.file}#${f.qual}`; };

  // поиск пути вызовов от вызывающих функций до API цели (до 4 шагов)
  const findPath = (fromSet, toSet) => {
    const prev = new Map(), q = [];
    for (const s of fromSet) { prev.set(s, null); q.push([s, 0]); }
    while (q.length) {
      const [cur, d] = q.shift();
      if (toSet.has(cur) && !fromSet.has(cur)) { const p = []; for (let x = cur; x; x = prev.get(x)) p.push(x); return p.reverse(); }
      if (d >= 4) continue;
      for (const c of cg.fns.get(cur).calls) for (const t of c.to) if (!prev.has(t)) { prev.set(t, cur); q.push([t, d + 1]); }
    }
    return null;
  };

  const result = { edges: [], dead: [], deadInCode: [], blocks: {} };
  for (const sc of model.scenarios) {
    const status = new Map();
    sc.edges.forEach((e, i) => {
      const A = model.blocks[e.from], B = model.blocks[e.to];
      const paired = sc.edges.findIndex((x) => x.from === e.to && x.to === e.from);
      const kind = e.kind || (paired >= 0 && paired < i ? 'return' : A.layer === 'State' ? 'data' : B.layer === 'State' || B.layer === 'Data' ? 'write' : 'call');
      const rec = { scenario: sc.id, from: e.from, to: e.to, label: e.label, kind, status: 'skipped', known: e.known || null };
      if (A.planned || B.planned) { rec.status = 'planned'; }
      else if (kind === 'return' || kind === 'event') { rec.status = 'skipped'; }
      else if (kind === 'data') { // состояние -> потребитель: потребитель импортирует стор
        const targets = resFiles(e.from), hit = [...regionFiles(e.to)].flatMap((f) => importsOf(f).filter((t) => targets.has(t)).map((t) => ({ file: f, imports: t })))[0];
        if (hit) { rec.status = 'ok'; rec.evidence = `${hit.file} импортирует ${hit.imports}`; } else rec.status = 'missing';
      } else if (kind === 'write') { // вызывающий пишет в состояние: импортирует стор и упоминает его
        const targets = resFiles(e.to), files = regionFiles(e.from);
        const hit = [...files].flatMap((f) => importsOf(f).filter((t) => targets.has(t)).map((t) => ({ file: f, imports: t })))[0];
        if (hit) { rec.status = 'ok'; rec.evidence = `${hit.file} импортирует ${hit.imports}`; } else rec.status = 'missing';
      } else { // вызов
        const sameFile = A.file === B.file; // блоки в одном файле: исключаем только саму вызываемую функцию
        const callers = new Set([...region[e.from]].filter((x) => (sameFile ? !api[e.to].has(x) : !region[e.to].has(x))));
        let ev = null;
        for (const cid of callers) { for (const c of cg.fns.get(cid).calls) { const t = c.to.find((x) => api[e.to].has(x)); if (t) { ev = { file: cg.fns.get(cid).file, line: c.line, from: cg.fns.get(cid).qual, to: cg.fns.get(t).qual }; break; } } if (ev) break; }
        if (ev) { rec.status = 'ok'; rec.evidence = `${ev.file}:${ev.line} ${ev.from} → ${ev.to}`; rec.call = ev; }
        else {
          const path = findPath(callers, api[e.to]);
          if (path) {
            rec.path = path.map(nameOf); rec.status = 'indirect';
            const mid = path.slice(1, -1).map((x) => layerOf(cg.fns.get(x).file));
            const midBlocks = [...new Set(path.slice(1, -1).map((x) => owner[x]).filter((o) => o && o !== e.from && o !== e.to))]; // путь идёт через чужой блок
            rec.bypassLayers = [...new Set(mid.filter((l) => l !== A.layer && l !== B.layer))]; rec.bypassBlocks = midBlocks;
            if (rec.bypassLayers.length || midBlocks.length) rec.status = 'bypass';
          } else rec.status = 'missing';
        }
        // встроен ли вызов в блок-схему вызывающего блока
        if (rec.call && A.astFlow && A.flow) {
          const astN = model.flows[A.astFlow].nodes.find((n) => n.file === rec.call.file && n.line && n.line <= rec.call.line && rec.call.line <= (n.endLine ?? n.line));
          const intent = model.flows[A.flow], step = astN && intent.nodes.find((s) => (s.astNodes || []).includes(astN.id));
          const linked = intent.nodes.find((s) => s.block === e.to);
          rec.embedded = step ? { ok: true, step: step.label } : astN ? { ok: false, reason: 'вызов есть в AST, но ни один шаг схемы его не покрывает' } : { ok: false, reason: 'вызов находится вне AST-функции блока' };
          if (linked && !rec.embedded.ok) rec.embedded = { ok: true, step: linked.label };
        }
      }
      status.set(i, rec); result.edges.push(rec);
    });
    // достижимость от точки входа по подтверждённым стрелкам
    const entries = Object.keys(sc.cols).filter((b) => model.blocks[b].entry);
    if (entries.length) {
      // связь подтверждена: код, известная причина, событие; возврат — только если подтверждена парная прямая стрелка
      const confirmed = (r) => ['ok', 'indirect', 'bypass', 'planned'].includes(r.status) || r.known
        || (r.kind === 'event') || (r.kind === 'return' && sc.edges.some((x, j) => x.from === r.to && x.to === r.from && ['ok', 'indirect', 'bypass'].includes(status.get(j).status)));
      const reach = new Set(entries);
      for (let changed = true; changed;) { // направление не важно: источники данных питают вход, но связаны с ним
        changed = false;
        sc.edges.forEach((e, i) => {
          if (!confirmed(status.get(i))) return;
          if (reach.has(e.from) !== reach.has(e.to)) { reach.add(e.from); reach.add(e.to); changed = true; }
        });
      }
      for (const b of Object.keys(sc.cols)) if (!reach.has(b)) result.dead.push({ scenario: sc.id, block: b });
    }
  }
  // «мёртвый в коде»: API блока никто не вызывает снаружи
  for (const [id, b] of Object.entries(model.blocks)) {
    if (b.entry || b.planned) continue;
    const external = [...api[id]].flatMap((a) => (cg.callers.get(a) || []).filter((c) => !region[id].has(c.from)).map((c) => ({ ...c, to: a })));
    result.blocks[id] = { api: [...api[id]].map(nameOf), callers: external.map((c) => `${nameOf(c.from)}:${c.line}`).slice(0, 5), callerCount: external.length };
    if (!external.length) result.deadInCode.push({ block: id, api: [...api[id]].map(nameOf).slice(0, 3) });
  }
  // Реальные связи из кода между блоками карты, в том числе те, которых нет на схеме.
  // access (State/Data): вызовы функций файла блока и импорты; call: вызов API блока.
  const declaredEdges = model.scenarios.flatMap((sc) => sc.edges.map((e) => ({ ...e, scenario: sc.id })));
  result.actual = [];
  for (const a of Object.keys(model.blocks)) for (const b of Object.keys(model.blocks)) {
    if (a === b || model.blocks[a].planned || model.blocks[b].planned) continue;
    const A = model.blocks[a], B = model.blocks[b];
    const callers = [...region[a]].filter((x) => ((A.entry && !A.members) || owner[x] === a) && !region[b].has(x));
    let rec = null;
    if (B.layer === 'State' || B.layer === 'Data') {
      if (A.file === B.file && !B.members && !A.members) continue;
      const calls = [];
      for (const cid of callers) for (const c of cg.fns.get(cid).calls) for (const t2 of c.to) if (B.layer === 'State' && (B.members ? api[b].has(t2) : cg.fns.get(t2).file === B.file)) calls.push({ file: cg.fns.get(cid).file, line: c.line, name: c.name, qual: cg.fns.get(t2).qual });
      // обращения к таблицам БД: строки из реестра ресурсов, попавшие внутрь функций этого блока
      const dbrw = [];
      for (const rid of B.res || []) { const r = model.resources[rid]; if (r?.kind === 'db') for (const c of r.consumers) for (const ln of c.lines || []) {
        const fn = fnsAll.find((x) => x.file === c.file && x.line <= ln && ln <= x.endLine && owner[x.id] === a);
        if (fn) { dbrw.push(...c.rw); if (!calls.length) calls.push({ file: c.file, line: ln, name: rid.replace(/^res_/, ''), qual: B.file }); break; }
      } }
      if (!calls.length && !dbrw.length) continue;
      const names = [...new Set(calls.map((c) => c.name))], writes = names.filter((n) => WRITE_ACTION.test(n));
      const rwSet = [...new Set([...(writes.length ? ['write'] : calls.length ? ['read'] : []), ...dbrw])];
      rec = { type: 'access', rw: rwSet.length ? rwSet : ['uses'], calls: names.slice(0, 6), evidence: calls[0] ? calls[0].file + ':' + calls[0].line + ' → ' + calls[0].qual : 'импорт ' + B.file };
    } else {
      let ev = null; const names = new Set();
      for (const cid of callers) for (const c of cg.fns.get(cid).calls) { const t2 = c.to.find((x) => api[b].has(x)); if (t2) { names.add(cg.fns.get(t2).qual.split('.').pop()); ev ||= { file: cg.fns.get(cid).file, line: c.line, to: cg.fns.get(t2).qual }; } }
      if (!ev) continue;
      rec = { type: 'call', rw: ['call'], calls: [...names].slice(0, 6), evidence: ev.file + ':' + ev.line + ' → ' + ev.to };
    }
    const direct = declaredEdges.filter((e) => e.from === a && e.to === b), rev = declaredEdges.filter((e) => e.from === b && e.to === a);
    if (rec.type === 'call') { rec.declared = direct.length ? 'yes' : 'no'; rec.missingRw = []; }
    else {
      const have = new Set([...(direct.length ? ['write'] : []), ...(rev.length ? ['read'] : [])]);
      rec.missingRw = rec.rw.filter((x) => (x === 'write' ? !have.has('write') : x === 'read' ? !have.size : false));
      rec.declared = rec.missingRw.length ? (have.size ? 'partial' : 'no') : 'yes';
    }
    rec.declaredIn = [...new Set([...direct, ...rev].map((e) => e.scenario))]; // в каких сценариях эта пара блоков уже нарисована
    const acc = model.realityAcks?.[a + '>' + b];
    if (acc && rec.declared !== 'yes') { rec.declared = 'accepted'; rec.acceptReason = acc; }
    result.actual.push({ from: a, to: b, ...rec });
  }
  result.owner = owner;
  return result;
}
