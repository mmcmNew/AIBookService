// Редактор карты: единственный, кто меняет ручную модель (model.json).
// Принятия расхождений, заявление ресурсов, раскладка, версия схемы, утверждение хешей (bind).
import { readRaw, writeRaw } from './store/model.mjs';
import { swallowsOf } from '../ui/facts.mjs';
import { buildMap } from '../ui/build.mjs';

const today = () => new Date().toISOString().slice(0, 10);

// Принять проглоченную ошибку осознанно: подтверждение привязано к хешу кода
export function acceptRisk(file, line, reason) {
  const found = swallowsOf(file).map((r) => ({ r, d: Math.abs(r.line - line) })).filter((x) => x.d <= 2).sort((a, b) => a.d - b.d)[0];
  if (!found) return null;
  const raw = readRaw();
  (raw.riskAcks ||= {})[found.r.fp] = { reason, at: today(), where: `${found.r.file}:${found.r.line}`, kind: found.r.kind };
  writeRaw(raw);
  return found.r;
}

// Принять реальную связь из кода, которой нет на схеме
export function acceptReality(from, to, reason) {
  const raw = readRaw();
  (raw.realityAcks ||= {})[from + '>' + to] = reason;
  writeRaw(raw);
}

// Принять неподтверждённую стрелку как известное расхождение; вернуть число затронутых стрелок
export function acceptEdge(from, to, reason) {
  const raw = readRaw();
  let n = 0;
  for (const s of raw.scenarios) for (const e of s.edges) if (e.from === from && e.to === to) { e.known = reason; n++; }
  if (n) writeRaw(raw);
  return n;
}

// Заявить блокам ресурсы: plan = { idБлока: Set(idРесурсов) }
export function applyDeclarations(plan) {
  const raw = readRaw();
  for (const [b, s] of Object.entries(plan)) raw.blocks[b].res = [...new Set([...(raw.blocks[b].res || []), ...s])];
  writeRaw(raw);
}

// Записать подобранную раскладку: [{ id сценария, cols, zoneOrder }]
export function applyLayout(results) {
  const raw = readRaw();
  for (const r of results) { const sc = raw.scenarios.find((s) => s.id === r.id); sc.cols = r.cols; sc.zoneOrder = r.zoneOrder; }
  writeRaw(raw);
}

// Записать выпущенную версию схемы
export function setVersion(version) {
  const raw = readRaw();
  raw.version = version;
  writeRaw(raw);
}

// Утвердить текущее состояние блоков и сценариев (ids) или всё сразу (true): шаги привязываются по хешу
export function approve(ids, { refreshGraph = false } = {}) {
  const { raw, log } = buildMap({ bind: ids, refreshGraph });
  writeRaw(raw);
  return log;
}
