// Команда layout: подобрать колонки блоков, чтобы стрелки пересекались меньше.
import { flag, pos, load } from './context.mjs';
import { applyLayout } from '../lib/editor.mjs';
import { optimizeLayout } from '../lib/layout.mjs';

export const cmds = {
  layout() {
    const { model: m } = load(), want = pos[0], apply = flag('--apply'), results = [];
    for (const sc of m.scenarios.filter((s2) => !want || s2.id === want)) {
      const r = optimizeLayout(m, sc);
      console.log(sc.id + ': пересечений было ' + Math.round(r.before) + ' → стало ' + Math.round(r.after) + ' (оценка по прямым линиям), порядок зон: ' + r.bestOrder.map((z) => m.zones?.[z]?.title || z).join(' | '));
      if (apply) results.push({ id: sc.id, cols: r.best, zoneOrder: r.bestOrder }); else console.log('  колонки (внутри зон): ' + JSON.stringify(r.best));
    }
    if (apply) { applyLayout(results); console.log('✓ колонки и порядок зон записаны в model.json (раскладку, сдвинутую мышью, можно сбросить кнопкой)'); }
  },
};
