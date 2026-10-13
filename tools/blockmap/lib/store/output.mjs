// Результаты сборки: граф импортов, вычисленная модель, map.html, служебные отчёты (папка out профиля).
import fs from 'node:fs';
import path from 'node:path';
import { profile, abs } from '../../ui/profile.mjs';
import { renderPage } from '../../ui/page.mjs';

const out = (name) => path.join(abs(profile.outDir), name);
const ensure = () => fs.mkdirSync(abs(profile.outDir), { recursive: true });

export const hasGraph = () => fs.existsSync(out('graph.json'));
export const readGraph = () => JSON.parse(fs.readFileSync(out('graph.json'), 'utf8'));
export const writeGraph = (graph) => { ensure(); fs.writeFileSync(out('graph.json'), JSON.stringify(graph)); };
export const writeOutJson = (name, obj) => { ensure(); fs.writeFileSync(out(name), JSON.stringify(obj, null, 2)); };
export const writeBuildOutput = (model) => {
  ensure();
  fs.writeFileSync(out('model.computed.json'), JSON.stringify(model));
  fs.writeFileSync(out('map.html'), renderPage(model));
};
