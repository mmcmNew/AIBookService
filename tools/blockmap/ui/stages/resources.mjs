// Этап 3–4: потребители ресурсов в коде, «где используется» у функций, владелец блок-схемы.
import { layerOf, DB_WRITE } from '../shared.mjs';
export function resources(ctx) {
  const { ROOT, model, graph, read } = ctx;
  // 3. потребители ресурсов
  const blocksByFile = {};
  for (const [id, b] of Object.entries(model.blocks)) if (!b.planned) (blocksByFile[b.file] ||= []).push(b.title);
  for (const [id, r] of Object.entries(model.resources)) {
    const cons = {};
    if (r.kind === 'store') {
      graph.edges.filter(([, to]) => to === r.file).forEach(([from]) => (cons[from] = { file: from, rw: [], lines: [] }));
    } else if (r.pattern) {
      const re = new RegExp(r.pattern);
      for (const f of graph.files) {
        const L = read(f).split('\n');
        L.forEach((line, i) => {
          if (!re.test(line)) return;
          const win = L.slice(i, i + 4).join(' ');
          const rw = (r.writePattern ? new RegExp(r.writePattern) : DB_WRITE).test(win) ? 'write' : 'read';
          const c = (cons[f] ||= { file: f, rw: [], lines: [] });
          if (!c.rw.includes(rw)) c.rw.push(rw);
          c.lines.push(i + 1);
        });
      }
    }
    r.consumers = Object.values(cons).map((c) => ({ ...c, layer: layerOf(c.file), blocks: blocksByFile[c.file] || [] })).sort((a, b) => a.file.localeCompare(b.file));
  }

  // 4. функции -> где используются (в блоках и в узлах блок-схем)
  for (const f of Object.values(model.functions)) f.usedIn = [];
  for (const b of Object.values(model.blocks)) for (const f of b.fns || []) model.functions[f].usedIn.push(`блок «${b.title}»`);
  for (const b of Object.values(model.blocks)) if (b.flow) for (const n of model.flows[b.flow].nodes) if (n.fn) model.functions[n.fn].usedIn.push(`блок-схема «${b.title}», шаг «${n.label}»`);
  // блок-схема -> блок-владелец
  for (const [id, b] of Object.entries(model.blocks)) if (b.flow) { model.flows[b.flow].owner = id; model.flows[b.flow].kind = 'manual'; }
}
