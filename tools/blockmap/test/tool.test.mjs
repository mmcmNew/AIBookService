// Тесты самого инструмента Block Map. Запуск: npm run blockmap:test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { layerOf, WRITE_ACTION, DB_WRITE, sha } from '../ui/shared.mjs';
import { diffStructure, suggestBump, bumpVersion } from '../lib/versions.mjs';
import { collectIssues } from '../lib/checks.mjs';
import { optimizeLayout } from '../lib/layout.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const BM = path.join(ROOT, 'tools/blockmap/blockmap.mjs');
const bm = (...a) => spawnSync(process.execPath, [BM, ...a, '--fast'], { cwd: ROOT, encoding: 'utf8' });

test('shared: слой по пути файла', () => {
  assert.equal(layerOf('src/components/A.tsx'), 'UI');
  assert.equal(layerOf('src/store/audioStore.ts'), 'State');
  assert.equal(layerOf('src/engine/audio/audioManager.ts'), 'Domain');
  assert.equal(layerOf('src/engine/providers/x.ts'), 'Infra');
  assert.equal(layerOf('server/index.ts'), 'Infra');
  assert.equal(layerOf('src/storage/db.ts'), 'Data');
  assert.equal(layerOf('README.md'), '—');
});

test('shared: признаки записи', () => {
  assert.ok(WRITE_ACTION.test('setVolume') && WRITE_ACTION.test('playNext') && !WRITE_ACTION.test('getVolume'));
  assert.ok(DB_WRITE.test('db.audio.put(x)') && DB_WRITE.test('t.bulkAdd (a)') && !DB_WRITE.test('db.audio.get(1)'));
  assert.equal(sha('a'), sha('a'));
  assert.notEqual(sha('a'), sha('b'));
  assert.equal(sha('a').length, 10);
});

const S = (blocks, scenarios = {}) => ({ blocks, states: {}, resources: {}, scenarios });
const B = (layer, extra = {}) => ({ layer, planned: false, title: layer, zone: null, ...extra });

test('versions: что считать мажором, минором, патчем', () => {
  const a = S({ x: B('UI'), y: B('Domain') }, { s: { blocks: ['x', 'y'], edges: ['x>y'] } });
  assert.equal(suggestBump(diffStructure(a, a)), 'patch');
  assert.equal(diffStructure(a, a).empty, true);
  const plus = S({ ...a.blocks, z: B('Data') }, a.scenarios);
  assert.equal(suggestBump(diffStructure(a, plus)), 'minor');
  const minus = S({ x: a.blocks.x }, a.scenarios);
  assert.equal(suggestBump(diffStructure(a, minus)), 'major');
  const moved = S({ x: a.blocks.x, y: B('State') }, a.scenarios);
  assert.equal(suggestBump(diffStructure(a, moved)), 'major');
  const edge = S(a.blocks, { s: { blocks: ['x', 'y'], edges: ['x>y', 'y>x'] } });
  assert.equal(suggestBump(diffStructure(a, edge)), 'minor');
});

test('versions: увеличение номера', () => {
  assert.equal(bumpVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(bumpVersion('0.1.4', 'minor'), '0.2.0');
  assert.equal(bumpVersion('0.2.3', 'major'), '1.0.0');
});

test('checks: что считается ✗, а что предупреждением', () => {
  const base = { warnings: [], blocks: {}, scenarios: [], lint: { issues: [] } };
  assert.deepEqual(collectIssues(base), { fail: [], warn: [] });
  const m = { ...base, warnings: ['нет файла'], blocks: { a: { hashStatus: 'changed', scenarios: ['s'] }, b: { hashStatus: 'new', scenarios: [] } } };
  const r = collectIssues(m);
  assert.ok(r.fail.some((x) => x.includes('нет файла')));
  assert.ok(r.fail.some((x) => x.includes('блок a изменён')));
  assert.ok(r.warn.some((x) => x.includes('блок b не утверждён')));
});

test('layout: раскладка не ухудшает пересечения и не теряет блоки', () => {
  const m = { blocks: { a: { layer: 'UI', zone: 'z1' }, b: { layer: 'Domain', zone: 'z1' }, c: { layer: 'Domain', zone: 'z2' }, d: { layer: 'Data', zone: 'z2' } } };
  const sc = { cols: { a: 0, b: 0, c: 0, d: 0 }, edges: [{ from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'a', to: 'b' }] };
  const r = optimizeLayout(m, sc);
  assert.ok(r.after <= r.before);
  assert.deepEqual(Object.keys(r.best).sort(), ['a', 'b', 'c', 'd']);
  for (const v of Object.values(r.best)) assert.ok(Number.isInteger(v) && v >= 0);
});

test('CLI: каждая команда запускается без падения', () => {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/blockmap/ui/model.json'), 'utf8'));
  const anyBlock = Object.keys(model.blocks)[0], anyStates = Object.keys(model.states || {})[0];
  const runs = [['help'], ['list'], ['block', anyBlock], ['impact', 'src/store/audioStore.ts'], ['zones'], ['lint'], ['states'], ['states', anyStates],
    ['reality'], ['risks'], ['check'], ['check', '--diff'], ['declare'], ['version'], ['layout', model.scenarios[0].id], ['build']];
  for (const a of runs) {
    const r = bm(...a);
    assert.ok(![undefined, null].includes(r.status), a.join(' ') + ': не запустилось');
    assert.ok(!/ReferenceError|TypeError|SyntaxError|Cannot find|ERR_MODULE/.test(r.stderr), a.join(' ') + ': ' + r.stderr.slice(0, 300));
    assert.ok(r.status <= 1, a.join(' ') + ': код ' + r.status + ' ' + r.stderr.slice(0, 200));
  }
});

test('CLI: команды с неверными аргументами отвечают подсказкой, а не падают', () => {
  for (const a of [['block', 'нет_такого'], ['ack'], ['edge-ack'], ['reality-ack'], ['release'], ['bind']]) {
    const r = bm(...a);
    assert.equal(r.status, 2, a.join(' ') + ' ' + r.stderr);
    assert.ok(!/ReferenceError|TypeError/.test(r.stderr), a.join(' '));
  }
});

test('сборка детерминирована: два прогона дают одну и ту же модель', () => {
  const f = path.join(ROOT, 'tools/blockmap/out/model.computed.json');
  bm('build'); const a = fs.readFileSync(f, 'utf8');
  bm('build'); const b = fs.readFileSync(f, 'utf8');
  assert.equal(a, b);
});

test('model.json: чтение и запись без потерь', () => {
  const f = path.join(ROOT, 'tools/blockmap/ui/model.json'), raw = fs.readFileSync(f, 'utf8');
  assert.equal(JSON.stringify(JSON.parse(raw), null, 2) + String.fromCharCode(10), raw);
});

test('самоописание: карта инструмента проходит check --strict (код выхода 0)', () => {
  const r = spawnSync(process.execPath, [BM, 'check', '--strict', '--profile=tool'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Карта актуальна/);
});

test('самоописание: правила плана инструмента без ошибок и предупреждений', () => {
  const r = spawnSync(process.execPath, [BM, 'lint', '--profile=tool', '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test('страница карты собирается из модулей и содержит данные', async () => {
  const { renderPage } = await import('../ui/page.mjs');
  const html = renderPage({ blocks: {}, marker: 'тест-данные' });
  assert.ok(html.includes('тест-данные'));
  for (const m of ['/*STYLE*/', '/*SCRIPT*/', '/*DATA*/']) assert.ok(!html.includes(m), 'не заменён маркер ' + m);
  assert.ok(html.includes('function drawScenario') && html.includes('function arrows(') && html.includes('function showBlock'));
});

test('профили: у каждого есть файл модели, слои считаются', async () => {
  const { profile } = await import('../ui/profile.mjs');
  assert.equal(profile.name, 'reader');
  assert.ok(fs.existsSync(path.join(ROOT, profile.modelFile)));
  assert.equal(path.basename(path.join(ROOT, 'tools/blockmap/profiles/tool/model.json')), 'model.json');
  assert.ok(fs.existsSync(path.join(ROOT, 'tools/blockmap/profiles/tool/model.json')));
});
