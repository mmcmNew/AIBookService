// Команды принятия и утверждения: разбирают аргументы и просят Редактор карты. Файл модели сами не пишут.
import { NL, flag, pos, load, refreshGraph } from './context.mjs';
import { acceptRisk, acceptReality, acceptEdge, applyDeclarations, approve } from '../lib/editor.mjs';
import { planDeclarations } from '../lib/checks.mjs';

export const cmds = {
  ack() {
    const [loc, ...rest] = pos, reason = rest.join(' ').trim(), mm = /^(.+):(\d+)$/.exec(loc || '');
    if (!mm || !reason) { console.error('ack <файл:строка> "причина"'); process.exit(2); }
    const r = acceptRisk(mm[1], Number(mm[2]), reason);
    if (!r) { console.error(`В ${mm[1]} около строки ${mm[2]} нет проглоченной ошибки (blockmap risks)`); process.exit(2); }
    console.log(`✓ принято осознанно: ${r.file}:${r.line} (${r.level}) — ${reason}\nПодтверждение привязано к хешу кода: при правке этого блока оно сбросится.`);
  },
  'reality-ack'() {
    const [from, to, ...rest] = pos, reason = rest.join(' ').trim();
    if (!from || !to || !reason) { console.error('reality-ack <откуда> <куда> "причина"'); process.exit(2); }
    acceptReality(from, to, reason); console.log('✓ реальная связь ' + from + ' → ' + to + ' принята: ' + reason);
  },
  'edge-ack'() {
    const [from, to, ...rest] = pos, reason = rest.join(' ').trim();
    if (!from || !to || !reason) { console.error('edge-ack <откуда> <куда> "причина"'); process.exit(2); }
    const n = acceptEdge(from, to, reason);
    if (!n) { console.error('Такого ребра нет на карте'); process.exit(2); }
    console.log(`✓ ребро ${from} -> ${to} принято как известное расхождение (${n}): ${reason}`);
  },
  declare() {
    const { model: m, graph } = load(), { plan, one, ambiguous: amb, violations: viol } = planDeclarations(m, graph);
    const lines = Object.entries(plan).map(([b, s]) => `  + ${b}: res += ${[...s].join(', ')}`);
    console.log([`Можно заявить ресурсы (файл принадлежит одному блоку): ${one.length}`, ...lines,
      `Неоднозначно (файл в нескольких блоках, решайте вручную): ${amb.length}`, ...amb.map((f) => `  ${f.file} -> ${f.resource}; блоки: ${f.blocks.join(', ')}`),
      `Нарушения (заявлять нельзя, разбирать): ${viol.length}`, ...viol.map((f) => `  ${f.file} [${f.layer}] пишет в ${f.resource}`)].join(NL));
    if (!flag('--apply')) { console.log(NL + 'Применить заявления: blockmap declare --apply'); return; }
    applyDeclarations(plan); console.log(NL + '✓ res обновлены в model.json. Проверьте: blockmap check');
  },
  bind() {
    let ids = [...pos];
    if (flag('--changed')) { const { model: m0 } = load(); ids = [...Object.entries(m0.blocks).filter(([, b]) => b.hashStatus === 'changed').map(([id]) => id), ...m0.scenarios.filter((x) => x.status === 'changed').map((x) => x.id)]; if (!ids.length) { console.log('Изменившихся блоков и сценариев нет'); return; } }
    if (!ids.length && !flag('--all')) { console.error('bind <id блока|сценария> [ещё id …] | bind --changed | bind --all'); process.exit(2); }
    const all = flag('--all'), log = approve(all ? true : ids, { refreshGraph });
    const lines = log.split(NL).filter((l) => /сверка|сценарий|bind|изменён/.test(l)).filter((l) => all || ids.some((i) => l.includes(i)) || /--bind/.test(l));
    console.log(all ? lines.join(NL) : '✓ утверждено: ' + ids.join(', ') + NL + lines.join(NL));
  },
};
