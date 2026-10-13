// Команда check: актуальна ли карта; эталон «до» и сравнение с ним.
import { NL, args, flag, load, out } from './context.mjs';
import { collectIssues, saveBaseline, compareWithBaseline } from '../lib/checks.mjs';

export const cmds = {
  check() {
    const { model: m } = load(); const strict = flag('--strict');
    const issues = collectIssues(m), { fail, warn } = issues;
    if (flag('--save-baseline')) { saveBaseline(issues); console.log('✓ эталон сохранён: ✗ ' + fail.length + ', предупреждений ' + warn.length + '. Сравнить позже: blockmap check --diff'); process.exit(0); }
    if (flag('--diff')) {
      const cmp = compareWithBaseline(issues);
      if (!cmp) { console.error('Нет эталона. Сначала: blockmap baseline'); process.exit(2); }
      const { base, newFail: nf, newWarn: nw, closedFail: cf, closedWarn: cw } = cmp;
      out({ before: { fail: base.fail.length, warn: base.warn.length }, after: { fail: fail.length, warn: warn.length }, newFail: nf, newWarn: nw, closedFail: cf, closedWarn: cw }, [
        'Было: ✗ ' + base.fail.length + ', предупреждений ' + base.warn.length + '. Стало: ✗ ' + fail.length + ', предупреждений ' + warn.length + '.',
        'НОВЫЕ ✗ (' + nf.length + '):', ...nf.map((x) => '  + ' + x), 'НОВЫЕ предупреждения (' + nw.length + '):', ...nw.map((x) => '  + ' + x),
        'ЗАКРЫТО ✗ (' + cf.length + '):', ...cf.map((x) => '  − ' + x), 'ЗАКРЫТО предупреждений (' + cw.length + '):', ...cw.map((x) => '  − ' + x),
        nf.length ? NL + 'ЕСТЬ НОВЫЕ ✗: код ухудшил схему' : NL + 'Новых ✗ нет',
      ].join(NL));
      process.exit(nf.length ? 1 : 0);
    }
    const bad = strict ? [...fail, ...warn] : fail;
    out({ ok: !bad.length, fail, warn }, [...fail.map((x) => '✗ ' + x), ...warn.map((x) => '· ' + x), bad.length ? `\nКАРТА НЕ АКТУАЛЬНА (${bad.length})` : '\nКарта актуальна'].join('\n'));
    process.exit(bad.length ? 1 : 0);
  },
  baseline() { args.push('--save-baseline'); cmds.check(); },
};
