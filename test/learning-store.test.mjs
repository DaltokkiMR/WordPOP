import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { collectWords, createFlashSession, revealFlash, gradeFlash, createQuiz, answerQuiz, nextQuestion } from '../public/js/model.js';
import { loadLearningState, saveLearningState, createExam, createFlashcard, saveFlashcard, removeFlashcard, removeExam, saveExam } from '../public/js/learning-store.js';

const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
};
beforeEach(() => stored.clear());

const words = collectWords([{
  bookTitle: '교재', unitTitle: '1과', words: ['apple', 'banana'].map((word) => ({
    id: word, word, meanings: [{ ko: `${word} 뜻`, en: `A meaning of ${word}.`, wrongEn: 'An unrelated meaning.' }],
  })),
}]);
const flash = () => createFlashSession(words, 2, false);
const quiz = () => createQuiz(words, 2, {}, () => 0.5);
const completeQuiz = () => {
  let session = quiz();
  while (session.phase !== 'complete') session = nextQuestion(answerQuiz(session, true));
  return session;
};
const record = (id, session = quiz(), now = '2026-09-21T00:00:00.000Z') => createExam(session, '영영풀이 O/X', { id, now });
const setStored = (key, value) => stored.set(`wordpop.v1.${key}`, JSON.stringify(value));
const deck = (id, session = flash(), now = '2026-09-21T00:00:00.000Z') => createFlashcard(session, undefined, { id, now });
const finish = (session) => { let complete = session; for (let i = 0; i < words.length; i++) complete = gradeFlash(revealFlash(complete), true); return complete; };
const empty = { version: 2, flashcards: [], exams: [] };

test('several unfinished flashcard decks and exams retain independent progress after reload', () => {
  const first = deck('first', gradeFlash(revealFlash(flash()), true));
  const second = deck('second', flash(), '2026-09-22T00:00:00.000Z');
  let state = saveFlashcard(saveFlashcard(loadLearningState(), first), second);
  state = saveExam(state, record('exam', answerQuiz(quiz(), true)));
  saveLearningState(state);
  const restored = loadLearningState();
  assert.deepEqual(restored.flashcards.map((item) => item.id), ['second', 'first'], 'newest deck first');
  assert.equal(restored.flashcards[1].session.position, 1);
  assert.equal(restored.flashcards[0].session.position, 0);
  assert.equal(restored.flashcards[0].title, '플래시카드 · 1과');
  assert.deepEqual(restored.exams.map((exam) => exam.id), ['exam']);
  const advanced = { ...second, updatedAt: '2026-09-23T00:00:00.000Z', session: gradeFlash(revealFlash(second.session), false) };
  const updated = saveFlashcard(restored, advanced);
  assert.deepEqual(updated.flashcards.map((item) => [item.id, item.session.attempts]), [['second', 1], ['first', 1]], 'updating one deck keeps its place and the other deck');
});

test('a completed deck leaves the list while other decks and exams stay intact', () => {
  const exam = record('saved');
  const initial = saveExam(saveFlashcard(saveFlashcard(loadLearningState(), deck('a')), deck('b')), exam);
  const target = initial.flashcards.find((item) => item.id === 'a');
  const updated = saveFlashcard(initial, { ...target, session: finish(target.session) });
  saveLearningState(updated);
  assert.deepEqual(loadLearningState().flashcards.map((item) => item.id), ['b']);
  assert.deepEqual(loadLearningState().exams, [exam]);
  assert.equal(target.session.phase, 'studying', 'the previous state is not mutated');
  assert.deepEqual(removeFlashcard(updated, 'b').flashcards, []);
  assert.deepEqual(removeExam(updated, 'saved').flashcards.map((item) => item.id), ['b']);
});

test('the version 1 single flashcard slot migrates once into the deck list', () => {
  const slot = gradeFlash(revealFlash(flash()), true);
  const exam = record('kept');
  setStored('learning', { version: 1, flash: slot, exams: [exam] });
  const migrated = loadLearningState();
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.flashcards.map((item) => [item.id, item.createdAt, item.session]), [[`flash-${slot.sessionId}`, slot.startedAt, slot]]);
  assert.deepEqual(migrated.exams, [exam]);
  assert.equal(JSON.parse(stored.get('wordpop.v1.learning')).version, 2, 'the migrated form is written back');
  assert.deepEqual(loadLearningState(), migrated, 'reading again does not duplicate the deck');
  setStored('learning', { version: 1, flash: null, exams: [] });
  assert.deepEqual(loadLearningState(), empty);
});

test('completed exams can be restored and updates replace only the matching ID', () => {
  const first = record('first');
  const second = record('second', quiz(), '2026-09-22T00:00:00.000Z');
  const initial = saveExam(saveExam(saveFlashcard(loadLearningState(), deck('deck')), first), second);
  const finished = { ...first, updatedAt: '2026-09-23T00:00:00.000Z', session: completeQuiz() };
  saveLearningState(saveExam(initial, finished));
  const restored = loadLearningState();
  assert.equal(restored.exams.length, 2);
  assert.deepEqual(restored.exams.map((exam) => exam.id), ['second', 'first'], 'order follows creation time, not last answer time');
  assert.equal(restored.exams[1].session.phase, 'complete');
  assert.deepEqual(restored.flashcards, initial.flashcards);
  assert.equal(initial.exams[1].session.phase, 'studying');
});

test('legacy flash migrates once and never reappears after completion', () => {
  const legacy = flash();
  delete legacy.sessionId;
  delete legacy.startedAt;
  delete legacy.retryCounts;
  setStored('session', legacy);
  const migrated = loadLearningState();
  assert.deepEqual(migrated.flashcards.map((item) => [item.id, item.session]), [['flash-legacy', legacy]]);
  assert.ok(stored.has('wordpop.v1.session'), 'migration preserves the original backup');
  const [saved] = migrated.flashcards;
  saveLearningState(saveFlashcard(migrated, { ...saved, session: finish(saved.session) }));
  assert.deepEqual(loadLearningState(), empty);
});

test('legacy quizzes migrate in both studying and complete phases without duplicate records', () => {
  for (const session of [quiz(), completeQuiz()]) {
    stored.clear();
    setStored('session', session);
    const migrated = loadLearningState();
    assert.equal(migrated.exams.length, 1);
    assert.equal(migrated.exams[0].title, '영영풀이 O/X');
    assert.deepEqual(migrated.exams[0].session, session);
    assert.deepEqual(loadLearningState(), migrated);
  }
});

test('corrupt entries are isolated while valid decks and exams remain usable', () => {
  const valid = record('usable');
  const newer = { ...valid, updatedAt: '2026-09-22T00:00:00.000Z', session: completeQuiz() };
  const good = deck('good');
  setStored('learning', {
    version: 2, flashcards: [null, { ...good, id: 'broken', session: { ...flash(), chunks: [null] } }, { ...good, id: 'quiz-as-deck', session: quiz() }, good, { ...good, id: 'done', session: finish(flash()) }],
    exams: [null, {}, valid, { ...valid, id: 'broken', session: { ...quiz(), questions: [null] } },
      { ...valid, id: 'future', type: 'future-test' }, { ...valid, id: 'bad-date', createdAt: null }, newer],
  });
  assert.deepEqual(loadLearningState(), { version: 2, flashcards: [good], exams: [newer] });
  for (const malformed of [false, [], {}, { version: 2, flashcards: null, exams: null }, { version: 3, flashcards: [good], exams: [] }]) {
    setStored('learning', malformed);
    assert.deepEqual(loadLearningState(), empty);
  }
});

test('absent, invalid, and completed legacy flash sessions leave no deck', () => {
  for (const legacy of [null, {}, finish(flash())]) {
    stored.clear();
    setStored('session', legacy);
    assert.deepEqual(loadLearningState(), empty);
    assert.ok(stored.has('wordpop.v1.learning'), 'even an empty migration writes a version marker');
  }
});

test('new records receive distinct IDs and reject incompatible or malformed activities', () => {
  const first = createExam(quiz());
  const second = createExam(quiz());
  assert.notEqual(first.id, second.id);
  assert.notEqual(createFlashcard(flash()).id, createFlashcard(flash()).id);
  assert.equal(new Date(first.createdAt).toISOString(), first.createdAt);
  assert.throws(() => createExam(flash()), TypeError);
  assert.throws(() => createFlashcard(quiz()), TypeError);
  assert.throws(() => createFlashcard(null), TypeError);
  assert.throws(() => saveFlashcard(loadLearningState(), { ...deck('x'), session: quiz() }), TypeError);
  assert.throws(() => saveExam(loadLearningState(), { ...first, session: flash() }), TypeError);
  assert.throws(() => saveExam(loadLearningState(), null), TypeError);
  assert.deepEqual(loadLearningState(), empty);
});
