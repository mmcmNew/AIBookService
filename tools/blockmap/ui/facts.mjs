// Факты о коде проекта. Единственный вход в зону «Сбор данных»: всё, что достают из исходников
// (TypeScript API, файловая система), остальные части инструмента получают только отсюда.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './profile.mjs';
import { buildImportGraph } from './importgraph.mjs';
import { buildCallGraph } from './callgraph.mjs';
import { generateFlow, norm, listMembers, hashMembers, scanSwallows } from './flowgen.mjs';
import { scanStates } from './states.mjs';
import { findDeadExports } from './dead.mjs';

export const importGraph = () => buildImportGraph().graph;
export const callGraph = (files) => buildCallGraph(ROOT, files);
export const flowOf = (file, fn) => generateFlow(ROOT, file, fn);
export const membersOf = (file, cls) => listMembers(ROOT, file, cls);
export const hashOfMembers = (file, names) => hashMembers(ROOT, file, names);
export const normalize = (text) => norm(text);
export const statesOf = (files, cg, layerOf) => scanStates(files, cg, layerOf);
export const deadExports = (files, cg) => findDeadExports(files, cg);
export const swallowsOf = (file) => scanSwallows(ROOT, file);
export const readSource = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
export const sourceExists = (f) => fs.existsSync(path.join(ROOT, f));
