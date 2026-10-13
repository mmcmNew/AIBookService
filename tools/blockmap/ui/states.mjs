// Каталог состояний: сторы Zustand -> поля и действия -> кто пишет, кто читает, где в сторе лежит логика.
// Всё определяется по коду (TypeScript checker), вручную нужны только куски (slices) и владельцы в model.json.
import ts from 'typescript';

export function scanStates(files, cg, layerOf) {
  const { program, checker, rel } = cg;
  const fileSet = new Set(files);
  const fnsList = [...cg.fns.values()];
  const fnAt = (file, line) => fnsList.filter((f) => f.file === file && f.line <= line && line <= f.endLine).sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0] || null;

  // 1. сторы: use*Store = create<State>(...): поля и действия из типа State
  const stores = [], declToField = new Map();
  for (const sf of program.getSourceFiles()) {
    const file = rel(sf.fileName);
    if (!fileSet.has(file)) continue;
    const visit = (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^use\w+Store$/.test(n.name.text) && n.initializer && ts.isCallExpression(n.initializer)) {
        let c = n.initializer;
        while (ts.isCallExpression(c) && ts.isCallExpression(c.expression)) c = c.expression; // create<S>()(persist(...))
        const typeArg = c.typeArguments?.[0];
        if (typeArg) {
          const store = { name: n.name.text, file, fields: [], actions: [] };
          for (const sym of checker.getTypeFromTypeNode(typeArg).getProperties()) {
            const d = sym.declarations?.[0]; if (!d) continue;
            const isFn = ts.isMethodSignature(d) || (ts.isPropertySignature(d) && d.type && ts.isFunctionTypeNode(d.type));
            const rec = { name: sym.name, kind: isFn ? 'action' : 'field', store: store.name, writers: [], readers: [], sets: [] };
            (isFn ? store.actions : store.fields).push(rec); declToField.set(d, rec);
          }
          stores.push(store);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const storeByName = new Map(stores.map((s) => [s.name, s]));
  const fieldOf = (s, name) => s.fields.find((f) => f.name === name);

  // 2. чтения полей: любое обращение к свойству, объявленному в типе состояния (s.field, getState().field, { field } = ...)
  const symDecls = (node) => { try { const s = checker.getSymbolAtLocation(node); return s?.declarations || []; } catch { return []; } };
  for (const sf of program.getSourceFiles()) {
    const file = rel(sf.fileName);
    if (!fileSet.has(file)) continue;
    const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const note = (nameNode, node) => {
      for (const d of symDecls(nameNode)) { const rec = declToField.get(d); if (rec && rec.kind === 'field') { const fn = fnAt(file, lineOf(node)); rec.readers.push({ file, line: lineOf(node), fn: fn?.id || null }); break; } }
    };
    const visit = (n) => {
      if (ts.isPropertyAccessExpression(n)) note(n.name, n);
      else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) note(n.propertyName && ts.isIdentifier(n.propertyName) ? n.propertyName : n.name, n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // 3. записи: set({...}) / set((s) => ({...})) внутри действий стора и внешние useXStore.setState({...})
  const keysOf = (arg) => {
    if (!arg) return [];
    let obj = null;
    if (ts.isObjectLiteralExpression(arg)) obj = arg;
    else if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      const b = arg.body;
      if (ts.isParenthesizedExpression(b) && ts.isObjectLiteralExpression(b.expression)) obj = b.expression;
      else if (ts.isObjectLiteralExpression(b)) obj = b;
      else if (ts.isBlock(b)) { const ret = b.statements.find((s) => ts.isReturnStatement(s) && s.expression); const e = ret?.expression; obj = e && (ts.isParenthesizedExpression(e) ? e.expression : e); if (obj && !ts.isObjectLiteralExpression(obj)) obj = null; }
    }
    return obj ? obj.properties.filter((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name).map((p) => p.name.getText()) : [];
  };
  for (const store of stores) {
    const sf = program.getSourceFile(`${program.getCurrentDirectory()}/${store.file}`) || program.getSourceFiles().find((x) => rel(x.fileName) === store.file);
    const visit = (n) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression, nm = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        if (nm === 'set') {
          const keys = keysOf(n.arguments[0]), line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, fn = fnAt(store.file, line);
          for (const k of keys) { const f = fieldOf(store, k); if (f) f.writers.push({ fn: fn?.id || null, file: store.file, line, action: fn?.simple || null, direct: false }); }
          const act = fn && store.actions.find((a) => a.name === fn.simple); if (act) act.sets.push(...keys);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  for (const sf of program.getSourceFiles()) { // внешний useXStore.setState({...})
    const file = rel(sf.fileName);
    if (!fileSet.has(file)) continue;
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'setState') {
        const base = n.expression.expression, sname = ts.isIdentifier(base) ? base.text : ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) && ts.isIdentifier(base.expression.expression) ? base.expression.expression.text : '';
        const store = storeByName.get(sname);
        if (store) { const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, fn = fnAt(file, line); for (const k of keysOf(n.arguments[0])) { const f = fieldOf(store, k); if (f) f.writers.push({ fn: fn?.id || null, file, line, action: null, direct: true }); } }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // 4. инициаторы записи: кто вызывает действия, которые пишут поле
  const actionFnId = (store, name) => (fnsList.find((f) => f.file === store.file && f.simple === name) || {}).id;
  for (const store of stores) {
    for (const f of store.fields) {
      f.initiators = [];
      for (const w of f.writers) {
        if (w.direct) { f.initiators.push({ fn: w.fn, file: w.file, line: w.line, via: 'setState' }); continue; }
        const id = w.action && actionFnId(store, w.action);
        for (const c of (id ? cg.callers.get(id) || [] : [])) f.initiators.push({ fn: c.from, file: cg.fns.get(c.from).file, line: c.line, via: w.action });
      }
    }
    // 5. логика в сторе: действия, которые вызывают функции других слоёв
    for (const a of store.actions) {
      const id = actionFnId(store, a.name), rec = id && cg.fns.get(id);
      a.fnId = id || null;
      a.leaks = rec ? [...new Set(rec.calls.flatMap((c) => c.to.filter((t) => layerOf(cg.fns.get(t).file) !== 'State').map((t) => cg.fns.get(t).qual)))] : [];
      a.sets = [...new Set(a.sets)];
    }
  }
  return stores.map((s) => ({ name: s.name, file: s.file, fields: s.fields.map(({ store, kind, ...f }) => f), actions: s.actions.map(({ store, kind, writers, readers, ...a }) => a) }));
}
