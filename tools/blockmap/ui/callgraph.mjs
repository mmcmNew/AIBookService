// Граф вызовов проекта (TypeScript compiler API): функция -> функции, которые она вызывает.
// Нужен, чтобы проверять стрелки сценария против кода: есть ли реальный вызов.
import ts from 'typescript';
import path from 'node:path';
import { profile } from './profile.mjs';

const FN_INIT = (n) => n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
// memo(() => ...), forwardRef(...), useCallback(() => ..., [])
const unwrap = (n) => (n && ts.isCallExpression(n) && /(^|.)(memo|forwardRef|useCallback)$/.test(n.expression.getText()) && FN_INIT(n.arguments[0]) ? n.arguments[0] : null);

export function buildCallGraph(ROOT, files) {
  const options = {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true, noEmit: true, resolveJsonModule: true, baseUrl: ROOT, paths: profile.paths, allowJs: profile.allowJs,
  };
  const program = ts.createProgram(files.map((f) => path.join(ROOT, f)), options);
  const checker = program.getTypeChecker();
  const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
  const fileSet = new Set(files);
  const fns = new Map(), byFileName = new Map(), nodeToId = new Map();
  const simpleOf = (q) => q.split('.').pop();
  const fnsAll = () => [...fns.values()];

  // 1. функции
  for (const sf of program.getSourceFiles()) {
    const file = rel(sf.fileName);
    if (!fileSet.has(file)) continue;
    const visit = (n, cls) => {
      let qual = null, fnNode = null, cname = cls, priv = false;
      if (ts.isClassDeclaration(n) && n.name) cname = n.name.text;
      if (ts.isFunctionDeclaration(n) && n.name && n.body) { qual = n.name.text; fnNode = n; }
      else if (ts.isMethodDeclaration(n) && n.body && n.name) { qual = (cls ? cls + '.' : '') + n.name.getText(sf); fnNode = n; }
      else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && (FN_INIT(n.initializer) || unwrap(n.initializer))) { qual = n.name.text; fnNode = FN_INIT(n.initializer) ? n.initializer : unwrap(n.initializer); }
      else if ((ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) && n.name && FN_INIT(n.initializer)) { qual = (ts.isPropertyDeclaration(n) && cls ? cls + '.' : '') + n.name.getText(sf); fnNode = n.initializer; }
      if (fnNode) {
        priv = (ts.canHaveModifiers(n) ? (ts.getModifiers(n) || []) : []).some((m) => m.kind === ts.SyntaxKind.PrivateKeyword) || (n.name && ts.isPrivateIdentifier(n.name));
        let id = `${file}#${qual}`; if (fns.has(id)) id += '@' + (sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
        const rec = { id, file, qual, simple: simpleOf(qual), priv, line: sf.getLineAndCharacterOfPosition(fnNode.getStart(sf)).line + 1, endLine: sf.getLineAndCharacterOfPosition(fnNode.getEnd()).line + 1, calls: [], node: fnNode, sf };
        fns.set(id, rec); nodeToId.set(fnNode, id);
        const k = `${file}#${rec.simple}`; (byFileName.get(k) || byFileName.set(k, []).get(k)).push(id);
      }
      ts.forEachChild(n, (c) => visit(c, cname));
    };
    visit(sf, null);
  }

  const impls = new Map(); // имя интерфейса/класса -> классы, которые его реализуют или расширяют
  for (const sf of program.getSourceFiles()) {
    if (!fileSet.has(rel(sf.fileName))) continue;
    const v = (n) => {
      if (ts.isClassDeclaration(n) && n.name) for (const h of n.heritageClauses || []) for (const ty of h.types) { const k = ty.expression.getText(sf); (impls.get(k) || impls.set(k, []).get(k)).push(n.name.text); }
      ts.forEachChild(n, v);
    };
    v(sf);
  }
  // 2. вызовы внутри функций (анонимные колбэки считаются частью внешней функции)
  const resolve = (nameNode, callNode) => {
    let sym; try { sym = checker.getSymbolAtLocation(nameNode); if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym); } catch { return []; }
    const out = [];
    for (const d of sym?.declarations || []) {
      const dfile = rel(d.getSourceFile().fileName);
      if (!fileSet.has(dfile)) continue;
      const simple = d.name?.getText(d.getSourceFile()) ?? (ts.isVariableDeclaration(d) ? d.name.getText() : null);
      if (simple) out.push(...(byFileName.get(`${dfile}#${simple}`) || []));
      // метод интерфейса: берём реализации
      if ((ts.isMethodSignature(d) || ts.isPropertySignature(d)) && ts.isInterfaceDeclaration(d.parent)) {
        for (const cls of impls.get(d.parent.name.text) || []) out.push(...fnsAll().filter((f) => f.qual === cls + '.' + simple).map((f) => f.id));
      }
    }
    // запасной путь: объявление сигнатуры вызова (переменная-колбэк, свойство стора)
    if (!out.length && callNode) {
      try {
        const sd = checker.getResolvedSignature(callNode)?.declaration, holder = sd && ts.isFunctionTypeNode(sd) ? sd.parent : sd;
        const hf = holder && rel(holder.getSourceFile().fileName), hn = holder?.name?.getText(holder.getSourceFile());
        if (hf && hn && fileSet.has(hf)) {
          out.push(...(byFileName.get(`${hf}#${hn}`) || []));
          if (ts.isInterfaceDeclaration(holder.parent)) for (const cls of impls.get(holder.parent.name.text) || []) out.push(...fnsAll().filter((f) => f.qual === cls + '.' + hn).map((f) => f.id));
        }
      } catch { /* сигнатура не определилась */ }
    }
    return out;
  };
  for (const rec of fns.values()) {
    const sf = rec.sf, body = rec.node.body;
    if (!body) continue;
    const walk = (n) => {
      if (n !== rec.node && nodeToId.has(n)) return; // отдельная именованная функция
      let nameNode = null;
      if (ts.isCallExpression(n)) nameNode = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : ts.isIdentifier(n.expression) ? n.expression : null;
      else if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) nameNode = ts.isIdentifier(n.tagName) ? n.tagName : null;
      if (nameNode) {
        const to = [...new Set(resolve(nameNode, ts.isCallExpression(n) ? n : null))];
        if (to.length) rec.calls.push({ to, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, name: nameNode.text });
      }
      ts.forEachChild(n, walk);
    };
    walk(body); // тело-выражение `() => f(x)` само может быть вызовом
  }

  const callers = new Map();
  for (const rec of fns.values()) for (const c of rec.calls) for (const t of c.to) (callers.get(t) || callers.set(t, []).get(t)).push({ from: rec.id, line: c.line, name: c.name });
  for (const r of fns.values()) { delete r.node; delete r.sf; }
  return { fns, callers, program, checker, rel };
}
