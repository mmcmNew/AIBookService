// Команды версий схемы: version (что изменилось) и release (выпустить). Считает отдел версий.
import { NL, args, pos, out } from './context.mjs';
import { versionReport, releaseVersion } from '../lib/versions.mjs';

export const cmds = {
  version() {
    const { version: v, diff: d, suggestedBump: bump } = versionReport();
    out({ version: v, diff: d, suggestedBump: bump }, [
      v ? `Схема v${v.current}  веха: ${v.milestone}` : 'Схема ещё не выпускалась. Первая версия: blockmap release "заметка"',
      ...(d ? [`Изменения со времени v${v.current}: ${d.empty ? 'структура не менялась (patch: подписи, привязки, принятия)' : 'рекомендуется ' + bump}`, ...d.lines.map((l) => '  ' + l)] : []),
      ...(v && v.changelog.length ? ['', 'История:', ...v.changelog.slice(-5).reverse().map((c) => `  v${c.version} (${c.date}, ${c.bump}) ${c.note}`)] : []),
    ].join(NL));
  },
  release() {
    const note = pos.join(' ').trim(); if (!note) { console.error('release "заметка о изменениях" [--bump=major|minor|patch] [--milestone="название вехи"]'); process.exit(2); }
    const arg = (n) => (args.find((a) => a.startsWith('--' + n + '=')) || '').slice(n.length + 3);
    const r = releaseVersion({ note, bump: arg('bump'), milestone: arg('milestone') });
    console.log(`✓ выпущена v${r.next} (${r.bump}): ${note}`); r.lines.slice(0, 8).forEach((l) => console.log('  ' + l));
  },
};
