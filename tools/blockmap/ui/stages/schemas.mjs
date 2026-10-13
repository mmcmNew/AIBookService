// Сверка схем с кодом. Три шага подряд: блок-схемы функций из AST, сверка схемы-намерения с фактом (bind по хешу),
// дерево хешей (блок → сценарий). Код читает только через ui/facts.mjs.
import { flowOf, membersOf, hashOfMembers, normalize } from '../facts.mjs';
import { DB_WRITE, sha } from '../shared.mjs';

// Этап 5: блок-схемы функций из AST, подсказки по диспетчерам, отметки ресурсов на узлах.
function astFlows(ctx) {
  const { model, warnings, hints, log } = ctx;
  // 5. блок-схемы из AST
  for (const [id, a] of Object.entries(model.astFlows || {})) {
    try {
      const g = flowOf(a.file, a.fn);
      if (!g) { warnings.push(`AST ${id}: функция ${a.fn} не найдена в ${a.file}`); continue; }
      const fid = 'ast_' + id;
      model.flows[fid] = { title: `${a.fn} (из AST)`, kind: 'ast', owner: id, source: `${a.file} · ${a.fn}`, nodes: g.nodes, edges: g.edges, codeHash: g.codeHash };
      model.blocks[id].astFlow = fid;
      // осознанные риски: model.riskAcks[отпечаток] = { reason }, отпечаток = хеш текста catch/.catch, при правке кода подтверждение сбрасывается
      for (const n of g.nodes) if (n.warn && n.riskFp && model.riskAcks?.[n.riskFp]) n.ack = model.riskAcks[n.riskFp].reason;
      // якорь-диспетчер: у метода мало узлов, а в классе есть метод с настоящей логикой
      if (g.nodes.length <= 5 && a.fn.includes('.')) {
        const [cls, me] = a.fn.split('.');
        const sibs = membersOf(a.file, cls).filter((x) => x !== me).map((name) => {
          try { const gg = flowOf(a.file, `${cls}.${name}`); return gg ? { name, n: gg.nodes.length } : null; } catch { return null; }
        }).filter((x) => x && x.n >= 8).sort((x, y) => y.n - x.n).slice(0, 3);
        if (sibs.length) hints.push(`${id}: AST «${a.fn}» всего ${g.nodes.length} узлов (похоже на диспетчер). Методы с логикой: ${sibs.map((s) => `${s.name} (${s.n})`).join(', ')}. Укажите нужный в astFlows.`);
      }
      // автометки ресурсов на узлах AST (+ чтение/запись для таблиц БД)
      for (const n of g.nodes) {
        for (const [rid, r] of Object.entries(model.resources)) {
          if (!r.nodePattern || !n.src || !new RegExp(r.nodePattern).test(n.src)) continue;
          n.res = rid;
          if (r.kind === 'db') n.rw = DB_WRITE.test(n.src) ? 'write' : 'read';
        }
      }
      log(`  AST ${a.fn}: узлов ${g.nodes.length}, рёбер ${g.edges.length}`);
    } catch (e) { warnings.push(`AST ${id}: ${e.message}`); }
  }
}

// Этап 6: сверка схемы-намерения с фактом (AST); шаги привязаны к коду по хешу (bind), запасной вариант covers.
function intent(ctx) {
  const { model, raw, hints, writeOut, bindOn, log } = ctx;
  raw.approved ||= {}; model.approved = raw.approved;
  const overlap = (a, [s, e]) => a.line <= e && (a.endLine ?? a.line) >= s;
  for (const [id, b] of Object.entries(model.blocks)) {
    if (!b.flow || !b.astFlow) continue;
    const intent = model.flows[b.flow], actual = model.flows[b.astFlow];
    // старый формат: узел с file+line без covers считается привязкой к этой строке
    for (const n of intent.nodes) if (!n.covers && !n.bind && n.file === actual.nodes.find((x) => x.file)?.file && n.line) { n.covers = [[n.line, n.line]]; n.legacy = true; }
    if (intent.nodes.some((n) => n.legacy)) hints.push(`${id}: у схемы «${b.flow}» нет covers, привязка выведена из line. Задайте covers: [[с, по]] явно.`);
    if (!intent.nodes.some((n) => n.covers || n.bind)) { hints.push(`${id}: схема-намерение «${b.flow}» не привязана к коду (ни у одного узла нет covers или bind), сверка не работает.`); continue; }
    const real = actual.nodes.filter((a) => a.line && a.t !== 'start');
    const byKey = Object.fromEntries(real.map((a) => [a.key, a]));
    if (bindOn(id)) {
      for (const n of intent.nodes) if (n.covers) {
        n.bind = real.filter((a) => n.covers.some((r) => overlap(a, r))).map((a) => a.key);
        raw.flows[b.flow].nodes.find((x) => x.id === n.id).bind = n.bind;
      }
    }
    const schemaHash = sha(JSON.stringify({ n: intent.nodes.map((n) => [n.id, n.t, n.label, n.bind ?? n.covers]), e: intent.edges }));
    b.schemaHash = schemaHash;
    if (bindOn(id)) raw.approved[id] = { codeHash: actual.codeHash, schemaHash, at: new Date().toISOString().slice(0, 10) };
    const bound = new Set();
    for (const n of intent.nodes) {
      if (n.bind) {
        n.astNodes = n.bind.filter((k) => byKey[k]).map((k) => byKey[k].id);
        n.missing = n.bind.filter((k) => !byKey[k]);
        n.stale = n.missing.length > 0;
        n.bind.forEach((k) => bound.add(k));
      } else {
        n.astNodes = real.filter((a) => (n.covers || []).some((r) => overlap(a, r))).map((a) => a.id);
        n.astNodes.forEach((i) => bound.add(actual.nodes.find((a) => a.id === i).key));
      }
      n.orphan = n.t !== 'start' && !n.astNodes.length && !n.stale;
    }
    for (const a of real) { a.coveredBy = intent.nodes.filter((n) => n.astNodes.includes(a.id)).map((n) => n.id); a.uncovered = !bound.has(a.key); }
    for (const n of intent.nodes.filter((x) => x.stale)) {
      n.candidates = real.filter((a) => a.uncovered && (n.covers || []).some((r) => overlap(a, r))).map((a) => ({ label: a.label, line: a.line }));
    }
    const ap = raw.approved[id];
    b.approval = ap ? { status: ap.codeHash === actual.codeHash && ap.schemaHash === schemaHash ? 'ok' : 'changed', codeChanged: ap.codeHash !== actual.codeHash, schemaChanged: ap.schemaHash !== schemaHash, at: ap.at } : { status: 'new' };
    b.diff = {
      total: real.length, covered: real.filter((a) => !a.uncovered).length,
      uncovered: real.filter((a) => a.uncovered).map((a) => ({ id: a.id, label: a.label, line: a.line, file: a.file, warn: a.warn })),
      orphans: intent.nodes.filter((n) => n.orphan).map((n) => ({ id: n.id, label: n.label })),
      stale: intent.nodes.filter((n) => n.stale).map((n) => ({ id: n.id, label: n.label, missing: n.missing.length, candidates: n.candidates })),
    };
    writeOut(`intent-vs-actual.${id}.json`, {
      block: b.title, source: actual.source, approval: b.approval,
      intent: intent.nodes.map((n) => ({ id: n.id, type: n.t, label: n.label, bind: n.bind, covers: n.covers, astNodes: n.astNodes, stale: n.stale, candidates: n.candidates })),
      actual: actual.nodes.map((a) => ({ id: a.id, key: a.key, type: a.t, label: a.label, line: a.line, coveredBy: a.coveredBy, risk: a.warn })),
      gaps: { codeWithoutIntent: b.diff.uncovered, intentWithoutCode: b.diff.orphans, intentWithChangedCode: b.diff.stale },
    });
    log(`  сверка ${id}: покрыто ${b.diff.covered}/${b.diff.total}, код без шага: ${b.diff.uncovered.length}, шаг без кода: ${b.diff.orphans.length}, код изменился: ${b.diff.stale.length}; утверждение: ${b.approval.status}`);
  }
  for (const [id, b] of Object.entries(model.blocks)) if (b.flow && !b.astFlow) hints.push(`${id}: есть схема «${b.flow}», но нет astFlows — привязывать не к чему.`);
}

// Этап 7: дерево хешей: код блока + схема → блок; блоки + связи → сценарий.
function hashes(ctx) {
  const { model, raw, read, bindOn, log } = ctx;
  raw.approvedBlocks ||= {}; raw.approvedScenarios ||= {};
  for (const [id, b] of Object.entries(model.blocks)) {
    const g = b.planned ? null : b.astFlow ? model.flows[b.astFlow] : flowOf(b.file, b.symbol);
    if (b.planned) { b.codeHash = 'plan'; b.scope = 'план'; } else if (b.members) { b.codeHash = hashOfMembers(b.file, b.members); b.scope = 'функции блока'; } else if (g?.codeHash) { b.codeHash = g.codeHash; b.scope = 'функция'; } else { b.codeHash = sha(normalize(read(b.file))); b.scope = 'файл'; }
    b.hash = sha(b.codeHash + (b.schemaHash || ''));
    if (bindOn(id)) raw.approvedBlocks[id] = b.hash;
    const ap = raw.approvedBlocks[id];
    b.hashStatus = ap ? (ap === b.hash ? 'ok' : 'changed') : 'new';
  }
  for (const s of model.scenarios) {
    const ids = Object.keys(s.cols).sort();
    s.hash = sha(JSON.stringify({ e: s.edges.map(({ from, to, label, kind }) => ({ from, to, label, kind })), c: s.cols, b: ids.map((i) => [i, model.blocks[i].hash]) }));
    if (bindOn(s.id)) raw.approvedScenarios[s.id] = s.hash;
    const ap = raw.approvedScenarios[s.id];
    s.changedBlocks = ids.filter((i) => model.blocks[i].hashStatus === 'changed');
    s.status = ap ? (ap === s.hash && !s.changedBlocks.length ? 'ok' : 'changed') : 'new';
  }
  for (const [id, b] of Object.entries(model.blocks)) if (b.hashStatus === 'changed') log(`  блок изменён: ${id} (${b.scope}) -> затронет сценарии: ${b.scenarios.join(', ')}`);
  for (const s of model.scenarios) log(`  сценарий ${s.id}: хеш ${s.hash}, ${s.status}${s.changedBlocks.length ? ', изменены блоки: ' + s.changedBlocks.join(', ') : ''}`);
}

export function compareSchemas(ctx) {
  astFlows(ctx);
  intent(ctx);
  hashes(ctx);
}
