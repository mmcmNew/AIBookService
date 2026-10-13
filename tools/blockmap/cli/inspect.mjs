// Команды чтения: что есть на карте и что показывает код.
import { NL, flag, pos, load, out, blockOrDie } from './context.mjs';
import { scanZones, scanRisks } from '../lib/checks.mjs';

export const cmds = {
  list() {
    const { model: m } = load();
    const rows = Object.entries(m.blocks).map(([id, b]) => ({ id, layer: b.layer, scenarios: b.scenarios, hash: b.hash, status: b.hashStatus, scope: b.scope, schema: b.flow ? (b.diff ? `${b.diff.covered}/${b.diff.total}` : 'ручная без привязки') : '—', ast: !!b.astFlow }));
    out(rows, rows.map((r) => `${r.id.padEnd(20)} ${r.layer.padEnd(6)} ${r.status.padEnd(8)} ${r.hash}  AST:${r.ast ? 'да' : 'нет'}  покрытие:${r.schema}  сценарии:${r.scenarios.join(',')}`).join('\n'));
  },
  block() {
    const { model: m } = load(); const id = pos[0]; const b = blockOrDie(m, id);
    const sc = b.scenarios.map((s) => m.scenarios.find((x) => x.id === s));
    const edges = sc.flatMap((s) => s.edges.filter((e) => e.from === id || e.to === id).map((e) => ({ scenario: s.id, dir: e.from === id ? 'выход' : 'вход', with: e.from === id ? e.to : e.from, label: e.label })));
    const intent = b.flow && m.flows[b.flow], ast = b.astFlow && m.flows[b.astFlow];
    const info = {
      id, title: b.title, layer: b.layer, anchor: b.planned ? 'запланирован (кода ещё нет)' : `${b.file}:${b.line} ${b.symbol}`, summary: b.summary, risk: b.risk || null,
      scenarios: b.scenarios, hash: b.hash, hashStatus: b.hashStatus, hashScope: b.scope, resources: b.res || [], function: b.fn || null, links: edges,
      intentSteps: intent ? intent.nodes.map((n) => ({ id: n.id, type: n.t, label: n.label, bind: n.bind, covers: n.covers, stale: n.stale, orphan: n.orphan })) : null,
      astNodes: ast ? ast.nodes.length : null, diff: b.diff || null, approval: b.approval || null,
    };
    out(info, [
      `${id}: ${b.title}  [${b.layer}]  хеш ${b.hash} (${b.scope}) — ${b.hashStatus}`, `якорь: ${info.anchor}`, b.summary, b.risk ? `риск: ${b.risk}` : '',
      `сценарии: ${b.scenarios.join(', ')}`, `ресурсы: ${(b.res || []).join(', ') || '—'}`,
      'связи:', ...edges.map((e) => { const v = (m.verify?.edges || []).find((x) => x.scenario === e.scenario && x.label === e.label && ((x.from === id && x.to === e.with) || (x.to === id && x.from === e.with))); const mark = !v ? '' : v.status === 'ok' ? '✓ ' : v.status === 'missing' ? (v.known ? '~ ' : '✗ ') : v.status === 'skipped' ? '· ' : '⚠ '; return `  ${mark}${e.dir} ${e.with} «${e.label}» (${e.scenario})${v?.evidence ? '  ' + v.evidence : ''}${v?.path ? '  через ' + v.path.map((x) => x.split('#')[1]).join(' > ') : ''}${v?.known ? '  [принято: ' + v.known + ']' : ''}`; }),
      intent ? `шаги намерения: ${intent.nodes.length}` : 'ручной схемы нет', ast ? `узлов AST: ${ast.nodes.length}` : 'AST-схемы нет (добавьте в astFlows)',
      b.diff ? `сверка: покрыто ${b.diff.covered}/${b.diff.total}; код без шага: ${b.diff.uncovered.length}; шаг без кода: ${b.diff.orphans.length}; код шага изменился: ${b.diff.stale.length}` : '',
      ...(b.diff ? b.diff.uncovered.map((u) => `  - код без шага: ${u.file}:${u.line} ${u.label}`) : []),
    ].filter(Boolean).join('\n'));
  },
  impact() {
    const { model: m } = load(); const arg = pos[0]; if (!arg) { console.error('Укажите файл: impact src/engine/audio/audioManager.ts[:строка]'); process.exit(2); }
    const [file, lineS] = arg.split(':'), line = lineS ? Number(lineS) : null;
    const direct = new Set(), via = [];
    for (const [id, b] of Object.entries(m.blocks)) {
      if (b.file === file) direct.add(id);
      const fl = b.astFlow && m.flows[b.astFlow];
      if (fl && fl.nodes.some((n) => n.file === file && (!line || (n.line <= line && line <= (n.endLine ?? n.line))))) direct.add(id);
    }
    for (const [rid, r] of Object.entries(m.resources)) {
      const owns = r.file === file, uses = r.consumers.some((c) => c.file === file);
      if (!owns && !uses) continue;
      const blocks = Object.entries(m.blocks).filter(([, b]) => (b.res || []).includes(rid)).map(([id]) => id);
      via.push({ resource: rid, relation: owns ? 'владелец' : 'потребитель', blocks, otherConsumers: r.consumers.filter((c) => c.file !== file).map((c) => `${c.file} (${c.rw.join('/') || 'использует'})`) });
    }
    const affected = new Set([...direct, ...via.flatMap((v) => v.blocks)]);
    const scenarios = m.scenarios.filter((s) => Object.keys(s.cols).some((b) => affected.has(b))).map((s) => s.id);
    out({ file, line, blocks: [...direct], viaResources: via, scenarios }, [
      `файл ${arg}`, `блоки напрямую: ${[...direct].join(', ') || 'нет (файл вне карты)'}`,
      ...via.map((v) => `ресурс ${v.resource} (${v.relation}) — блоки: ${v.blocks.join(', ') || '—'}; другие потребители: ${v.otherConsumers.length}`),
      `затронутые сценарии: ${scenarios.join(', ') || 'нет'}`,
    ].join('\n'));
  },
  zones() {
    const { model: m, graph } = load(); const z = scanZones(m, graph);
    const undecl = z.findings.filter((f) => f.kind === 'undeclared-resource'), code = z.findings.filter((f) => f.kind === 'undeclared-in-code');
    const hard = z.jumps.filter((j) => j.kind === 'layer-jump'), soft = z.jumps.filter((j) => j.kind === 'layer-disputed');
    out(z, [
      `== Ресурс используется в чужом блоке (файл есть на карте, ресурс не заявлен): ${undecl.filter((f) => f.blocks.length).length}`,
      ...undecl.filter((f) => f.blocks.length).map((f) => `  ${f.resource}  <-  ${f.file} [${f.layer}, ${f.rw}]  блок файла: ${f.blocks.join(',')}; заявили: ${f.declaredBy.join(',') || 'никто'}\n      → ${f.advice === 'violation' ? 'НАРУШЕНИЕ: ' + f.layer + ' пишет в чужой ресурс, не заявлять, а разбирать' : 'добавьте "' + f.resource + '" в блок ' + f.blocks.join(' или ') + ' (blockmap declare)'}`),
      `== Ресурс используется файлами вне карты (блоки ещё не описаны): ${undecl.filter((f) => !f.blocks.length).length}`,
      ...Object.entries(undecl.filter((f) => !f.blocks.length).reduce((a, f) => ({ ...a, [f.resource]: (a[f.resource] || 0) + 1 }), {})).map(([r, n]) => `  ${r}: ${n} файлов (список: --json)`),
      `== Узлы кода трогают ресурс, не заявленный в блоке: ${code.length}`, ...code.map((f) => `  ${f.block}: ${f.resource} (${f.rw}) строка ${f.line}`),
      `== Запрещённые прыжки слоёв: ${hard.length}`, ...hard.slice(0, 25).map((j) => `  ${j.rule}  ${j.from} -> ${j.to}`),
      `== Спорные (State>Domain, матрица не решена): ${soft.length}`,
    ].filter(Boolean).join('\n'));
  },
  risks() {
    const { model: m, graph } = load(), all = scanRisks(m, graph);
    const open = all.filter((r) => !r.ack), silent = open.filter((r) => r.level === 'silent'), logged = open.filter((r) => r.level === 'logged');
    const shown = (flag('--all') ? all : flag('--logged') ? open : silent).sort((a, b) => (b.blocks.length - a.blocks.length) || a.file.localeCompare(b.file) || a.line - b.line);
    out({ total: all.length, silent: silent.length, logged: logged.length, acked: all.length - open.length, items: shown }, [
      `Проглоченные ошибки: всего ${all.length}; тихих (ни throw, ни лога) ${silent.length}; только лог ${logged.length}; принято осознанно ${all.length - open.length}`,
      ...shown.map((r) => `  ${r.level === 'silent' ? 'тихо ' : 'лог   '} ${r.file}:${r.line} ${r.kind}${r.fn ? ' в ' + r.fn : ''}${r.blocks.length ? '  [блок: ' + r.blocks.join(',') + ']' : ''}${r.ack ? '  ✓ ' + r.ack : ''}`),
      '', 'Принять осознанно: blockmap ack <файл:строка> "причина". Флаги: --logged (и лог), --all (и принятые), --json',
    ].join('\n'));
  },
  lint() {
    const { model: m } = load(), L = m.lint, id = pos[0], nl = NL;
    const list = L.issues.filter((i) => !id || i.block === id || i.scenario === id);
    out(list, [`Проверка плановой архитектуры (только схема, без кода): ошибок ${L.errors}, предупреждений ${L.warnings}`, ...list.map((i) => `  ${i.sev === 'err' ? '✗' : '⚠'} [${i.scenario}] ${i.text}`)].join(nl));
  },
  states() {
    const { model: m } = load(), C = m.stateCatalog, id = pos[0];
    const list = id ? C.slices.filter((s) => s.id === id) : C.slices;
    if (id && !list.length) { console.error('Нет куска «' + id + '». Список: blockmap states'); process.exit(2); }
    const nl = NL, top = (arr, n) => arr.slice(0, n);
    out(id ? list[0] : C, id || true ? [
      ...(id ? [] : [`Каталог состояний: сторов ${C.stores.length}, кусков ${C.slices.length}`, '']),
      ...list.flatMap((s) => [
        `${s.id}  ${s.title}  [${s.file}]  владелец: ${s.owner || 'не назначен'}${s.note ? '  (' + s.note + ')' : ''}`,
        '  поля: ' + top(s.fields, 8).join(', ') + (s.fields.length > 8 ? ' … +' + (s.fields.length - 8) : ''),
        '  пишут (инициаторы): ' + (s.writers.length ? top(s.writers, 6).map((w) => w.who + ' (' + top(w.via, 3).join(', ') + ')').join('; ') : 'никто'),
        '  читают: ' + (s.readers.length ? top(s.readers.sort((a, b) => b.count - a.count), 6).map((r) => r.who + ' ×' + r.count).join('; ') : 'никто'),
        ...s.violations.map((v) => '  ✗ запись не из владельца: ' + v.who + ' (' + top(v.via, 3).join(', ') + ')' + (v.layer ? ' [' + v.layer + ']' : '')), '',
      ]),
      ...(id ? [] : [
        'Не разнесено по кускам (' + C.unassigned.length + '): ' + top(C.unassigned, 10).join(', ') + (C.unassigned.length > 10 ? ' …' : ''), '',
        'Логика в сторе (действия вызывают функции других слоёв): ' + C.leaks.length,
        ...C.leaks.map((l) => '  ' + l.store + '.' + l.action + ' → ' + top(l.leaks, 3).join(', ')),
      ]),
    ].join(nl) : '');
  },
  reality() {
    const { model: m } = load(), id = pos[0], w = { write: 'пишет', read: 'читает', uses: 'использует', call: 'вызывает' };
    const rows = (m.verify.actual || []).filter((r) => !['yes', 'accepted'].includes(r.declared) && (!id || r.from === id));
    out(rows, [`Реальные связи из кода, которых нет на схеме${id ? ' (блок ' + id + ')' : ''}: ${rows.length}`,
      ...rows.map((r) => `  ${r.from} → ${r.to}: ${(r.missingRw.length ? r.missingRw : r.rw).map((x) => w[x] || x).join(' / ')}${r.declared === 'partial' ? ' (на схеме есть другое)' : ''}  [${r.calls.join(', ')}]  ${r.evidence}`)].join(NL));
  },
};
