// Профиль проекта: что разбирать и как раскладывать по слоям. Выбирается `--profile=<имя>` или BLOCKMAP_PROFILE.
// reader — проект читалки (TS/TSX); tool — сам инструмент (mjs), его карта лежит в profiles/tool/.
import path from 'node:path';

export const ROOT = process.cwd().replace(/\\/g, '/');
const arg = process.argv.find((a) => a.startsWith('--profile='));
export const PROFILE_NAME = arg ? arg.slice('--profile='.length) : process.env.BLOCKMAP_PROFILE || 'reader';

const readerLayer = (f) => (f.startsWith('server/') || /^src\/engine\/(providers|proxy)/.test(f) ? 'Infra'
  : f.startsWith('src/components') || f.startsWith('src/App') || f.startsWith('src/main') ? 'UI'
  : f.startsWith('src/store') ? 'State' : f.startsWith('src/storage') ? 'Data' : f.startsWith('src/engine') ? 'Domain' : '—');

// Инструмент: UI — команды и их вывод; Домен — этапы сборки, проверки, правки карты, версии; Data — файлы карты (lib/store);
// Infra — адаптеры к TypeScript; их вызывает только Поставщик фактов (ui/facts.mjs, Домен).
const toolLayer = (f) => (/^tools\/blockmap\/(blockmap\.mjs|cli\/)/.test(f) ? 'UI'
  : /^tools\/blockmap\/lib\/store\//.test(f) ? 'Data'
  : /^tools\/blockmap\/(ui\/(callgraph|flowgen|states|dead|importgraph)\.mjs)/.test(f) ? 'Infra'
  : /^tools\/blockmap\/(ui\/|lib\/)/.test(f) ? 'Domain' : '—');

const PROFILES = {
  reader: {
    modelFile: 'tools/blockmap/ui/model.json', outDir: 'tools/blockmap/out', releasesDir: 'tools/blockmap/ui/releases',
    roots: ['src', 'server/src'], ext: /\.(ts|tsx)$/, skipDirs: ['node_modules', 'dist', '__tests__', 'test'],
    paths: { '@/*': ['src/*'] }, allowJs: false, layerOf: readerLayer,
  },
  tool: {
    modelFile: 'tools/blockmap/profiles/tool/model.json', outDir: 'tools/blockmap/out/tool', releasesDir: 'tools/blockmap/profiles/tool/releases',
    roots: ['tools/blockmap'], ext: /\.mjs$/, skipDirs: ['node_modules', 'out', 'test', 'releases', 'experiments', 'profiles'],
    paths: {}, allowJs: true, layerOf: toolLayer,
  },
};

const p = PROFILES[PROFILE_NAME];
if (!p) throw new Error(`Нет профиля «${PROFILE_NAME}». Есть: ${Object.keys(PROFILES).join(', ')}`);

export const profile = { name: PROFILE_NAME, ...p };
export const abs = (f) => path.join(ROOT, f);
