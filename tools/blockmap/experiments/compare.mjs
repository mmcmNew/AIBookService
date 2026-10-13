// Прототип Block Map: граф импортов -> кандидаты в блоки -> интерфейс и хеши -> сверка с ручной картой.
// Зависит только от typescript (уже есть в проекте). Исследовательский прототип (только для читалки). Запуск: node tools/blockmap/experiments/compare.mjs
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd().replace(/\\/g, '/');
const OUT = path.join(ROOT, 'tools/blockmap/out');
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

// ---------- 1. файлы ----------
function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', 'dist', '__tests__', 'test'].includes(e.name)) walk(p, acc);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}
const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'server/src'))];
const fileSet = new Set(files.map(rel));

// ---------- 2. программа и граф ----------
const options = {
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true, noEmit: true, allowJs: false, resolveJsonModule: true,
  baseUrl: ROOT, paths: { '@/*': ['src/*'] },
};
const program = ts.createProgram(files, options);
const checker = program.getTypeChecker();
const edges = []; // {from,to,names[]}
for (const sf of program.getSourceFiles()) {
  const from = rel(sf.fileName);
  if (!fileSet.has(from)) continue;
  const visit = (node) => {
    let spec;
    const names = [];
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      spec = node.moduleSpecifier.text;
      const c = node.importClause;
      if (c?.name) names.push({ name: 'default', node: c.name });
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) {
        c.namedBindings.elements.forEach((el) => names.push({ name: (el.propertyName ?? el.name).text, node: el.name }));
      }
      if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push({ name: '*', node: c.namedBindings.name });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      spec = node.moduleSpecifier.text;
      names.push({ name: '*reexport', node: null });
    }
    if (spec) {
      const r = ts.resolveModuleName(spec, sf.fileName, options, ts.sys).resolvedModule;
      const to = r && rel(r.resolvedFileName);
      if (to && fileSet.has(to) && to !== from) {
        const typed = names.map((n) => {
          let sig = '';
          try {
            if (n.node) {
              let s = checker.getSymbolAtLocation(n.node);
              if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
              if (s) sig = checker.typeToString(checker.getTypeOfSymbolAtLocation(s, n.node), undefined, ts.TypeFormatFlags.NoTruncation);
            }
          } catch { /* тип недоступен — оставляем пустую сигнатуру */ }
          return { name: n.name, sig };
        });
        edges.push({ from, to, names: typed });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ---------- 3. разбиения ----------
const nodes = [...fileSet].sort();
const folderKey = (f) => {
  const p = f.split('/');
  if (p[0] === 'server') return 'server';
  return p.slice(0, p[1] === 'engine' || p[1] === 'components' ? 3 : 2).join('/');
};
const folderPart = Object.fromEntries(nodes.map((f) => [f, folderKey(f)]));

// label propagation, стартуем с папок, детерминированный порядок
const adj = {};
nodes.forEach((n) => (adj[n] = {}));
for (const e of edges) {
  adj[e.from][e.to] = (adj[e.from][e.to] || 0) + 1;
  adj[e.to][e.from] = (adj[e.to][e.from] || 0) + 1;
}
const label = { ...folderPart };
for (let it = 0; it < 20; it++) {
  let changed = 0;
  for (const n of nodes) {
    const score = {};
    for (const [m, w] of Object.entries(adj[n])) score[label[m]] = (score[label[m]] || 0) + w;
    score[label[n]] = (score[label[n]] || 0) + 1.5; // инерция: папка весомее случайной связи
    const best = Object.entries(score).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    if (best !== label[n]) { label[n] = best; changed++; }
  }
  if (!changed) break;
}
const lpaPart = label;

// ---------- 4. эталон из ручной карты ----------
const flowsDir = path.join(ROOT, 'docs/architecture/flows');
const l0 = JSON.parse(fs.readFileSync(path.join(flowsDir, 'level0_overview.json'), 'utf8'));
const votes = {};
const vote = (f, b, w) => {
  if (!fileSet.has(f)) return;
  (votes[f] ||= {})[b] = (votes[f][b] || 0) + w;
};
for (const b of l0.blocks) {
  b.mainFiles.forEach((f) => vote(f, b.id, 3));
  const fp = path.join(flowsDir, b.flowId + '.json');
  if (fs.existsSync(fp)) for (const n of JSON.parse(fs.readFileSync(fp, 'utf8')).nodes || []) if (n.file) vote(n.file, b.id, 1);
}
const truth = {};
for (const [f, v] of Object.entries(votes)) {
  const s = Object.entries(v).sort((a, b) => b[1] - a[1]);
  if (s.length === 1 || s[0][1] > s[1][1]) truth[f] = s[0][0];
}

function pairwise(part) { // F1 по парам размеченных вручную файлов
  const fl = Object.keys(truth);
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < fl.length; i++) {
    for (let j = i + 1; j < fl.length; j++) {
      const a = fl[i], b = fl[j];
      const sameT = truth[a] === truth[b], sameP = part[a] === part[b];
      if (sameT && sameP) tp++; else if (!sameT && sameP) fp++; else if (sameT && !sameP) fn++;
    }
  }
  const p = tp / (tp + fp || 1), r = tp / (tp + fn || 1);
  return { precision: +p.toFixed(2), recall: +r.toFixed(2), f1: +((2 * p * r) / (p + r || 1)).toFixed(2) };
}

// ---------- 5. блоки: интерфейс и хеши ----------
function buildBlocks(part) {
  const blocks = {};
  for (const f of nodes) (blocks[part[f]] ||= { id: part[f], files: [], iface: {}, deps: new Set(), usedBy: new Set() }).files.push(f);
  for (const e of edges) {
    const a = part[e.from], b = part[e.to];
    if (a === b) continue;
    blocks[a].deps.add(b);
    blocks[b].usedBy.add(a);
    for (const n of e.names) blocks[b].iface[`${e.to}#${n.name}`] = n.sig;
  }
  return Object.values(blocks).map((b) => ({
    id: b.id, fileCount: b.files.length, files: b.files,
    dependsOn: [...b.deps].sort(), usedBy: [...b.usedBy].sort(),
    publicInterface: Object.entries(b.iface).sort().map(([k, sig]) => ({ symbol: k, type: sig })),
    bodyHash: sha(b.files.map((f) => f + sha(fs.readFileSync(path.join(ROOT, f), 'utf8'))).join()),
    interfaceHash: sha(JSON.stringify(Object.entries(b.iface).sort())),
  })).sort((a, b) => b.fileCount - a.fileCount);
}
const blocks = buildBlocks(lpaPart);

// ---------- 6. скрытые каналы: сторы и IndexedDB ----------
const hidden = { zustandStores: [], dexieUsers: [] };
for (const f of nodes) {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (/from ['"]zustand/.test(t) && /\bcreate\b/.test(t)) hidden.zustandStores.push(f);
  if (/\bdb\.(books|pdfPages|pdfFiles|audioCache)\b/.test(t)) hidden.dexieUsers.push(f);
}
const storeUsers = {};
for (const s of hidden.zustandStores) storeUsers[s] = edges.filter((e) => e.to === s).map((e) => e.from);

// ---------- вывод ----------
fs.mkdirSync(OUT, { recursive: true });
const report = {
  generated: new Date().toISOString(), files: nodes.length, importEdges: edges.length,
  groundTruth: { files: Object.keys(truth).length, blocks: l0.blocks.length },
  agreement: { byFolder: pairwise(folderPart), labelPropagation: pairwise(lpaPart) },
  hiddenChannels: { zustandStores: hidden.zustandStores, filesTouchingDexie: hidden.dexieUsers },
};
fs.writeFileSync(path.join(OUT, 'graph.json'), JSON.stringify({ files: nodes, edges: edges.map((e) => [e.from, e.to]) }));
fs.writeFileSync(path.join(OUT, 'blocks.candidate.json'), JSON.stringify({ report, blocks }, null, 2));

// ---------- HTML-вьювер для сравнения ----------
const viewerData = {
  manual: { blocks: l0.blocks.map((b) => ({ id: b.id, title: b.title })), arrows: l0.arrows.map((a) => ({ from: a.from, to: a.to })) },
  files: nodes, truth,
  partitions: { folder: folderPart, lpa: lpaPart },
  scores: { folder: report.agreement.byFolder, lpa: report.agreement.labelPropagation },
  edges: edges.map((e) => [e.from, e.to]),
};
const tpl = fs.readFileSync(path.join(ROOT, 'tools/blockmap/experiments/viewer.template.html'), 'utf8');
fs.writeFileSync(path.join(OUT, 'compare.html'), tpl.replace('/*DATA*/null', () => JSON.stringify(viewerData)));

const mapping = l0.blocks.map((b) => {
  const cnt = {};
  Object.entries(truth).filter(([, v]) => v === b.id).forEach(([f]) => (cnt[lpaPart[f]] = (cnt[lpaPart[f]] || 0) + 1));
  const total = Object.values(cnt).reduce((a, c) => a + c, 0);
  return { manual: b.id, files: total, spread: Object.entries(cnt).sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ') };
});
console.log(`Файлов: ${report.files}, импортов между файлами: ${report.importEdges}, кандидатов в блоки: ${blocks.length}`);
console.log('Совпадение с ручной картой (pairwise F1 по', report.groundTruth.files, 'размеченным файлам):');
console.log('  по папкам:        ', report.agreement.byFolder);
console.log('  label propagation:', report.agreement.labelPropagation);
console.log('\nГде ручные блоки лежат в авто-кандидатах:');
mapping.forEach((m) => console.log(`  ${m.manual.padEnd(14)} (${m.files} ф.)  ${m.spread}`));
console.log('\nКандидаты (размер, зависит от, интерфейс):');
blocks.forEach((b) => console.log(`  ${b.id.padEnd(28)} ${String(b.fileCount).padStart(3)} ф.  deps:${b.dependsOn.length}  usedBy:${b.usedBy.length}  iface:${b.publicInterface.length}  ifaceHash:${b.interfaceHash}`));
console.log('\nСкрытые каналы (zustand-сторы) и кто их импортирует:');
for (const [s, u] of Object.entries(storeUsers)) console.log(`  ${s}  <- ${u.length} файлов из блоков: ${[...new Set(u.map((x) => lpaPart[x]))].join(', ')}`);
console.log('\nФайлов, которые трогают Dexie напрямую:', hidden.dexieUsers.length, '| блоков среди них:', new Set(hidden.dexieUsers.map((x) => lpaPart[x])).size);
