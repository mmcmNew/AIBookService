// Мёртвые экспортируемые функции: объявлены с export, а нигде в коде проекта (кроме тестов) не упоминаются.
// Типичный случай: функцию заменили другой, а старую оставили.
import ts from 'typescript';

export function findDeadExports(files, cg) {
  const { program, rel } = cg, fileSet = new Set(files);
  const exported = [], uses = new Map(); // имя -> сколько раз встречается идентификатор вне собственного объявления
  for (const sf of program.getSourceFiles()) {
    const file = rel(sf.fileName);
    if (!fileSet.has(file)) continue;
    const hasExport = (n) => (ts.canHaveModifiers(n) ? ts.getModifiers(n) || [] : []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const declNames = new Set();
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && hasExport(st)) { exported.push({ file, name: st.name.text, line: sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1 }); declNames.add(st.name); }
      if (ts.isVariableStatement(st) && hasExport(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) { exported.push({ file, name: d.name.text, line: sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1 }); declNames.add(d.name); }
    }
    const visit = (n) => { if (ts.isIdentifier(n) && !declNames.has(n)) uses.set(n.text, (uses.get(n.text) || 0) + 1); ts.forEachChild(n, visit); };
    visit(sf);
  }
  return exported.filter((e) => !uses.get(e.name));
}
