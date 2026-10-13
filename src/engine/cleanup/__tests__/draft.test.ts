import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chapter } from '../../../types/book';
import {
  chaptersToDraft,
  draftToChapters,
  isChapterDirty,
  isDraftDirty,
  mapReadingPosition,
  planCleanup,
  applyCleanupPlan,
  DEFAULT_CLEANUP_OPS,
  aiCleanParagraphs,
  parseJsonArray,
  splitIntoBatches,
  isReasonableEdit,
} from '../index';
import {
  addParagraph,
  applyCleanupToDraft,
  buildMatcher,
  deleteChapter,
  deleteParagraph,
  findInDraft,
  mergeChapterWithNext,
  mergeParagraphWithNext,
  renameChapter,
  replaceInDraft,
  splitParagraph,
  updateParagraphText,
} from '../draftOps';

function makeBook(): Chapter[] {
  const mk = (id: number, text: string, p: number) => ({ id, rawText: text, speechText: text, paragraphIndex: p });
  return [
    {
      id: 'ch1',
      title: 'Глава 1',
      level: 1,
      contentHtml: '',
      sentences: [
        mk(0, 'Первое предложение.', 0),
        mk(1, 'Второе предложение.', 0),
        mk(2, 'Третье предложение.', 1),
      ],
    },
    {
      id: 'ch2',
      title: 'Глава 2',
      level: 1,
      contentHtml: '',
      sentences: [mk(3, 'Четвёртое.', 0), mk(4, 'Пятое.', 1)],
    },
  ];
}

test('черновик: неизменённая книга не считается изменённой', () => {
  const book = makeBook();
  const draft = chaptersToDraft(book);
  assert.equal(draft[0].paragraphs.length, 2);
  assert.equal(draft[0].paragraphs[0].text, 'Первое предложение. Второе предложение.');
  assert.ok(!isChapterDirty(draft[0]));
  assert.ok(!isDraftDirty(draft, book));
  const rebuilt = draftToChapters(draft);
  assert.deepEqual(rebuilt.chapters, book);
  assert.deepEqual(rebuilt.changedChapterIds, []);
});

test('черновик: правка абзаца сохраняет id неизменённых предложений', () => {
  const book = makeBook();
  let draft = chaptersToDraft(book);
  draft = updateParagraphText(draft, 0, 0, 'Первое предложение. Второе предложение исправлено.');
  assert.ok(isDraftDirty(draft, book));
  const { chapters, changedChapterIds } = draftToChapters(draft, { lang: 'ru' });
  assert.deepEqual(changedChapterIds, ['ch1']);
  const s = chapters[0].sentences;
  assert.equal(s.length, 3);
  assert.equal(s[0].id, 0, 'первое предложение не изменилось — id сохранён (аудиокэш остаётся)');
  assert.ok(s[1].id > 4, 'изменённое предложение получило новый id');
  assert.equal(s[1].rawText, 'Второе предложение исправлено.');
  assert.equal(s[2].id, 2);
  assert.deepEqual(chapters[1], book[1], 'вторая глава не тронута');
  const ids = chapters.flatMap((c) => c.sentences.map((x) => x.id));
  assert.equal(new Set(ids).size, ids.length, 'id уникальны');
  assert.match(chapters[0].contentHtml, /<p class="my-3 leading-relaxed">Первое предложение\./);
});

test('черновик: HTML экранируется, пустые абзацы и главы отбрасываются', () => {
  const book = makeBook();
  let draft = chaptersToDraft(book);
  draft = updateParagraphText(draft, 0, 1, 'a < b & "c"');
  draft = deleteParagraph(draft, 1, 0);
  draft = deleteParagraph(draft, 1, 0);
  const res = draftToChapters(draft);
  assert.equal(res.droppedEmpty, 1);
  assert.equal(res.chapters.length, 1);
  assert.match(res.chapters[0].contentHtml, /a &lt; b &amp; &quot;c&quot;/);
});

test('операции: склейка, разбиение, добавление, главы', () => {
  const book = makeBook();
  let d = chaptersToDraft(book);
  d = mergeParagraphWithNext(d, 0, 0);
  assert.equal(d[0].paragraphs.length, 1);
  d = splitParagraph(d, 0, 0, 'Первое предложение. '.length);
  assert.equal(d[0].paragraphs.length, 2);
  assert.equal(d[0].paragraphs[0].text, 'Первое предложение.');
  assert.equal(splitParagraph(d, 0, 0, 0), d, 'разбиение по краю ничего не делает');
  d = addParagraph(d, 0, 0, 'Новый абзац');
  assert.equal(d[0].paragraphs[1].text, 'Новый абзац');
  d = renameChapter(d, 1, 'Новое имя');
  assert.equal(d[1].title, 'Новое имя');
  d = mergeChapterWithNext(d, 0);
  assert.equal(d.length, 1);
  assert.equal(deleteChapter(d, 0), d, 'последнюю главу удалить нельзя');
  const res = draftToChapters(d);
  assert.equal(new Set(res.chapters.flatMap((c) => c.sentences.map((s) => s.id))).size, res.chapters[0].sentences.length);
});

test('позиция чтения подбирается после правок', () => {
  const book = makeBook();
  let draft = chaptersToDraft(book);
  draft = updateParagraphText(draft, 0, 0, 'Что-то совсем другое. Второе предложение.');
  const { chapters } = draftToChapters(draft);
  const pos = mapReadingPosition(book, chapters, 'ch1', 1);
  assert.equal(pos.chapterIndex, 0);
  assert.equal(chapters[0].sentences.find((s) => s.id === pos.sentenceId)?.rawText, 'Второе предложение.');
  // глава удалена -> ближайшая
  const pos2 = mapReadingPosition(book, [chapters[1]], 'ch1', 0);
  assert.equal(pos2.chapterIndex, 0);
});

test('очистка применяется к черновику и сохраняет неизменённые абзацы', () => {
  const book = makeBook();
  book[0].sentences[0].rawText = '**Первое** предложение.';
  const draft = chaptersToDraft(book);
  const text = draft.map((c) => ({ id: c.id, title: c.title, paragraphs: c.paragraphs.map((p) => p.text) }));
  const plan = planCleanup(text, DEFAULT_CLEANUP_OPS);
  const applied = applyCleanupPlan(text, plan);
  const next = applyCleanupToDraft(draft, applied);
  assert.equal(next[0].paragraphs[0].text, 'Первое предложение. Второе предложение.');
  assert.strictEqual(next[1], draft[1], 'глава без изменений — тот же объект');
  assert.strictEqual(next[0].paragraphs[1], draft[0].paragraphs[1]);
});

test('поиск и замена: обычный режим, regex, защита', () => {
  const book = makeBook();
  const draft = chaptersToDraft(book);
  const m = buildMatcher({ find: 'предложение', replace: 'фраза', regex: false, caseSensitive: false });
  assert.ok(m.matcher);
  const found = findInDraft(draft, m.matcher!);
  assert.equal(found.total, 3);
  const r = replaceInDraft(draft, m.matcher!);
  assert.equal(r.replaced, 3);
  assert.equal(r.draft[0].paragraphs[0].text, 'Первое фраза. Второе фраза.');

  const rx = buildMatcher({ find: String.raw`(\p{L}+)ое`, replace: '$1ой', regex: true, caseSensitive: false });
  assert.ok(rx.matcher, rx.error);
  const r2 = replaceInDraft(draft, rx.matcher!);
  assert.equal(r2.draft[0].paragraphs[0].text, 'Первой предложение. Второй предложение.');

  assert.ok(buildMatcher({ find: '(a+)+$', replace: '', regex: true, caseSensitive: false }).error, 'ReDoS отклоняется');
  assert.ok(buildMatcher({ find: 'a*', replace: '', regex: true, caseSensitive: false }).error, 'пустое совпадение отклоняется');
  assert.ok(buildMatcher({ find: '(', replace: '', regex: true, caseSensitive: false }).error);
  const literal = buildMatcher({ find: '.', replace: '$&$&', regex: false, caseSensitive: true });
  const r3 = replaceInDraft(draft, literal.matcher!);
  assert.equal(r3.draft[0].paragraphs[0].text, 'Первое предложение$&$& Второе предложение$&$&');
});

test('ИИ-очистка: батчи, разбор ответа, ошибки', async () => {
  assert.deepEqual(parseJsonArray('```json\n["a","b"]\n```'), ['a', 'b']);
  assert.deepEqual(parseJsonArray('Вот: ["a"]'), ['a']);
  assert.equal(parseJsonArray('нет'), null);
  assert.deepEqual(splitIntoBatches(['aaa', 'bbb', 'ccc'], 7, 10), [[0, 1], [2]]);
  assert.ok(isReasonableEdit('привет мир', 'привет, мир'));
  assert.ok(!isReasonableEdit('длинный абзац текста который был', 'x'));

  const ok = async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(['Исправлено один', 'два']) }] } }] }), { status: 200 });
  const r = await aiCleanParagraphs(['Испорвлено один', 'два'], { apiKey: 'k', fetchImpl: ok as any });
  assert.deepEqual(r.results, ['Исправлено один', 'два']);
  assert.deepEqual(r.changed, [0]);

  const bad = async () => new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
  const e = await aiCleanParagraphs(['а', 'б'], { apiKey: 'k', fetchImpl: bad as any });
  assert.deepEqual(e.changed, []);
  assert.match(e.errors[0], /лимит/);

  const noKey = await aiCleanParagraphs(['а'], { apiKey: '' });
  assert.match(noKey.errors[0], /ключ/i);

  const wrongLen = async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '["только один"]' }] } }] }), { status: 200 });
  const w = await aiCleanParagraphs(['а', 'б'], { apiKey: 'k', fetchImpl: wrongLen as any });
  assert.deepEqual(w.changed, []);
  assert.match(w.errors[0], /формат/);
});

test('wordDiff: пословные различия', async () => {
  const { wordDiff } = await import('../diff');
  const parts = wordDiff('Это **важный** текст.', 'Это важный текст.');
  assert.equal(parts.filter((p) => p.kind === 'same').map((p) => p.text).join(''), 'Это важный текст.'.replace('важный', 'важный'));
  assert.ok(parts.some((p) => p.kind === 'del' && p.text.includes('**')));
  assert.deepEqual(wordDiff('abc', 'abc'), [{ kind: 'same', text: 'abc' }]);
});

test('разбиение главы с выбранного абзаца', async () => {
  const { splitChapterAt } = await import('../draftOps');
  const d = chaptersToDraft(makeBook());
  const next = splitChapterAt(d, 0, 1, 'Часть 2');
  assert.equal(next.length, 3);
  assert.equal(next[1].title, 'Часть 2');
  assert.equal(next[1].paragraphs.length, 1);
  assert.equal(splitChapterAt(d, 0, 0), d);
  const res = draftToChapters(next);
  assert.equal(res.chapters.length, 3);
});
