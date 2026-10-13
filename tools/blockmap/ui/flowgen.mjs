// Блок-схема функции из AST (TypeScript compiler API): if/switch/циклы/try/return -> узлы и рёбра.
// Подписи — текст из кода (без LLM). Простые операторы подряд склеиваются в один шаг.
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { sha } from './shared.mjs';

// нормализация: токены TypeScript без trivia (пробелы, переводы строк, комментарии)
export const norm = (text) => {
  const sc = ts.createScanner(ts.ScriptTarget.ES2020, true, ts.LanguageVariant.Standard, text);
  const out = []; let k;
  while ((k = sc.scan()) !== ts.SyntaxKind.EndOfFileToken) out.push(sc.getTokenText());
  return out.join(' ');
};
const short = (s, n = 44) => { s = s.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function findFunction(sf, name) {
  const [cls, member] = name.includes('.') ? name.split('.') : [null, name];
  let found = null;
  const visit = (n) => {
    if (found) return;
    if (!cls && ts.isFunctionDeclaration(n) && n.name?.text === member) found = n;
    else if (!cls && ts.isVariableDeclaration(n) && n.name.getText(sf) === member && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) found = n.initializer;
    else if (cls && ts.isClassDeclaration(n) && n.name?.text === cls) {
      for (const m of n.members) {
        if ((ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) && m.name.getText(sf) === member) found = ts.isPropertyDeclaration(m) ? m.initializer : m;
      }
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

export function generateFlow(root, file, fnName) {
  const sf = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.ES2020, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const fn = findFunction(sf, fnName);
  if (!fn || !fn.body) return null;
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const nodes = [], edges = [];
  let seq = 0;
  const endLine = (n) => sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
  const mk = (t, label, n, last) => {
    const node = { id: 'n' + ++seq, t, label, ...(n ? { file, line: line(n), endLine: endLine(last || n), src: short(n.getText(sf), 600) } : {}) };
    // хеш фрагмента: токены без пробелов и комментариев — не зависит от форматирования и сдвига строк
    node.h = n ? sha(norm(sf.text.slice(n.getStart(sf), (last || n).getEnd()))) : 'end';
    nodes.push(node); return node;
  };
  const link = (preds, to) => preds.forEach((p) => edges.push({ from: p.id, to: to.id, ...(p.label ? { label: p.label } : {}) }));
  const loops = []; // { cond, breaks:[], continues:[] }
  const switches = []; // { breaks:[] }

  const isSimple = (s) => !(ts.isIfStatement(s) || ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isSwitchStatement(s) || ts.isForStatement(s) || ts.isForOfStatement(s) || ts.isForInStatement(s) || ts.isWhileStatement(s) || ts.isDoStatement(s) || ts.isTryStatement(s) || ts.isBlock(s) || ts.isBreakStatement(s) || ts.isContinueStatement(s));
  const isLogOnly = (s) => ts.isExpressionStatement(s) && /^console\.\w+\(/.test(s.expression.getText(sf));
  const { swallowLevel, warnText } = swallowTools(sf);
  // promise.catch(cb): худший уровень среди обработчиков группы операторов
  const catchSwallows = (group) => {
    let worst = null, text = '';
    const v = (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'catch' && n.arguments[0] && ts.isFunctionLike(n.arguments[0])) {
        const h = n.arguments[0], lvl = swallowLevel(h, h.parameters[0]?.name.getText(sf));
        if (lvl === 'silent' || (lvl === 'logged' && worst !== 'silent')) { worst = lvl; text = n.getText(sf); }
      }
      ts.forEachChild(n, v);
    };
    group.forEach(v); return worst ? { lvl: worst, text } : null;
  };
  const isAbortThrow = (s) => {
    const t = ts.isBlock(s) ? s.statements[0] : s;
    return t && ts.isThrowStatement(t) && /Abort/.test(t.expression.getText(sf)) && (!ts.isBlock(s) || s.statements.length === 1);
  };
  const callNames = (s) => {
    const out = [];
    const v = (n) => { if (ts.isCallExpression(n)) out.push(short(n.expression.getText(sf), 26)); if (!ts.isFunctionLike(n)) ts.forEachChild(n, v); };
    v(s); return [...new Set(out)];
  };

  function walk(stmts, preds) {
    let cur = preds, group = [];
    const flush = () => {
      if (!group.length) return;
      const calls = group.flatMap(callNames);
      const text = group.map((g) => g.getText(sf)).join(' ');
      const io = /\b(await|fetch|db\.|localStorage|postMessage)\b/.test(text);
      const label = group.length === 1 ? short(text.replace(/^(const|let|var)\s+/, ''), 54)
        : short(group[0].getText(sf).replace(/^(const|let|var)\s+/, ''), 40) + `  … +${group.length - 1}`;
      const node = mk(io ? 'io' : 'step', label, group[0], group.at(-1));
      node.src = short(text, 800); // для автометок ресурсов нужен текст всей группы
      const cs = catchSwallows(group);
      if (cs) { node.warn = warnText('promise .catch', cs.lvl); node.warnLevel = cs.lvl; node.riskFp = sha(file + '|' + norm(cs.text)); }
      link(cur, node); cur = [{ id: node.id }]; group = [];
    };
    for (const s of stmts) {
      if (isLogOnly(s)) continue; // console.* — шум, на схему не выносим
      if (isSimple(s)) { group.push(s); continue; }
      flush();
      cur = stmt(s, cur);
    }
    flush();
    return cur;
  }

  function stmt(s, preds) {
    if (isSimple(s)) return walk([s], preds); // ветка if без {} — один простой оператор
    if (ts.isBlock(s)) return walk(s.statements, preds);
    if (ts.isIfStatement(s) && !s.elseStatement && isAbortThrow(s.thenStatement)) {
      // шум: «если отменено — бросить AbortError» сворачиваем в один шаг без ветвления
      const a = mk('step', 'проверка отмены (abort)', s, s.expression); a.kind = 'abort'; link(preds, a); return [{ id: a.id }];
    }
    if (ts.isIfStatement(s)) {
      const c = mk('cond', short(s.expression.getText(sf)) + '?', s, s.expression); link(preds, c);
      const thenEnds = stmt(s.thenStatement, [{ id: c.id, label: 'Да' }]);
      const elseEnds = s.elseStatement ? stmt(s.elseStatement, [{ id: c.id, label: 'Нет' }]) : [{ id: c.id, label: 'Нет' }];
      return [...thenEnds, ...elseEnds];
    }
    if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) {
      const e = mk('end', (ts.isThrowStatement(s) ? 'throw ' : 'return ') + short(s.expression?.getText(sf) ?? '', 28), s); link(preds, e); return [];
    }
    if (ts.isBreakStatement(s)) { (switches.length ? switches : loops).at(-1)?.breaks.push(...preds); return []; }
    if (ts.isContinueStatement(s)) { loops.at(-1)?.continues.push(...preds); return []; }
    if (ts.isSwitchStatement(s)) {
      const c = mk('cond', 'switch ' + short(s.expression.getText(sf), 30), s, s.expression); link(preds, c);
      const ctx = { breaks: [] }; switches.push(ctx);
      let ends = [], pending = [];
      for (const cl of s.caseBlock.clauses) {
        const lab = ts.isCaseClause(cl) ? short(cl.expression.getText(sf), 18) : 'default';
        pending.push({ id: c.id, label: lab });
        if (!cl.statements.length) continue; // fallthrough: копим входы
        ends = ends.concat(walk(cl.statements, pending)); pending = [];
      }
      switches.pop();
      return [...ends, ...ctx.breaks, ...pending];
    }
    if (ts.isForStatement(s) || ts.isForOfStatement(s) || ts.isForInStatement(s) || ts.isWhileStatement(s) || ts.isDoStatement(s)) {
      const head = ts.isForStatement(s) ? (s.condition?.getText(sf) ?? 'for') : ts.isWhileStatement(s) || ts.isDoStatement(s) ? s.expression.getText(sf) : s.getText(sf).split(')')[0].replace(/^for\s*\(/, '');
      const c = mk('cond', 'цикл: ' + short(head, 34), s, ts.isForStatement(s) ? (s.condition ?? s.initializer ?? s) : s.expression); link(preds, c);
      const ctx = { cond: c, breaks: [], continues: [] }; loops.push(ctx);
      const bodyEnds = stmt(s.statement, [{ id: c.id, label: 'да' }]);
      loops.pop();
      [...bodyEnds, ...ctx.continues].forEach((p) => edges.push({ from: p.id, to: c.id, label: 'ещё', back: true }));
      return [{ id: c.id, label: 'выход' }, ...ctx.breaks];
    }
    if (ts.isTryStatement(s)) {
      const t = mk('step', 'try', s, s.tryBlock.getChildAt(0)); t.kind = 'try'; t.src = ''; link(preds, t);
      let ends = stmt(s.tryBlock, [{ id: t.id }]);
      if (s.catchClause) {
        const lvl = swallowLevel(s.catchClause.block, s.catchClause.variableDeclaration?.name.getText(sf));
        if (lvl) { t.warn = warnText('catch', lvl); t.warnLevel = lvl; t.riskFp = sha(file + '|' + norm(s.catchClause.getText(sf))); t.label = lvl === 'silent' ? 'try · catch тихо глотает ошибку' : 'try · catch только логирует'; }
        ends = ends.concat(stmt(s.catchClause.block, [{ id: t.id, label: 'ошибка' }]));
      }
      if (s.finallyBlock) ends = stmt(s.finallyBlock, ends.length ? ends : [{ id: t.id }]);
      return ends;
    }
    return preds;
  }

  const params = fn.parameters.map((p) => p.name.getText(sf)).join(', ');
  const start = mk('start', short(fnName + '(' + params + ')', 30), fn, ts.isBlock(fn.body) ? fn.body.getChildAt(0) : fn); // хеш старта = сигнатура
  const body = ts.isBlock(fn.body) ? fn.body.statements : [ts.factory.createReturnStatement(fn.body)];
  const ends = ts.isBlock(fn.body) ? walk(body, [{ id: start.id }]) : (() => { const c = mk('step', short(fn.body.getText(sf)), fn.body); link([{ id: start.id }], c); return [{ id: c.id }]; })();
  if (ends.length) { const e = mk('end', 'конец', null); link(ends, e); }
  layout(nodes, edges, start.id);
  // ключ узла = хеш#номер повтора (одинаковые фрагменты, например две проверки abort, различаются порядком)
  const seen = {};
  for (const n of nodes) { n.key = `${n.h}#${seen[n.h] = (seen[n.h] ?? -1) + 1}`; }
  const codeHash = sha(nodes.map((n) => n.key).join('|'));
  return { nodes, edges, codeHash };
}

// слои по самому длинному пути без обратных рёбер, колонки — ближе к родителям
function layout(nodes, edges, startId) {
  const fwd = edges.filter((e) => !e.back);
  const out = {}, inn = {};
  nodes.forEach((n) => { out[n.id] = []; inn[n.id] = []; });
  fwd.forEach((e) => { out[e.from].push(e.to); inn[e.to].push(e.from); });
  const row = {}; const indeg = Object.fromEntries(nodes.map((n) => [n.id, inn[n.id].length]));
  const queue = nodes.filter((n) => !indeg[n.id]).map((n) => n.id); queue.forEach((q) => (row[q] = 0));
  while (queue.length) { const u = queue.shift(); for (const v of out[u]) { row[v] = Math.max(row[v] ?? 0, row[u] + 1); if (--indeg[v] === 0) queue.push(v); } }
  nodes.forEach((n) => (n.row = row[n.id] ?? 0));
  const byRow = {}; nodes.forEach((n) => (byRow[n.row] ||= []).push(n));
  const col = {};
  const rows = Object.keys(byRow).map(Number).sort((a, b) => a - b);
  // три прохода (вниз, вверх, вниз): колонка ближе к среднему соседей, главный путь («Нет»/первое ребро) держится левее
  const sweep = (order, nb) => {
    for (const r of order) {
      const taken = new Set();
      const want = (n) => { const ps = nb[n.id].filter((p) => col[p] !== undefined); return ps.length ? ps.reduce((a, p) => a + col[p], 0) / ps.length : (col[n.id] ?? 0); };
      for (const n of [...byRow[r]].sort((a, b) => want(a) - want(b) || a.id.localeCompare(b.id, undefined, { numeric: true }))) {
        const w = Math.round(want(n)); let c = w, d = 0;
        while (taken.has(c)) { d++; c = w + (d % 2 ? Math.ceil(d / 2) : -d / 2); }
        taken.add(c); col[n.id] = c;
      }
    }
  };
  sweep(rows, inn); sweep([...rows].reverse(), out); sweep(rows, inn);
  const min = Math.min(...Object.values(col));
  nodes.forEach((n) => (n.col = col[n.id] - min));
}

// имена методов класса (для подсказки «якорь — диспетчер, логика в другом методе»)
export function listMembers(root, file, cls) {
  const sf = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.ES2020, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = [];
  const visit = (n) => {
    if (ts.isClassDeclaration(n) && n.name?.text === cls) { for (const m of n.members) if ((ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) && m.name) names.push(m.name.getText(sf)); return; }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

// Инструменты поиска проглоченных ошибок (общие для схемы функции и для сканирования файлов).
// swallowLevel: null — ошибка пробрасывается или обрабатывается (throw, Promise.reject, переменная ошибки уходит не в лог);
// 'logged' — только лог; 'silent' — ни throw, ни лога.
export function swallowTools(sf) {
  const isLogCall = (n) => ts.isCallExpression(n) && (/^console\.\w+$/.test(n.expression.getText(sf)) || /(^|\.)(logger|log|warn|error)\w*$/.test(n.expression.getText(sf)));
  const swallowLevel = (handler, errName) => {
    let thrown = false, logged = false, used = false;
    const v = (n, inLog) => {
      if (ts.isThrowStatement(n)) thrown = true;
      if (ts.isCallExpression(n) && /^Promise\.reject$/.test(n.expression.getText(sf))) thrown = true;
      const log = isLogCall(n); if (log) logged = true;
      if (errName && ts.isIdentifier(n) && n.text === errName && !inLog) used = true;
      if (!ts.isFunctionLike(n) || n === handler) ts.forEachChild(n, (c) => v(c, inLog || log));
    };
    const body = ts.isFunctionLike(handler) ? handler.body : handler; // имя параметра ошибки в «использование» не входит
    if (body) v(body, false);
    return thrown || used ? null : logged ? 'logged' : 'silent';
  };
  const warnText = (kind, lvl) => (lvl === 'silent' ? `${kind} тихо проглатывает ошибку (нет ни throw, ни лога)` : `${kind} только логирует ошибку`);
  return { swallowLevel, warnText };
}

// Скан всего файла: каждый catch-блок и promise.catch(...), которые проглатывают ошибку.
export function scanSwallows(root, file) {
  const sf = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.ES2020, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const { swallowLevel, warnText } = swallowTools(sf), out = [];
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const enclosing = (n) => { for (let p = n.parent; p; p = p.parent) { if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText(sf); if (ts.isVariableDeclaration(p) && p.initializer && ts.isFunctionLike(p.initializer)) return p.name.getText(sf); } return null; };
  const visit = (n) => {
    if (ts.isTryStatement(n) && n.catchClause) {
      const lvl = swallowLevel(n.catchClause.block, n.catchClause.variableDeclaration?.name.getText(sf));
      if (lvl) out.push({ file, line: lineOf(n.catchClause), level: lvl, kind: 'catch', fn: enclosing(n), warn: warnText('catch', lvl), fp: sha(file + '|' + norm(n.catchClause.getText(sf))) });
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'catch' && n.arguments[0] && ts.isFunctionLike(n.arguments[0])) {
      const h = n.arguments[0], lvl = swallowLevel(h, h.parameters[0]?.name.getText(sf));
      if (lvl) out.push({ file, line: lineOf(n), level: lvl, kind: 'promise.catch', fn: enclosing(n), warn: warnText('promise .catch', lvl), fp: sha(file + '|' + norm(n.getText(sf))) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// Хеш по функциям блока (их нормализованный текст): правка соседнего кода в том же файле хеш блока не меняет.
export function hashMembers(root, file, names) {
  const sf = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.ES2020, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const want = new Set(names), found = {}, isFn = (x) => x && (ts.isArrowFunction(x) || ts.isFunctionExpression(x));
  const visit = (n) => {
    let name = null, body = null;
    if (ts.isFunctionDeclaration(n) && n.name) { name = n.name.text; body = n; }
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isFn(n.initializer)) { name = n.name.text; body = n.initializer; }
    else if (ts.isMethodDeclaration(n) && n.name) { name = n.name.getText(sf); body = n; }
    else if ((ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) && n.name && isFn(n.initializer)) { name = n.name.getText(sf); body = n.initializer; }
    if (name && want.has(name) && body && !found[name]) found[name] = sha(norm(body.getText(sf)));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sha(Object.keys(found).sort().map((k) => k + ':' + found[k]).join('|') + '|нет:' + names.filter((x) => !found[x]).join(','));
}
