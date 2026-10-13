// Граф импортов проекта (TypeScript compiler API): файлы и рёбра «кто кого импортирует».
// Записать его в out/graph.json — дело хранилища (lib/store/output.mjs).
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, profile, abs } from './profile.mjs';

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!profile.skipDirs.includes(e.name)) walk(p, acc);
    } else if (profile.ext.test(e.name) && !/\.(test|spec)\.[mc]?[jt]sx?$/.test(e.name) && !e.name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

// Имена и типы, которые файл берёт из другого файла (для сигнатур на границах блоков)
function importedNames(node) {
  const names = [], c = node.importClause;
  if (c?.name) names.push({ name: 'default', node: c.name });
  if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) c.namedBindings.elements.forEach((el) => names.push({ name: (el.propertyName ?? el.name).text, node: el.name }));
  if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push({ name: '*', node: c.namedBindings.name });
  return names;
}

export function buildImportGraph() {
  const files = profile.roots.flatMap((r) => walk(abs(r)));
  const fileSet = new Set(files.map(rel));
  const options = {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true, noEmit: true, allowJs: profile.allowJs, resolveJsonModule: true,
    baseUrl: ROOT, paths: profile.paths,
  };
  const program = ts.createProgram(files, options);
  const checker = program.getTypeChecker();
  const edges = [];
  for (const sf of program.getSourceFiles()) {
    const from = rel(sf.fileName);
    if (!fileSet.has(from)) continue;
    const visit = (node) => {
      let spec, names = [];
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) { spec = node.moduleSpecifier.text; names = importedNames(node); }
      else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) { spec = node.moduleSpecifier.text; names.push({ name: '*reexport', node: null }); }
      if (spec) {
        const r = ts.resolveModuleName(spec, sf.fileName, options, ts.sys).resolvedModule, to = r && rel(r.resolvedFileName);
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
  const nodes = [...fileSet].sort();
  const graph = { files: nodes, edges: edges.map((e) => [e.from, e.to]) };
  return { graph, detailedEdges: edges };
}
