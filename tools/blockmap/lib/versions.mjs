// Версии схемы: структура для сравнения, разница между выпусками, рекомендуемое увеличение версии.
import { readRaw } from './store/model.mjs';
import { readSnapshot, writeSnapshot } from './store/snapshots.mjs';
import { setVersion } from './editor.mjs';

export const structureOf = (raw) => ({
  blocks: Object.fromEntries(Object.entries(raw.blocks).map(([id, b]) => [id, { layer: b.layer, planned: !!b.planned, title: b.title, zone: b.zone || null }])),
  states: Object.fromEntries(Object.entries(raw.states || {}).map(([id, s]) => [id, { owner: s.owner || null }])),
  resources: Object.fromEntries(Object.entries(raw.resources || {}).map(([id, r]) => [id, { owner: r.owner || null }])),
  scenarios: Object.fromEntries(raw.scenarios.map((sc) => [sc.id, { blocks: Object.keys(sc.cols).sort(), edges: sc.edges.map((e) => e.from + '>' + e.to).sort() }])),
});
export function diffStructure(a, b) {
  const lines = [], major = [], minor = [], name = (id) => b.blocks[id]?.title || a.blocks[id]?.title || id;
  for (const id of Object.keys(b.blocks)) if (!a.blocks[id]) { minor.push(1); lines.push('+ блок «' + name(id) + '»' + (b.blocks[id].planned ? ' (план)' : '')); }
  for (const id of Object.keys(a.blocks)) if (!b.blocks[id]) { major.push(1); lines.push('− блок «' + name(id) + '» удалён'); }
  for (const id of Object.keys(b.blocks)) if (a.blocks[id]) {
    if (a.blocks[id].layer !== b.blocks[id].layer) { major.push(1); lines.push('~ блок «' + name(id) + '»: слой ' + a.blocks[id].layer + ' → ' + b.blocks[id].layer); }
    if ((a.blocks[id].zone || null) !== (b.blocks[id].zone || null)) { major.push(1); lines.push('~ блок «' + name(id) + '»: зона ' + (a.blocks[id].zone || '—') + ' → ' + (b.blocks[id].zone || '—')); }
    if (a.blocks[id].planned && !b.blocks[id].planned) { minor.push(1); lines.push('~ блок «' + name(id) + '»: из плана в код'); }
  }
  for (const [kind, label] of [['states', 'состояние'], ['resources', 'ресурс']]) {
    for (const id of Object.keys(b[kind])) { if (!a[kind][id]) { minor.push(1); lines.push('+ ' + label + ' ' + id); } else if (a[kind][id].owner !== b[kind][id].owner) { major.push(1); lines.push('~ ' + label + ' ' + id + ': владелец ' + (a[kind][id].owner ? name(a[kind][id].owner) : '—') + ' → ' + (b[kind][id].owner ? name(b[kind][id].owner) : '—')); } }
    for (const id of Object.keys(a[kind])) if (!b[kind][id]) { major.push(1); lines.push('− ' + label + ' ' + id + ' удалён(о)'); }
  }
  for (const id of Object.keys(b.scenarios)) {
    if (!a.scenarios[id]) { minor.push(1); lines.push('+ сценарий ' + id); continue; }
    for (const e of b.scenarios[id].edges) if (!a.scenarios[id].edges.includes(e)) { minor.push(1); lines.push('+ стрелка ' + id + ': ' + e.split('>').map(name).join(' → ')); }
    for (const e of a.scenarios[id].edges) if (!b.scenarios[id].edges.includes(e)) { minor.push(1); lines.push('− стрелка ' + id + ': ' + e.split('>').map(name).join(' → ')); }
  }
  for (const id of Object.keys(a.scenarios)) if (!b.scenarios[id]) { major.push(1); lines.push('− сценарий ' + id + ' удалён'); }
  return { lines, major: major.length, minor: minor.length, empty: !lines.length };
}
export const suggestBump = (d) => (d.major ? 'major' : d.minor ? 'minor' : 'patch');
export const bumpVersion = (ver, kind) => { const [a, b, c] = ver.split('.').map(Number); return kind === 'major' ? (a + 1) + '.0.0' : kind === 'minor' ? a + '.' + (b + 1) + '.0' : a + '.' + b + '.' + (c + 1); };

const diffWithRelease = (raw, v) => {
  const prev = v ? readSnapshot(v.current) : null;
  return prev ? diffStructure(prev.structure, structureOf(raw)) : null;
};

// Текущая версия, что изменилось с прошлого выпуска и какое увеличение нужно
export function versionReport() {
  const raw = readRaw(), v = raw.version || null, d = diffWithRelease(raw, v);
  return { version: v, diff: d, suggestedBump: d ? suggestBump(d) : null };
}

// Выпустить версию схемы: снимок структуры + запись в историю. bump и milestone можно не указывать.
export function releaseVersion({ note, bump, milestone }) {
  const raw = readRaw(), v = raw.version, cur = structureOf(raw), d = diffWithRelease(raw, v);
  const kind = bump || (d ? (d.empty ? 'patch' : suggestBump(d)) : 'baseline');
  const next = !v ? '0.1.0' : bumpVersion(v.current, kind), ms = milestone || v?.milestone || 'веха не названа';
  const entry = { version: next, date: new Date().toISOString().slice(0, 10), bump: kind, milestone: ms, note, changes: d ? d.lines.slice(0, 14) : ['первая версия схемы'] };
  writeSnapshot(next, { version: next, date: entry.date, milestone: ms, structure: cur });
  setVersion({ current: next, milestone: ms, changelog: [...(v?.changelog || []), entry] });
  return { next, bump: kind, lines: d?.lines || [] };
}
