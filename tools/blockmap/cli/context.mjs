// Общее для команд: аргументы, запуск сборки, вывод. Работу делает Домен; здесь только разбор и печать.
import { ROOT, profile } from '../ui/profile.mjs';
import { NL, blocksByFile } from '../ui/shared.mjs';
import { buildMap } from '../ui/build.mjs';

export { ROOT, profile, NL, blocksByFile };
export const [cmd = 'help', ...args] = process.argv.slice(2);
export const flag = (f) => args.includes(f);
export const pos = args.filter((a) => !a.startsWith('--'));
export const AS_JSON = flag('--json');
export const refreshGraph = !flag('--fast');

// Собрать карту: { model, log, graph }
export function load() {
  try { return buildMap({ refreshGraph }); } catch (e) { console.error(e.stack || String(e)); process.exit(2); }
}
export const out = (obj, text) => console.log(AS_JSON ? JSON.stringify(obj, null, 2) : text);
export const blockOrDie = (m, id) => { const b = m.blocks[id]; if (!b) { console.error(`Нет блока «${id}». Список: blockmap list`); process.exit(2); } return b; };
