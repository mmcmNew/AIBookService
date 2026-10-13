// Собирает карту: ручная модель (model.json) + факты из кода → вычисленная модель и out/map.html.
// Только порядок шагов; работа — в ui/stages/*.mjs и lib/checks.mjs. Файлов модели не пишет, кроме результатов сборки.
import { ROOT } from './profile.mjs';
import { NL } from './shared.mjs';
import { importGraph, readSource, sourceExists } from './facts.mjs';
import { readRaw } from '../lib/store/model.mjs';
import { hasGraph, readGraph, writeGraph, writeOutJson, writeBuildOutput } from '../lib/store/output.mjs';
import { runChecks } from '../lib/checks.mjs';
import { anchors } from './stages/anchors.mjs';
import { resources } from './stages/resources.mjs';
import { compareSchemas } from './stages/schemas.mjs';

// bind: утвердить текущее состояние — true (всё) или список id блоков и сценариев; тогда в ответе raw — что записать в model.json
export function buildMap({ bind = null, refreshGraph = false } = {}) {
  const lines = [], log = (s) => lines.push(s);
  const model = readRaw();
  const raw = readRaw();
  if (refreshGraph || !hasGraph()) writeGraph(importGraph());
  const graph = readGraph();
  const BIND_ALL = bind === true, BIND_IDS = new Set(Array.isArray(bind) ? bind : []);
  const bindOn = (id) => BIND_ALL || BIND_IDS.has(id);

  const ctx = {
    ROOT, model, raw, graph, bindOn, log, warnings: [], hints: [], cg: null,
    read: readSource, exists: sourceExists, writeOut: writeOutJson,
  };

  anchors(ctx);
  resources(ctx);
  compareSchemas(ctx);
  runChecks(ctx);

  model.hints = ctx.hints;
  model.risks = Object.entries(model.blocks).flatMap(([id, b]) => (b.astFlow ? model.flows[b.astFlow].nodes : []).filter((n) => n.warn)
    .map((n) => ({ block: id, node: n.id, key: n.riskFp, file: n.file, line: n.line, level: n.warnLevel || 'silent', warn: n.warn, label: n.label, ack: n.ack || null })));
  model.warnings = ctx.warnings;
  writeBuildOutput(model);
  log(`map.html: сценариев ${model.scenarios.length}, блоков ${Object.keys(model.blocks).length}, блок-схем ${Object.keys(model.flows).length}`);
  for (const [id, r] of Object.entries(model.resources)) log(`  ${id}: потребителей ${r.consumers.length}`);
  log(ctx.warnings.length ? 'Предупреждения:' + NL + '  ' + ctx.warnings.join(NL + '  ') : 'Якоря в порядке');
  if (BIND_ALL || BIND_IDS.size) log('--bind: шаги привязаны по хешу, состояние утверждено, model.json обновлён');
  return { model: JSON.parse(JSON.stringify(model)), log: lines.join(NL) + NL, graph, raw: BIND_ALL || BIND_IDS.size ? raw : null };
}
