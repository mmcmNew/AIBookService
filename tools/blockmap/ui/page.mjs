// Страница карты: каркас template.html + модули ui/view (стили и скрипты по порядку) + данные модели.
// Результат — один самодостаточный map.html.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './profile.mjs';

const VIEW = path.join(ROOT, 'tools/blockmap/ui');
// Порядок важен: скрипты делят глобальную область (core объявляет M, $, esc; main в конце запускает render)
const SCRIPTS = ['core', 'arrows', 'interact', 'scenario', 'flow', 'panel', 'main'];
const read = (f) => fs.readFileSync(path.join(VIEW, f), 'utf8');

export function renderPage(model) {
  return read('template.html')
    .replace('/*STYLE*/\n', () => read('view/style.css'))
    .replace('/*SCRIPT*/\n', () => SCRIPTS.map((n) => read(`view/${n}.js`)).join(''))
    .replace('/*DATA*/null', () => JSON.stringify(model));
}
