// Проверки карты. Единственный вход в зону: сборщик просит runChecks, команды просят сводку расхождений,
// эталон «до», зоны и риски. Хранилище эталона — lib/store/baseline.mjs.
import { lintPlan } from '../ui/lint.mjs';
import { layerOf, blocksByFile } from '../ui/shared.mjs';
import { callGraph, swallowsOf } from '../ui/facts.mjs';
import { checkCodeAgainstPlan } from '../ui/stages/codeChecks.mjs';
import { readBaseline, writeBaseline } from './store/baseline.mjs';

// Проверки после сборки схем: код против плана, затем правила самого плана
export function runChecks(ctx) {
  const { model, graph, log } = ctx;
  ctx.cg = callGraph(graph.files);
  checkCodeAgainstPlan(ctx);
  model.lint = lintPlan(model);
  log(`  проверка плана: ошибок ${model.lint.errors}, предупреждений ${model.lint.warnings}`);
}

export function collectIssues(m) {
  const fail = [], warn = [];
  (m.warnings || []).forEach((w) => fail.push('якорь/AST: ' + w));
  for (const [id, b] of Object.entries(m.blocks)) {
    if (b.hashStatus === 'changed') fail.push(`блок ${id} изменён после утверждения (затронет: ${b.scenarios.join(', ')})`);
    if (b.hashStatus === 'new') warn.push(`блок ${id} не утверждён`);
    if (b.diff) {
      if (b.diff.stale.length) fail.push(`блок ${id}: код ${b.diff.stale.length} шаг(ов) схемы изменился`);
      if (b.diff.uncovered.length) warn.push(`блок ${id}: код без шага схемы: ${b.diff.uncovered.length}`);
      if (b.diff.orphans.length) warn.push(`блок ${id}: шагов схемы без кода: ${b.diff.orphans.length}`);
    }
  }
  for (const s of m.scenarios) { if (s.status === 'changed') fail.push(`сценарий ${s.id} изменён после утверждения (блоки: ${s.changedBlocks.join(', ') || 'структура'})`); if (s.status === 'new') warn.push(`сценарий ${s.id} не утверждён`); }
  // стрелки сценариев против кода, достижимость, мёртвые блоки
  for (const i of (m.lint?.issues || [])) (i.sev === 'err' ? fail : warn).push('План [' + i.scenario + ']: ' + i.text);
  const V = m.verify;
  for (const [pid, pb] of Object.entries(m.blocks)) if (pb.planned) warn.push('Запланированный блок ' + pid + ': кода ещё нет, ' + (V?.edges || []).filter((e) => e.status === 'planned' && (e.from === pid || e.to === pid)).length + ' стрелок ждут реализации');
  if (V) {
    for (const e of V.edges) {
      const nm = `Сценарий ${e.scenario}: ребро ${e.from} -> ${e.to}`;
      if (e.status === 'missing' && !e.known) fail.push(`${nm} не подтверждено в коде (вызов отсутствует)`);
      if (e.status === 'bypass' && !e.known) warn.push(`${nm} идёт в обход${e.bypassLayers?.length ? ' слоя ' + e.bypassLayers.join(', ') : ''}${e.bypassBlocks?.length ? ' через блок ' + e.bypassBlocks.join(', ') : ''}: ${e.path.map((x) => x.split('#')[1]).join(' > ')}`);
      if (e.embedded && !e.embedded.ok) warn.push(`${nm}: вызов есть в коде, но не встроен в блок-схему блока ${e.from} (${e.embedded.reason})`);
    }
    const real = (V.actual || []).filter((r) => !['yes', 'accepted'].includes(r.declared));
    for (const r of real.filter((x) => (x.missingRw || []).includes('write') || x.type === 'call')) warn.push('Реальная связь не на схеме: ' + r.from + ' → ' + r.to + ' (' + (r.missingRw.includes('write') ? 'пишет' : 'вызывает') + ': ' + r.calls.slice(0, 3).join(', ') + ')');
    for (const mp of m.misplaced || []) warn.push('Код блока ' + mp.block + ' лежит в слое ' + mp.actual + ' (' + mp.file + '), а по замыслу это ' + mp.design + ': нужно перенести');
    for (const d of V.dead) warn.push(`Мёртвый блок на карте: ${d.block} (сценарий ${d.scenario}, не достижим от точки входа по подтверждённым связям)`);
    for (const zv of m.zoneViolations || []) warn.push('В коде: ' + zv.from + ' (зона ' + zv.zFrom + ') → ' + zv.to + ' (зона ' + zv.zTo + ') не через главу зоны ' + zv.head + ' (' + zv.rw.join('/') + ': ' + zv.calls.slice(0, 3).join(', ') + ')');
    for (const rv of m.resourceViolations || []) warn.push('Ресурс ' + rv.resource + ': обращается не ответственный ' + rv.who + ' (' + (rv.rw || []).join('/') + ', ' + rv.file + ':' + rv.line + '), ответственный ' + rv.owner);
    for (const s of (m.stateCatalog?.slices || [])) for (const v of s.violations) warn.push('Состояние ' + s.id + ': запись не из владельца ' + s.owner + ': ' + v.who + ' (' + v.via.slice(0, 3).join(', ') + ')');
    for (const d of V.implDead || []) warn.push(`Шаг «${d.step}» блока ${d.block} реализован в ${d.impl.split('#')[1]}, но эту функцию никто не вызывает`);
    for (const d of V.deadInCode) warn.push(`Мёртвый блок в коде: ${d.block}: никто не вызывает ${d.api.map((x) => x.split('#')[1]).join(', ')}`);
  }
  for (const d of m.deadFunctions || []) warn.push('Мёртвая функция: ' + d.name + ' (' + d.file + ':' + d.line + ') нигде не вызывается (кроме, возможно, тестов)');
  (m.hints || []).forEach((h) => warn.push('подсказка: ' + h));
  const openRisks = (m.risks || []).filter((r) => !r.ack);
  if (openRisks.length) warn.push(`непринятых рисков в схемах: ${openRisks.length} (blockmap risks)`);
  return { fail, warn };
}

// Эталон «до»: запомнить текущие ✗ и предупреждения / сравнить с ним
export function saveBaseline({ fail, warn }) {
  writeBaseline({ at: new Date().toISOString(), fail, warn });
}
export function compareWithBaseline({ fail, warn }) {
  const base = readBaseline();
  if (!base) return null;
  return {
    base, newFail: fail.filter((x) => !base.fail.includes(x)), newWarn: warn.filter((x) => !base.warn.includes(x)),
    closedFail: base.fail.filter((x) => !fail.includes(x)), closedWarn: base.warn.filter((x) => !warn.includes(x)),
  };
}

// Проглоченные ошибки по всему проекту (catch и .catch без throw и лога)
export function scanRisks(model, graph) {
  const byFile = blocksByFile(model), acks = model.riskAcks || {};
  let all = [];
  for (const f of graph.files) { try { all = all.concat(swallowsOf(f)); } catch { /* файл не разобрался */ } }
  all.forEach((r) => { r.ack = acks[r.fp]?.reason || null; r.blocks = byFile[r.file] || []; });
  return all;
}

// Где блоки лезут в чужие зоны: ресурсы без заявки, запрещённые прыжки слоёв, узлы кода с чужим ресурсом
export function scanZones(m, graph) {
  const byFile = blocksByFile(m), res = [];
  // 1. ресурс используется там, где блок его не заявлял
  for (const [rid, r] of Object.entries(m.resources)) {
    const declared = Object.entries(m.blocks).filter(([, b]) => (b.res || []).includes(rid)).map(([id]) => id);
    for (const c of r.consumers) {
      const owners = byFile[c.file] || [];
      if (owners.some((o) => declared.includes(o))) continue;
      const violation = r.kind === 'db' && c.rw.includes('write') && !['Domain', 'Data'].includes(c.layer); // запись в таблицу из UI/State
      res.push({ kind: 'undeclared-resource', resource: rid, file: c.file, layer: c.layer, rw: c.rw.join('/') || 'использует', blocks: owners, declaredBy: declared, advice: violation ? 'violation' : 'declare' });
    }
  }
  // 2. запрещённые прыжки между слоями по импортам
  const bad = new Set(['UI>Data', 'UI>Infra', 'Domain>UI', 'State>UI', 'Data>UI', 'Data>State', 'Data>Domain', 'Infra>UI', 'Infra>State']);
  const maybe = new Set(['State>Domain']); // спорное: матрица слоёв ещё не решена
  const jumps = [];
  for (const [from, to] of graph.edges) {
    const k = `${layerOf(from)}>${layerOf(to)}`;
    if (bad.has(k) || maybe.has(k)) jumps.push({ kind: bad.has(k) ? 'layer-jump' : 'layer-disputed', rule: k, from, to, blocksFrom: byFile[from] || [], blocksTo: byFile[to] || [] });
  }
  // 3. узлы AST, трогающие ресурс, не заявленный в блоке
  for (const [id, b] of Object.entries(m.blocks)) {
    const fl = b.astFlow && m.flows[b.astFlow]; if (!fl) continue;
    for (const n of fl.nodes) if (n.res && !(b.res || []).includes(n.res)) res.push({ kind: 'undeclared-in-code', block: id, resource: n.res, line: n.line, rw: n.rw || 'использует' });
  }
  return { findings: res, jumps };
}


// Какие ресурсы можно заявить блокам автоматически: файл принадлежит ровно одному блоку
export function planDeclarations(m, graph) {
  const un = scanZones(m, graph).findings.filter((f) => f.kind === 'undeclared-resource');
  const one = un.filter((f) => f.advice === 'declare' && f.blocks.length === 1);
  const ambiguous = un.filter((f) => f.advice === 'declare' && f.blocks.length > 1), violations = un.filter((f) => f.advice === 'violation');
  const plan = {};
  one.forEach((f) => ((plan[f.blocks[0]] ||= new Set()).add(f.resource)));
  return { plan, one, ambiguous, violations };
}
