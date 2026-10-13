// Подбор колонок блоков внутри зон так, чтобы стрелки пересекались меньше (поиск с перезапусками).
const LAYERS = ['UI', 'State', 'Domain', 'Data', 'Infra'];
const cross = (a, b, c, d) => { const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0; };
const perms = (arr) => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p])));

export function optimizeLayout(m, sc) {
  const layers = LAYERS;
  const zoneOf = (id) => m.blocks[id].zone || '_none';
    const ids = Object.keys(sc.cols), lane = Object.fromEntries(ids.map((i) => [i, layers.indexOf(m.blocks[i].layer)])), zones = [...new Set(ids.map(zoneOf))];
    const edges = sc.edges.filter((x) => x.kind !== 'return' && ids.includes(x.from) && ids.includes(x.to));
    const score = (col, zorder) => {
      const wz = {}; for (const i of ids) wz[zoneOf(i)] = Math.max(wz[zoneOf(i)] || 0, col[i] + 1);
      const off = {}; let acc = 0; for (const z of zorder) { off[z] = acc; acc += wz[z] * 330 + 70; }
      const P = (i) => [off[zoneOf(i)] + col[i] * 330, lane[i] * 220]; let s2 = 0;
      for (let a = 0; a < edges.length; a++) { const A = edges[a]; s2 += 0.002 * Math.hypot(P(A.from)[0] - P(A.to)[0], (P(A.from)[1] - P(A.to)[1]) * 0.6);
        for (let b = a + 1; b < edges.length; b++) { const B2 = edges[b]; if (A.from === B2.from || A.from === B2.to || A.to === B2.from || A.to === B2.to) continue; if (cross(P(A.from), P(A.to), P(B2.from), P(B2.to))) s2 += 1; } }
      return s2;
    };
    const base = { ...sc.cols }, order0 = (sc.zoneOrder || zones).filter((z) => zones.includes(z)).concat(zones.filter((z) => !(sc.zoneOrder || []).includes(z)));
    let bestOrder = order0, bs0 = score(base, order0);
    for (const po of perms(zones)) { const sco = score(base, po); if (sco < bs0) { bs0 = sco; bestOrder = po; } }
    const rnd = (n) => Math.floor(Math.random() * n), width = Math.max(...ids.map((i) => sc.cols[i])) + 2;
    let best = { ...base }, bs = score(best, bestOrder);
    for (let restart = 0; restart < 40; restart++) {
      const cur = restart ? Object.fromEntries(ids.map((i) => [i, rnd(width)])) : { ...best };
      const fix = () => { for (const z of zones) for (let l = 0; l < 5; l++) { const used = new Set(); for (const i of ids.filter((q) => zoneOf(q) === z && lane[q] === l)) { while (used.has(cur[i])) cur[i] = (cur[i] + 1) % (width + 2); used.add(cur[i]); } } };
      fix(); let cs = score(cur, bestOrder);
      for (let it = 0; it < 1500; it++) {
        const i = ids[rnd(ids.length)], old = cur[i], nv = Math.max(0, Math.min(width, old + (rnd(3) - 1) * (1 + rnd(2))));
        if (nv === old || ids.some((q) => q !== i && zoneOf(q) === zoneOf(i) && lane[q] === lane[i] && cur[q] === nv)) continue;
        cur[i] = nv; const ns = score(cur, bestOrder); if (ns <= cs) cs = ns; else cur[i] = old;
      }
      if (cs < bs) { bs = cs; best = { ...cur }; }
    }
    for (const z of zones) { const mn = Math.min(...ids.filter((i) => zoneOf(i) === z).map((i) => best[i])); for (const i of ids.filter((q) => zoneOf(q) === z)) best[i] -= mn; }
  return { base, order0, best, bestOrder, before: score(base, order0), after: bs };
}
