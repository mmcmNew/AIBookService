// Этап 1–2: якоря блоков/ресурсов/шагов указывают на живой код; блок → сценарии, где он участвует.
export function anchors(ctx) {
  const { model, warnings, read, exists } = ctx;
  // 1. проверка якорей
  const checkAnchor = (what, f, line, sym) => {
    if (!f) return;
    if (!exists(f)) return warnings.push(`${what}: нет файла ${f}`);
    const lines = read(f).split('\n');
    if (line > lines.length) warnings.push(`${what}: строка ${line} > ${lines.length} в ${f}`);
    else if (sym && !lines.slice(Math.max(0, line - 8), line + 8).join('\n').includes(sym.split(/[ .(]/)[0])) warnings.push(`${what}: символ ${sym} не рядом со строкой ${line} в ${f}`);
  };
  for (const [id, b] of Object.entries(model.blocks)) if (!b.planned) checkAnchor('блок ' + id, b.file, b.line, b.symbol);
  for (const [id, r] of Object.entries(model.resources)) checkAnchor('ресурс ' + id, r.file, r.line);
  for (const [id, fl] of Object.entries(model.flows)) for (const n of fl.nodes) checkAnchor(`схема ${id}/${n.id}`, n.file, n.line);

  // 2. блок -> сценарии
  for (const b of Object.values(model.blocks)) b.scenarios = [];
  for (const s of model.scenarios) for (const id of Object.keys(s.cols)) model.blocks[id]?.scenarios.push(s.id);
  for (const [id, b] of Object.entries(model.blocks)) if (!b.scenarios.length) warnings.push(`блок ${id} не входит ни в один сценарий`);
}
