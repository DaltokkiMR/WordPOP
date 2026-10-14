import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RecordStore } from '../lib/records.mjs';
import { loadLibrary } from '../lib/library.mjs';
import { collectWords, createFlashSession, revealFlash, gradeFlash, nextFlashChunk } from '../public/js/model.js';
import { meaningKey } from '../public/js/study-marks.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'wordpop-records-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'word_list');
  const recordsRoot = path.join(root, 'records');
  for (const [bookId, unitId] of [['a', '12'], ['a', '13'], ['b', '23']]) {
    const data = { schemaVersion: 1, bookId, bookTitle: `${bookId}책`, unitId, unitTitle: `${unitId}과`, source: 'original.md',
      words: Array.from({ length: 10 }, (_, index) => ({ id: `${bookId}-${unitId}-${index}`, word: index === 0 ? 'shared' : `${bookId}${unitId}word${index}`, sourceMeaning: '원문 뜻',
        meanings: [{ ko: `${index}번째 뜻`, en: `The meaning of word ${index}.`, wrongEn: `A deliberately incorrect meaning ${index}.` }] })) };
    await mkdir(path.join(libraryRoot, bookId), { recursive: true });
    await writeFile(path.join(libraryRoot, bookId, `unit-${unitId}.json`), JSON.stringify(data));
  }
  const units = (await loadLibrary(libraryRoot)).books.flatMap((book) => book.units);
  const words = collectWords(units);
  return { root, libraryRoot, recordsRoot, units, words, store: new RecordStore({ libraryRoot, recordsRoot }) };
}

function completed(words, unknown = {}) {
  let flash = createFlashSession(words, 3, false);
  const remaining = { ...unknown };
  while (flash.phase !== 'complete') {
    if (flash.phase === 'between') { flash = nextFlashChunk(flash); continue; }
    const key = flash.queue[flash.position].key;
    const known = !(remaining[key] > 0);
    if (!known) remaining[key]--;
    flash = gradeFlash(revealFlash(flash), known);
  }
  return flash;
}

function examData(units) {
  const chosen = collectWords(units).slice(0, 10);
  return {
    selectedScope: [...new Set(units.map((unit) => unit.bookId))].map((bookId) => ({ bookId, unitIds: units.filter((unit) => unit.bookId === bookId).map((unit) => unit.unitId) })),
    title: '시험용 AI 시험', models: { collect: 'model-a', select: 'model-b', generate: 'model-c', verify: 'model-d' }, options: { count: 2, mode: 'weak', difficulty: 'medium' },
    questions: [0, 1].map((index) => ({ id: `q${index}`, kind: index ? 'incorrect' : 'correct', difficulty: index ? 'hard' : 'easy', intent: '뜻의 차이 확인', explanation: '정답의 이유', answerIndex: 0,
      options: chosen.slice(index * 5, index * 5 + 5).map((word, optionIndex) => ({ word, meaningIndex: 0,
        definition: (index ? optionIndex !== 0 : optionIndex === 0) ? word.meanings[0].en : word.meanings[0].wrongEn,
        isCorrect: index ? optionIndex !== 0 : optionIndex === 0, explanation: '보기별 해설' })) })),
  };
}

test('marks persist in every selected original without disturbing meanings or metadata', async (t) => {
  const { store, words, libraryRoot, units } = await fixture(t);
  const shared = words.find((word) => word.key === 'shared');
  await Promise.all(['unknown', 'unsure', 'review', null].map((mark) => store.setWordMark({ sourceRefs: shared.sourceRefs, mark })));
  for (const unit of units) {
    const raw = JSON.parse(await readFile(path.join(libraryRoot, unit.key), 'utf8'));
    assert.equal(raw.words[0].studyMark, undefined);
    assert.equal(raw.words[0].studyLevel, 'off');
    assert.deepEqual(raw.words[0].unknownMeaningKeys, []);
    assert.equal(raw.source, 'original.md');
    assert.deepEqual(raw.words[0].meanings, unit.words[0].meanings);
    assert.equal(raw.key, undefined, 'transport-only library fields must not leak into source JSON');
    assert.equal(raw.words[1].studyMark, undefined);
  }
  await assert.rejects(store.setWordMark({ sourceRefs: shared.sourceRefs, mark: 'bad' }), /표시/);
  await assert.rejects(store.setWordMark({ sourceRefs: [{ ...shared.sourceRefs[0], unitKey: '../escape.json' }], mark: null }), /출처/);
  await assert.rejects(store.setWordMark({ sourceRefs: [...shared.sourceRefs, ...words[1].sourceRefs], mark: 'unknown' }), /동일한 단어/);
});

test('a word holds one level, lifted to review by unknown senses, and selected senses project into matching sources', async (t) => {
  const { store, libraryRoot, units } = await fixture(t);
  const first = { ko: '첫째 추가 뜻', en: 'The first additional meaning.' };
  const second = { ko: '둘째 추가 뜻', en: 'The second additional meaning.' };
  for (const [index, unit] of units.entries()) {
    unit.words[0].customMetadata = { keep: true };
    unit.words[0].studyMark = 'unsure';
    unit.words[0].studyMarks = ['unknown', 'review'];
    if (index < 2) unit.words[0].meanings.push(index ? second : first);
    await writeFile(path.join(libraryRoot, unit.key), JSON.stringify(unit));
  }
  const shared = collectWords(await store.units()).find((word) => word.key === 'shared');
  assert.equal(shared.studyLevel, 'unknown', 'Both old flags read as 모름');
  const payload = { sourceRefs: shared.sourceRefs, studyLevel: 'priority', unknownMeaningKeys: [meaningKey(second), meaningKey(first)] };
  assert.deepEqual(await store.setWordMark(payload), { studyLevel: 'priority', unknownMeaningKeys: [meaningKey(first), meaningKey(second)] });
  for (const [index, unit] of units.entries()) {
    const raw = JSON.parse(await readFile(path.join(libraryRoot, unit.key), 'utf8'));
    assert.equal(raw.words[0].studyLevel, 'priority');
    assert.deepEqual(raw.words[0].unknownMeaningKeys, index < 2 ? [meaningKey(index ? second : first)] : []);
    assert.equal(raw.words[0].studyMark, undefined);
    assert.equal(raw.words[0].studyMarks, undefined);
    assert.deepEqual(raw.words[0].customMetadata, { keep: true });
    assert.deepEqual(raw.words[0].meanings, unit.words[0].meanings);
    assert.deepEqual(raw.words[1], unit.words[1]);
  }
  const merged = collectWords(await store.units()).find((word) => word.key === 'shared');
  assert.deepEqual(merged.unknownMeaningKeys, [meaningKey(first), meaningKey(second)]);
  await store.setWordMark({ ...payload, studyLevel: 'review' });
  assert.equal(collectWords(await store.units()).find((word) => word.key === 'shared').studyLevel, 'review');
  assert.deepEqual(await store.setWordMark({ ...payload, studyLevel: 'off', unknownMeaningKeys: [meaningKey(second)] }),
    { studyLevel: 'review', unknownMeaningKeys: [meaningKey(second)] }, 'An unknown sense keeps the word at 복습 필요');
  const onlySense = collectWords(await store.units()).find((word) => word.key === 'shared');
  assert.equal(onlySense.studyLevel, 'review');
  assert.deepEqual(onlySense.unknownMeaningKeys, [meaningKey(second)]);
  await store.setWordMark({ ...payload, studyLevel: 'off', unknownMeaningKeys: [] });
  assert.equal(collectWords(await store.units()).find((word) => word.key === 'shared').studyLevel, 'off');
});

test('legacy marks migrate on write, preserving sense choices and without modifying files during reads', async (t) => {
  const { store, libraryRoot, units } = await fixture(t);
  const source = units[0];
  const key = meaningKey(source.words[0].meanings[0]);
  source.words[0].studyMark = 'unsure';
  source.words[0].unknownMeaningKeys = [key];
  const filename = path.join(libraryRoot, source.key);
  const original = JSON.stringify(source);
  await writeFile(filename, original);
  const shared = collectWords(await store.units()).find((word) => word.key === 'shared');
  assert.equal(shared.studyLevel, 'review');
  assert.equal(await readFile(filename, 'utf8'), original);
  const response = await store.setWordMark({ sourceRefs: shared.sourceRefs, mark: 'unsure' });
  assert.deepEqual(response, { mark: 'review', studyLevel: 'review', unknownMeaningKeys: [key] });
  const saved = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(saved.words[0].studyMark, undefined);
  assert.equal(saved.words[0].studyLevel, 'review');
  assert.deepEqual(saved.words[0].unknownMeaningKeys, [key]);
  const other = JSON.parse(await readFile(path.join(libraryRoot, units[1].key), 'utf8'));
  assert.deepEqual(other.words[0].unknownMeaningKeys, [], 'legacy flag-only writes preserve each source sense selection');
});

test('study notes persist in every source, clear when blank and stay untouched by older mark-only saves', async (t) => {
  const { store, libraryRoot, units } = await fixture(t);
  const shared = collectWords(await store.units()).find((word) => word.key === 'shared');
  const base = { sourceRefs: shared.sourceRefs, studyLevel: 'review', unknownMeaningKeys: [] };
  assert.deepEqual(await store.setWordMark({ ...base, studyNote: '  share와 헷갈림  ' }), { studyLevel: 'review', unknownMeaningKeys: [], studyNote: 'share와 헷갈림' });
  for (const unit of units) {
    const raw = JSON.parse(await readFile(path.join(libraryRoot, unit.key), 'utf8'));
    assert.equal(raw.words[0].studyNote, 'share와 헷갈림');
    assert.equal(raw.words[1].studyNote, undefined);
  }
  await store.setWordMark({ ...base, studyLevel: 'off' });
  assert.equal(collectWords(await store.units()).find((word) => word.key === 'shared').studyNote, 'share와 헷갈림', 'A save without studyNote keeps the note');
  await store.setWordMark({ sourceRefs: shared.sourceRefs, mark: 'unknown' });
  assert.equal(collectWords(await store.units()).find((word) => word.key === 'shared').studyNote, 'share와 헷갈림');
  await store.setWordMark({ ...base, studyNote: '   ' });
  for (const unit of units) assert.equal(Object.hasOwn(JSON.parse(await readFile(path.join(libraryRoot, unit.key), 'utf8')).words[0], 'studyNote'), false);
});

test('repeated spellings merge distinct source notes and invalid stored notes are reported', async (t) => {
  const { store, libraryRoot, units } = await fixture(t);
  units[0].words[0].studyNote = '첫 교재 메모';
  units[1].words[0].studyNote = ' 첫 교재 메모 ';
  units[2].words[0].studyNote = '다른 교재 메모';
  units[2].words[1].studyNote = 42;
  for (const unit of units) await writeFile(path.join(libraryRoot, unit.key), JSON.stringify(unit));
  const library = await loadLibrary(libraryRoot);
  assert.match(library.warnings.join('\n'), /studyNote/);
  const merged = collectWords((await store.units())).find((word) => word.key === 'shared');
  assert.equal(merged.studyNote, '첫 교재 메모');
  units[2].words[1].studyNote = '';
  await writeFile(path.join(libraryRoot, units[2].key), JSON.stringify(units[2]));
  assert.equal(collectWords(await store.units()).find((word) => word.key === 'shared').studyNote, '첫 교재 메모\n다른 교재 메모');
});

test('invalid difficulty requests cannot partially update source files', async (t) => {
  const { store, words, libraryRoot, units } = await fixture(t);
  const shared = words.find((word) => word.key === 'shared');
  const sourceRefs = shared.sourceRefs;
  const key = meaningKey(shared.meanings[0]);
  const baseline = await Promise.all(units.map((unit) => readFile(path.join(libraryRoot, unit.key), 'utf8')));
  const invalid = [null, {}, { sourceRefs, studyLevel: 'off' }, { sourceRefs, unknownMeaningKeys: [] },
    { sourceRefs, studyLevel: null, unknownMeaningKeys: [] }, { sourceRefs, studyLevel: 'unsure', unknownMeaningKeys: [] },
    { sourceRefs, studyLevel: ['unknown'], unknownMeaningKeys: [] }, { sourceRefs, studyMarks: ['unknown'], unknownMeaningKeys: [] },
    { sourceRefs, studyLevel: 'off', unknownMeaningKeys: [key, key] }, { sourceRefs, studyLevel: 'off', unknownMeaningKeys: [0] },
    { sourceRefs, studyLevel: 'off', unknownMeaningKeys: ['missing'] }, { sourceRefs, studyLevel: 'off', unknownMeaningKeys: [], mark: null },
    { sourceRefs, studyLevel: 'off', unknownMeaningKeys: [], extra: true },
    { sourceRefs, studyLevel: 'off', unknownMeaningKeys: [], studyNote: 3 }, { sourceRefs, studyLevel: 'off', unknownMeaningKeys: [], studyNote: 'x'.repeat(1001) },
    { sourceRefs, mark: null, studyNote: '노트' },
  ];
  for (const request of invalid) await assert.rejects(store.setWordMark(request), (error) => error.status === 400);
  assert.deepEqual(await Promise.all(units.map((unit) => readFile(path.join(libraryRoot, unit.key), 'utf8'))), baseline);
});

test('flash saves per-source latest counts and preserves other words and units', async (t) => {
  const { store, units, recordsRoot } = await fixture(t);
  const selected = collectWords([units[0], units[2]]);
  const first = completed(selected, { shared: 2 });
  first.completedAt = '2026-09-21T01:00:00.000Z';
  await store.saveFlash(first);
  for (const unit of [units[0], units[2]]) {
    const record = JSON.parse(await readFile(path.join(recordsRoot, 'flashcard', unit.bookId, `unit-${unit.unitId}.json`), 'utf8'));
    assert.equal(record.words.length, 10);
    assert.equal(record.words[0].retryCount, 2);
    assert.equal(record.words[1].retryCount, 0);
  }
  const second = completed(collectWords([units[0], units[1]]).filter((word) => word.key === 'shared'), { shared: 1 });
  second.completedAt = '2026-09-21T02:00:00.000Z';
  await store.saveFlash(second);
  await store.saveFlash(first); // Refresh or delayed retry must not overwrite the newer session.
  const a12 = JSON.parse(await readFile(path.join(recordsRoot, 'flashcard/a/unit-12.json'), 'utf8'));
  const b23 = JSON.parse(await readFile(path.join(recordsRoot, 'flashcard/b/unit-23.json'), 'utf8'));
  assert.equal(a12.words.length, 10);
  assert.equal(a12.words[0].retryCount, 1);
  assert.equal(b23.words[0].retryCount, 2);
  const read = await store.readFlashRecords(collectWords(units));
  assert.equal(read.shared.retryCount, 2, 'use maximum of the latest records for each selected source');
  assert.equal(read.shared.sources.length, 3);
  assert.equal(read.a13word1.retryCount, null, 'missing history is distinct from zero');
  await assert.rejects(store.saveFlash(createFlashSession(selected, 3)), /완료/);
});

test('legacy completion can recover source refs but preserves unknown historical counts', async (t) => {
  const { store, units, recordsRoot } = await fixture(t);
  const legacy = completed(collectWords([units[0]]));
  delete legacy.retryCounts;
  delete legacy.sessionId;
  delete legacy.startedAt;
  for (const word of legacy.chunks.flat()) delete word.sourceRefs;
  const snapshot = JSON.parse(JSON.stringify(legacy));
  await store.saveFlash(snapshot);
  const record = JSON.parse(await readFile(path.join(recordsRoot, 'flashcard/a/unit-12.json'), 'utf8'));
  assert.equal(record.words[0].retryCount, null);
  assert.equal(record.words[0].startedAt, null);
  assert.ok(record.words[0].sessionId.startsWith('legacy-'));
});

test('settings are local, start every stage on Codex defaults and serialize partial stage updates', async (t) => {
  const { store } = await fixture(t);
  const codexDefault = { provider: 'codex', model: null };
  assert.deepEqual(await store.getSettings(), { stages: { collect: codexDefault, select: codexDefault, generate: codexDefault, verify: codexDefault } });
  await Promise.all([store.saveSettings({ stages: { collect: { provider: 'claude', model: 'claude-opus-5-5' } } }), store.saveSettings({ stages: { verify: { provider: 'copilot', model: 'gpt-5.6-terra' } } })]);
  assert.deepEqual((await store.getSettings()).stages, { collect: { provider: 'claude', model: 'claude-opus-5-5' }, select: codexDefault, generate: codexDefault, verify: { provider: 'copilot', model: 'gpt-5.6-terra' } });
  await assert.rejects(store.saveSettings({ stages: { invalid: { provider: 'codex', model: 'bad' } } }), /설정/);
});
test('legacy single-provider settings migrate to every stage without a read-time write', async (t) => {
  const { store, recordsRoot } = await fixture(t);
  await mkdir(recordsRoot);
  const filename = path.join(recordsRoot, 'settings.json');
  const legacy = JSON.stringify({ provider: 'copilot', models: { collect: 'stale' }, providerModels: { codex: { collect: 'codex-collect' }, copilot: { collect: 'copilot-collect', verify: 'copilot-verify' } } });
  await writeFile(filename, legacy);
  const migrated = await store.getSettings();
  assert.deepEqual(migrated.stages, { collect: { provider: 'copilot', model: 'copilot-collect' }, select: { provider: 'copilot', model: null }, generate: { provider: 'copilot', model: null }, verify: { provider: 'copilot', model: 'copilot-verify' } });
  assert.equal(await readFile(filename, 'utf8'), legacy);
  const oldest = JSON.stringify({ models: { collect: 'codex-collect', verify: 'codex-verify' } });
  await writeFile(filename, oldest);
  assert.deepEqual((await store.getSettings()).stages.verify, { provider: 'codex', model: 'codex-verify' }, 'The first format had only Codex models');
  const saved = await store.saveSettings({ stages: { generate: { provider: 'claude', model: 'claude-sonnet-5' } } });
  assert.deepEqual(saved.stages.collect, { provider: 'codex', model: 'codex-collect' });
  assert.deepEqual(saved.stages.generate, { provider: 'claude', model: 'claude-sonnet-5' });
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), saved, 'Saving writes only the per-stage format');
});
test('invalid stage writes are rejected and invalid stored stages fall back safely', async (t) => {
  const { store, recordsRoot } = await fixture(t);
  for (const input of [{ stages: { collect: { provider: 'unknown', model: 'x' } } }, { stages: { collect: { provider: null } } }, { stages: null }, { stages: {} },
    { stages: { collect: { provider: 'codex', model: ' ' } } }, { stages: { collect: { provider: 'codex', model: 'x', extra: 1 } } }, { provider: 'codex' }]) {
    await assert.rejects(store.saveSettings(input), /설정/);
  }
  await mkdir(recordsRoot);
  const filename = path.join(recordsRoot, 'settings.json');
  const raw = JSON.stringify({ provider: 'unknown', models: { collect: 'legacy-model' }, stages: { verify: { provider: 'claude', model: 'claude-sonnet-5' }, select: { provider: 'nope', model: 'x' } } });
  await writeFile(filename, raw);
  const { stages } = await store.getSettings();
  assert.deepEqual(stages.collect, { provider: 'codex', model: 'legacy-model' });
  assert.deepEqual(stages.select, { provider: 'codex', model: null }, 'A model saved for an unknown provider is not reused elsewhere');
  assert.deepEqual(stages.verify, { provider: 'claude', model: 'claude-sonnet-5' });
  assert.equal(await readFile(filename, 'utf8'), raw);
});
test('exam ids serialize, retain scope and models, save progress and grade immutable results', async (t) => {
  const { store, units, recordsRoot } = await fixture(t);
  const [first, second] = await Promise.all([store.createExam(examData(units)), store.createExam(examData(units))]);
  assert.notEqual(first.examId, second.examId);
  assert.ok(first.examId.endsWith('-001'));
  assert.ok(second.examId.endsWith('-002'));
  assert.deepEqual(first.selectedScope[0].unitIds, ['12', '13']);
  assert.equal(first.selectedScope[0].units[0].unitKey, 'a/unit-12.json');
  assert.equal(first.type, 'ai-test');
  assert.deepEqual(first.providers, { collect: 'codex', select: 'codex', generate: 'codex', verify: 'codex' });
  assert.equal(first.provider, undefined);
  await store.saveProgress(first.examId, { answers: [0, null], position: 1 });
  assert.deepEqual((await store.getExam(first.examId)).answers, [0, null]);
  await assert.rejects(store.submitExam(first.examId, { answers: [0, null] }), /모든 문항/);
  const done = await store.submitExam(first.examId, { answers: [0, 1] });
  assert.deepEqual(done.score, { correct: 1, total: 2 });
  assert.deepEqual(done.results[1], { questionId: 'q1', answer: 1, answerIndex: 0, correct: false, difficulty: 'hard', wordKeys: done.questions[1].options.map((option) => option.word.key) });
  assert.equal(done.summaryStatus, 'pending');
  assert.deepEqual((await store.submitExam(first.examId, { answers: [4, 4] })).answers, [0, 1]);
  assert.deepEqual((await store.saveProgress(first.examId, { answers: [4, 4], position: 0 })).answers, [0, 1]);
  const md = await readFile(path.join(recordsRoot, 'ai-test', `${first.examId}.md`), 'utf8');
  assert.match(md, /a책 · 12과 · 13과/);
  assert.match(md, /1\/2/);
  assert.match(md, /2번 — 오답 · 어려움/);
  assert.match(md, /verify: model-d \(ChatGPT \(Codex\)\)/);
  assert.equal((await store.listExams()).length, 2);
});

test('legacy single-provider exams read as that provider for every stage without rewriting the saved JSON', async (t) => {
  const { store, units, recordsRoot } = await fixture(t);
  const exam = await store.createExam(examData(units));
  delete exam.providers;
  const filename = path.join(recordsRoot, 'ai-test', `${exam.examId}.json`);
  for (const [provider, expected] of [[undefined, 'codex'], ['claude', 'claude']]) {
    const raw = JSON.stringify(provider ? { ...exam, provider } : exam);
    await writeFile(filename, raw);
    assert.deepEqual((await store.getExam(exam.examId)).providers, { collect: expected, select: expected, generate: expected, verify: expected });
    assert.equal((await store.listExams())[0].providers.verify, expected);
    assert.equal(await readFile(filename, 'utf8'), raw);
  }
  await writeFile(filename, JSON.stringify({ ...exam, providers: { collect: 'codex' } }));
  await assert.rejects(store.getExam(exam.examId), (error) => error.status === 500);
});
test('deleting an exam removes its paired files and history without touching other exams', async (t) => {
  const { store, units, words, recordsRoot } = await fixture(t);
  const kept = await store.createExam(examData(units));
  const removed = await store.createExam(examData(units));
  await store.submitExam(removed.examId, { answers: [0, 0] });
  await store.submitExam(kept.examId, { answers: [0, 0] });
  const folder = path.join(recordsRoot, 'ai-test');
  assert.deepEqual((await readdir(folder)).sort(), [kept, removed].flatMap((exam) => [`${exam.examId}.json`, `${exam.examId}.md`]).sort());
  assert.deepEqual(await store.deleteExam(removed.examId), { examId: removed.examId, deleted: true });
  assert.deepEqual((await readdir(folder)).sort(), [`${kept.examId}.json`, `${kept.examId}.md`]);
  assert.deepEqual((await store.listExams()).map((exam) => exam.examId), [kept.examId]);
  assert.deepEqual((await store.relatedHistory(units, words)).map((exam) => exam.examId), [kept.examId]);
  await assert.rejects(store.deleteExam(removed.examId), (error) => error.status === 404);
  await assert.rejects(store.deleteExam('../settings'), (error) => error.status === 400);
  const unsubmitted = await store.createExam(examData(units));
  await store.deleteExam(unsubmitted.examId);
  assert.deepEqual((await readdir(folder)).sort(), [`${kept.examId}.json`, `${kept.examId}.md`], 'An exam without Markdown deletes cleanly');
});

test('Mixed-provider exam JSON and Markdown keep each stage provider and model through settings changes and summaries', async (t) => {
  const { store, units, recordsRoot } = await fixture(t);
  const models = { collect: 'copilot-a', select: 'copilot-b', generate: 'copilot-c', verify: 'copilot-d' };
  const providers = { collect: 'copilot', select: 'claude', generate: 'codex', verify: 'copilot' };
  const exam = await store.createExam({ ...examData(units), providers, models });
  await store.saveSettings({ stages: { collect: { provider: 'codex', model: 'new-codex-model' } } });
  await store.submitExam(exam.examId, { answers: [0, 1] });
  await store.markSummaryFailed(exam.examId, 'temporary failure');
  const summary = { strengths: ['강점'], weaknesses: ['약점'], recommendations: ['복습'] };
  const completed = await store.saveSummary(exam.examId, summary);
  assert.deepEqual(completed.providers, providers);
  assert.deepEqual(completed.models, models);
  const filename = path.join(recordsRoot, 'ai-test', exam.examId);
  const saved = JSON.parse(await readFile(`${filename}.json`, 'utf8'));
  assert.deepEqual(saved.providers, providers);
  assert.equal(saved.provider, undefined);
  assert.deepEqual(saved.models, models);
  const markdown = await readFile(`${filename}.md`, 'utf8');
  assert.match(markdown, /collect: copilot-a \(GitHub Copilot\)/);
  assert.match(markdown, /select: copilot-b \(Claude \(Claude Code\)\)/);
  assert.match(markdown, /generate: copilot-c \(ChatGPT \(Codex\)\)/);
  assert.doesNotMatch(markdown, /new-codex-model/);
  const history = await store.relatedHistory(units, collectWords(units));
  assert.deepEqual(history[0].providers, providers);
  assert.match(history[0].markdown, /GitHub Copilot/);
  await assert.rejects(store.createExam({ ...examData(units), provider: 'unknown' }), /AI 연결 서비스/);
  await assert.rejects(store.createExam({ ...examData(units), providers: { ...providers, verify: 'unknown' } }), /AI 연결 서비스/);
  await assert.rejects(store.createExam({ ...examData(units), provider: null }), /AI 연결 서비스/);
  assert.equal((await store.listExams()).length, 1);
});

test('summary failure preserves scoring, recovery updates paired Markdown and related history', async (t) => {
  const { store, units, recordsRoot } = await fixture(t);
  const exam = await store.createExam(examData([units[0]]));
  await store.submitExam(exam.examId, { answers: [0, 1] });
  await store.markSummaryFailed(exam.examId, '다시 연결해 주세요.');
  assert.equal((await store.getExam(exam.examId)).score.correct, 1);
  const summary = { strengths: ['쉬운 뜻 구분'], weaknesses: ['복수 의미 확인 필요'], recommendations: ['원문 뜻 다시 보기'] };
  await store.saveSummary(exam.examId, summary);
  const history = await store.relatedHistory([units[0]], collectWords([units[0]]));
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].summary, summary);
  assert.match(history[0].markdown, /복수 의미 확인 필요/);
  assert.equal(history[0].results[1].options.length, 5);
  const unrelatedWords = collectWords([units[1]]).filter((word) => word.key !== 'shared');
  assert.equal((await store.relatedHistory([units[1]], unrelatedWords)).length, 0);
  assert.equal((await store.relatedHistory([units[1]], collectWords([units[1]]))).length, 1, 'same actual word may connect tests from different units');
  await store.markSummaryFailed(exam.examId, 'late failure');
  assert.equal((await store.getExam(exam.examId)).summaryStatus, 'complete');
  assert.match(await readFile(path.join(recordsRoot, 'ai-test', `${exam.examId}.md`), 'utf8'), /강점/);
});

test('invalid exam shape, repeated spellings and invalid scope never create records', async (t) => {
  const { store, units } = await fixture(t);
  const duplicated = examData(units);
  duplicated.questions[1].options[0].word = duplicated.questions[0].options[0].word;
  await assert.rejects(store.createExam(duplicated), /중복/);
  const multiple = examData(units);
  multiple.questions[0].options[1].isCorrect = true;
  await assert.rejects(store.createExam(multiple), /정답이 하나/);
  const outside = examData(units);
  outside.selectedScope = [{ bookId: 'b', unitIds: ['23'] }];
  await assert.rejects(store.createExam(outside), /범위 밖/);
  await assert.rejects(store.getExam('../../bad'), /시험 번호/);
  assert.deepEqual(await store.listExams(), []);
});

test('record folders cannot redirect writes through symbolic links', async (t) => {
  const { store, root, recordsRoot, units } = await fixture(t);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await mkdir(recordsRoot);
  await symlink(outside, path.join(recordsRoot, 'flashcard'));
  await assert.rejects(store.saveFlash(completed(collectWords([units[0]]))), /연결 파일/);
  assert.deepEqual(await readdir(outside), []);
});

test('temporary Markdown failure after JSON summary commit repairs without losing the completed summary', async (t) => {
  const { store, units, recordsRoot } = await fixture(t);
  const exam = await store.createExam(examData([units[0]]));
  await store.submitExam(exam.examId, { answers: [0, 1] });
  const writeMarkdown = store.writeMarkdown.bind(store);
  let failOnce = true;
  store.writeMarkdown = async (value) => {
    if (failOnce) { failOnce = false; throw new Error('temporary disk failure'); }
    return writeMarkdown(value);
  };
  const summary = { strengths: ['저장된 강점'], weaknesses: [], recommendations: [] };
  await assert.rejects(store.saveSummary(exam.examId, summary), /temporary disk failure/);
  assert.equal((await store.getExam(exam.examId)).summaryStatus, 'complete');
  const repaired = await store.markSummaryFailed(exam.examId, 'temporary disk failure');
  assert.equal(repaired.summaryStatus, 'complete');
  assert.deepEqual(repaired.summary, summary);
  assert.match(await readFile(path.join(recordsRoot, 'ai-test', `${exam.examId}.md`), 'utf8'), /저장된 강점/);
});

test('repair and related history recover missing or stale Markdown from fresh canonical JSON', async (t) => {
  const { store, units, recordsRoot } = await fixture(t);
  const exam = await store.createExam(examData([units[0]]));
  await store.submitExam(exam.examId, { answers: [0, 1] });
  await store.saveSummary(exam.examId, { strengths: [], weaknesses: ['최신 약점'], recommendations: [] });
  const filename = path.join(recordsRoot, 'ai-test', `${exam.examId}.md`);
  await rm(filename);
  const repaired = await store.repairExamMarkdown(exam.examId);
  assert.equal(repaired.summaryStatus, 'complete');
  assert.match(await readFile(filename, 'utf8'), /최신 약점/);
  let writes = 0;
  const atomic = store.atomic.bind(store);
  store.atomic = async (...args) => { writes++; return atomic(...args); };
  await store.repairExamMarkdown(exam.examId);
  assert.equal(writes, 0, 'already consistent pairs are not rewritten');
  await writeFile(filename, 'An outdated summary from before interruption.');
  const history = await store.relatedHistory([units[0]], collectWords([units[0]]));
  assert.match(history[0].markdown, /최신 약점/);
  assert.equal(await readFile(filename, 'utf8'), history[0].markdown);
  const pending = await store.createExam(examData([units[0]]));
  assert.equal((await store.repairExamMarkdown(pending.examId)).status, 'studying');
  await assert.rejects(readFile(path.join(recordsRoot, 'ai-test', `${pending.examId}.md`)), { code: 'ENOENT' });
});

function oxExamData(units) {
  const chosen = collectWords(units).slice(1, 4);
  return {
    selectedScope: [{ bookId: 'a', unitIds: ['12'] }], models: { collect: 'model-a', select: 'model-b', generate: 'model-c', verify: 'model-d' },
    options: { format: 'ox', scope: 'unknown', count: 3, mode: 'weak', difficulty: 'medium' },
    questions: chosen.map((word, i) => ({ id: `q${i + 1}`, difficulty: 'easy', intent: '혼동 확인', ...(i === 1 ? { confusionTarget: 'adopt와 adapt의 혼동' } : {}), word, meaningIndex: 0,
      definition: i === 1 ? word.meanings[0].wrongEn : word.meanings[0].en, isCorrect: i !== 1, explanation: `해설 ${i + 1}` })),
  };
}

test('O/X exams store one word per question, grade O/X answers and write their own Markdown and history', async (t) => {
  const { store, units, recordsRoot } = await fixture(t);
  const exam = await store.createExam(oxExamData(units.slice(0, 1)));
  assert.equal(exam.options.format, 'ox');
  await assert.rejects(store.saveProgress(exam.examId, { answers: [0, null, null], position: 0 }), /답안 형식/);
  assert.deepEqual((await store.saveProgress(exam.examId, { answers: [true, null, null], position: 1 })).answers, [true, null, null]);
  await assert.rejects(store.submitExam(exam.examId, { answers: [true, null, false] }), /모든 문항/);
  const done = await store.submitExam(exam.examId, { answers: [true, true, false] });
  assert.deepEqual(done.score, { correct: 1, total: 3 });
  assert.deepEqual(done.results[1], { questionId: 'q2', answer: true, expected: false, correct: false, difficulty: 'easy', wordKeys: [exam.questions[1].word.key] });
  assert.equal(done.results[2].correct, false, 'Rejecting a genuine meaning is also wrong');
  const md = await readFile(path.join(recordsRoot, 'ai-test', `${exam.examId}.md`), 'utf8');
  assert.match(md, /^# AI 영영풀이 O\/X 시험 /);
  assert.match(md, /- 출제 범위: 모름/);
  assert.match(md, /- 출제 모드: 헷갈리는 단어 위주/);
  assert.match(md, /### 2번 — 오답 · 쉬움\n\n\*\*a12word2\*\* — A deliberately incorrect meaning 2\./);
  assert.match(md, /- 내 답: O \/ 정답: X\n- 출제 의도: 혼동 확인\n- 확인한 혼동: adopt와 adapt의 혼동\n- 원래 뜻: 2번째 뜻 \/ The meaning of word 2\./);
  assert.match(md, /O\/X 문항의 오답은 출제한 뜻에 대한 근거/);
  const [history] = await store.relatedHistory(units.slice(0, 1), collectWords(units.slice(0, 1)));
  assert.equal(history.format, 'ox');
  assert.deepEqual({ ...history.results[1], sourceRefs: undefined }, { questionId: 'q2', answer: true, expected: false, correct: false, difficulty: 'easy', wordKeys: [exam.questions[1].word.key], sourceRefs: undefined,
    format: 'ox', word: 'a12word2', key: 'a12word2', meaningIndex: 0, definition: 'A deliberately incorrect meaning 2.', isCorrect: false, confusionTarget: 'adopt와 adapt의 혼동', intent: '혼동 확인', explanation: '해설 2' });
  assert.equal((await store.relatedHistory(units.slice(2), collectWords(units.slice(2)))).length, 0);
});

test('O/X exams reject five-option shapes, repeated words and words outside the scope', async (t) => {
  const { store, units } = await fixture(t);
  const data = oxExamData(units.slice(0, 1));
  await assert.rejects(store.createExam({ ...data, questions: data.questions.map((question) => ({ ...question, options: [] })) }), /형식/);
  await assert.rejects(store.createExam({ ...data, questions: [data.questions[0], { ...data.questions[1], word: data.questions[0].word }] }), /중복/);
  await assert.rejects(store.createExam({ ...data, questions: data.questions.map((question) => ({ ...question, isCorrect: 'O' })) }), /형식/);
  const outside = oxExamData(units.slice(2));
  await assert.rejects(store.createExam({ ...outside, selectedScope: data.selectedScope }), /선택 범위 밖/);
  assert.deepEqual(await store.listExams(), []);
});
