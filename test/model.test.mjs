import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectWords, createFlashSession, revealFlash, gradeFlash, nextFlashChunk,
  createQuiz, recordExposure, meaningKey, answerQuiz, nextQuestion, validSession,
  setFlashStudyState, getStudyLevel, getUnknownMeaningKeys,
} from '../public/js/model.js';

const sense = (name, suffix = '') => ({ ko: `${name} 뜻${suffix}`, en: `The meaning of ${name}${suffix}.`, wrongEn: `An unrelated meaning for ${name}${suffix}.` });
const sourceWord = (word, meanings = [sense(word)]) => ({ id: word, word, sourceMeaning: meanings.map((m) => m.ko).join(', '), meanings });
const unit = (words, title = '1과') => ({ bookTitle: '시험용 책', unitTitle: title, words });
const words = (count = 5) => collectWords([unit(Array.from({ length: count }, (_, i) => sourceWord(`word-${i}`)))]);
const grade = (session, known) => gradeFlash(revealFlash(session), known);
const roundTrip = (value) => JSON.parse(JSON.stringify(value));

test('same spelling across units merges all meaning pairs and preserves source context', () => {
  const shared = sense('run');
  const first = { ...sourceWord(' Run ', [{ ko: shared.ko, en: shared.en }]), sourceNote: '첫 번째 출처 메모' };
  const second = { ...sourceWord('ＲＵＮ', [shared, sense('run', '2')]), sourceNote: '두 번째 출처 메모' };
  const input = [unit([first]), unit([second], '2과')];
  const before = roundTrip(input);
  const result = collectWords(input);
  assert.equal(result.length, 1);
  assert.equal(result[0].key, 'run');
  assert.deepEqual(result[0].meanings, [shared, sense('run', '2')]);
  assert.deepEqual(result[0].origins, ['시험용 책 · 1과', '시험용 책 · 2과']);
  assert.deepEqual(result[0].notes, ['첫 번째 출처 메모', '두 번째 출처 메모']);
  assert.deepEqual(input, before, 'loading a session must not alter source data');
});

test('flashcards cannot be graded before reveal or advance before a chunk is mastered', () => {
  const session = createFlashSession(words(), 3, false);
  assert.equal(gradeFlash(session, true), session);
  assert.equal(gradeFlash(session, false), session);
  assert.equal(nextFlashChunk(session), session);
  const revealed = revealFlash(session);
  assert.equal(revealed.revealed, true);
  assert.equal(session.revealed, false);
  const next = gradeFlash(revealed, true);
  assert.equal(next.position, 1);
  assert.equal(next.mastered, 1);
  assert.equal(next.revealed, false);
  assert.equal(gradeFlash(next, true), next, 'a repeated Enter cannot grade the next hidden card');
});

test('flashcards repeat only unknown cards until mastered, then finish the shorter last chunk', () => {
  let session = createFlashSession(words(5), 3, false);
  assert.deepEqual(session.chunks.map((chunk) => chunk.length), [3, 2]);
  session = grade(session, true);
  session = grade(session, false);
  session = grade(session, false);
  assert.equal(session.round, 2);
  assert.equal(session.mastered, 1);
  assert.deepEqual(session.queue.map((word) => word.key), ['word-1', 'word-2']);
  session = grade(session, false);
  session = grade(session, true);
  assert.equal(session.round, 3);
  assert.deepEqual(session.queue.map((word) => word.key), ['word-1']);
  session = grade(session, true);
  assert.equal(session.phase, 'between');
  assert.equal(session.mastered, 3);
  assert.equal(gradeFlash(session, true), session);
  session = nextFlashChunk(session);
  assert.equal(session.round, 1);
  assert.equal(session.queue.length, 2);
  session = grade(grade(session, true), true);
  assert.equal(session.phase, 'complete');
  assert.equal(session.mastered, 5);
  assert.equal(session.attempts, 8);
  assert.equal(nextFlashChunk(session), session);
});

test('quiz uses one question per spelling and keeps O/X counts balanced', () => {
  const input = collectWords([unit([sourceWord('Same'), ...words(6)]), unit([sourceWord('same')], '2과')]);
  for (const count of [1, 2, 5, 6, 100]) {
    for (const random of [() => 0, () => 0.499, () => 0.999]) {
      const quiz = createQuiz(input, count, {}, random);
      assert.equal(quiz.total, Math.min(count, input.length));
      assert.equal(new Set(quiz.questions.map((question) => question.word.key)).size, quiz.total);
      const correct = quiz.questions.filter((question) => question.isCorrect).length;
      assert.ok(Math.abs(correct - (quiz.total - correct)) <= 1);
      for (const question of quiz.questions) {
        assert.equal(question.definition, question.isCorrect ? question.meaning.en : question.meaning.wrongEn);
      }
    }
  }
  const withoutWrongDefinition = collectWords([unit([sourceWord('plain', [{ ko: '단순한', en: 'Simple in appearance.' }])])]);
  assert.equal(createQuiz(withoutWrongDefinition, 1, {}, () => 0).questions[0].isCorrect, true);
});

test('quiz chooses the least exposed sense and counts only questions actually shown', () => {
  const input = collectWords([unit([sourceWord('poly', [sense('poly', '1'), sense('poly', '2'), sense('poly', '3')]), sourceWord('other')])]);
  let exposure = {};
  const seen = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = roundTrip(exposure);
    const quiz = createQuiz(input, 2, exposure, () => 0.999);
    assert.deepEqual(exposure, before, 'preparing an unseen quiz must not count exposure');
    const shown = quiz.questions[0];
    assert.equal(shown.word.key, 'poly');
    seen.push(shown.meaningIndex);
    exposure = recordExposure(exposure, shown);
    assert.equal(exposure.other, undefined, 'abandoning before question two must not count it');
  }
  assert.equal(new Set(seen).size, 3);
  assert.deepEqual(Object.values(exposure.poly), [1, 1, 1]);
  const uneven = { poly: { [meaningKey(input[0].meanings[0])]: 5, [meaningKey(input[0].meanings[1])]: 2 } };
  assert.equal(createQuiz(input.slice(0, 1), 1, uneven, () => 0.5).questions[0].meaningIndex, 2);
});

test('quiz requires an answer before moving on and records one answer per question', () => {
  let quiz = createQuiz(words(2), 2, {}, () => 0.5);
  assert.equal(nextQuestion(quiz), quiz);
  quiz = answerQuiz(quiz, quiz.questions[0].isCorrect);
  assert.equal(quiz.answers.length, 1);
  assert.equal(quiz.answers[0].correct, true);
  assert.equal(answerQuiz(quiz, false), quiz);
  quiz = nextQuestion(quiz);
  assert.equal(quiz.position, 1);
  assert.equal(quiz.revealed, false);
  quiz = answerQuiz(quiz, !quiz.questions[1].isCorrect);
  assert.equal(quiz.answers[1].correct, false);
  quiz = nextQuestion(quiz);
  assert.equal(quiz.phase, 'complete');
  assert.equal(quiz.answers.length, 2);
  assert.equal(nextQuestion(quiz), quiz);
});

test('session restoration accepts real saved states throughout both activities', () => {
  const check = (session) => assert.equal(validSession(roundTrip(session)), true);
  let flash = createFlashSession(words(3), 2, false);
  check(flash);
  flash = grade(flash, false);
  check(flash);
  flash = grade(flash, true);
  check(flash);
  flash = grade(flash, true);
  check(flash);
  flash = nextFlashChunk(flash);
  check(flash);
  flash = grade(flash, true);
  check(flash);
  let quiz = createQuiz(words(2), 2, {}, () => 0.5);
  check(quiz);
  quiz = answerQuiz(quiz, true);
  check(quiz);
  quiz = nextQuestion(quiz);
  check(quiz);
  quiz = nextQuestion(answerQuiz(quiz, false));
  check(quiz);
});

test('session restoration rejects malformed nested data without crashing app startup', () => {
  const flash = createFlashSession(words(2), 2, false);
  const quiz = createQuiz(words(2), 2, {}, () => 0.5);
  const invalid = [null, {}, { ...flash, total: 0 }, { ...flash, position: 4 }, { ...quiz, answers: [{}] }];
  const nullMeaning = roundTrip(flash);
  nullMeaning.chunks[0][0].meanings = [null];
  invalid.push(nullMeaning, { ...quiz, questions: [null, quiz.questions[1]] }, { ...quiz, revealed: true, answers: [null] });
  for (const snapshot of invalid) assert.equal(validSession(snapshot), false);
});

test('session restoration rejects impossible progress and inconsistent question data', () => {
  const flash = createFlashSession(words(2), 2, false);
  assert.equal(validSession({ ...flash, phase: 'complete', mastered: 0 }), false, 'an unstudied deck cannot be complete');
  assert.equal(validSession({ ...flash, mastered: 2, attempts: 0 }), false, 'mastered count cannot exceed attempts');
  const quiz = createQuiz(words(2), 2, {}, () => 0.5);
  assert.equal(validSession({ ...quiz, phase: 'complete' }), false, 'an unanswered quiz cannot be complete');
  const duplicated = roundTrip(quiz);
  duplicated.questions[1] = duplicated.questions[0];
  assert.equal(validSession(duplicated), false, 'a saved quiz must still have unique spellings');
});

test('merged word retains exact source references and the strongest level', () => {
  const first = { ...unit([{ ...sourceWord('same'), studyMark: 'review' }]), key: 'a/12.json', bookId: 'a', unitId: '12' };
  const second = { ...unit([{ ...sourceWord('SAME'), studyLevel: 'priority' }]), key: 'b/23.json', bookId: 'b', unitId: '23' };
  const [word] = collectWords([first, second]);
  assert.equal(word.studyLevel, 'priority');
  assert.equal(Object.hasOwn(word, 'studyMark'), false, 'Legacy fields do not leak into the merged card');
  assert.deepEqual(word.sourceRefs.map((ref) => [ref.unitKey, ref.bookId, ref.unitId, ref.wordId]), [['a/12.json', 'a', '12', 'same'], ['b/23.json', 'b', '23', 'SAME']]);
  assert.deepEqual(word.sourceRefs[0].meaningKeys, first.words[0].meanings.map(meaningKey));
});

test('levels and selected meanings merge across duplicate sources without reviving cleared legacy marks', () => {
  const shared = sense('bank');
  const river = sense('bank', 'river');
  const slope = sense('bank', 'slope');
  const input = [
    unit([{ ...sourceWord('bank', [shared, river]), studyMark: 'unsure', unknownMeaningKeys: [meaningKey(river)] }]),
    unit([{ ...sourceWord('BANK', [shared, slope]), studyMarks: ['unknown'], unknownMeaningKeys: [meaningKey(slope)] }], '2과'),
    unit([{ ...sourceWord('bank', [shared]), studyMark: 'unknown', studyMarks: [] }], '3과'),
  ];
  const before = roundTrip(input);
  const [merged] = collectWords(input);
  assert.equal(getStudyLevel(merged), 'unknown');
  assert.deepEqual(getUnknownMeaningKeys(merged), [meaningKey(river), meaningKey(slope)]);
  assert.deepEqual(merged.meanings, [shared, river, slope]);
  assert.deepEqual(input, before);
  assert.equal(getStudyLevel(input[2].words[0]), 'off');
  assert.equal(getStudyLevel({ studyMark: 'unsure' }), 'review');
  assert.equal(getStudyLevel({ studyMarks: ['unknown', 'review'] }), 'unknown', 'A word once marked both reads as 모름');
  assert.equal(getStudyLevel({ studyLevel: 'review', studyMarks: ['unknown'] }), 'review', 'studyLevel wins over older fields');
  assert.equal(getStudyLevel({ meanings: [shared, river], studyLevel: 'off', unknownMeaningKeys: [meaningKey(river)] }), 'review', 'An unknown meaning lifts 끔 to 복습 필요');
  assert.equal(getStudyLevel({ meanings: [shared], studyLevel: 'off', unknownMeaningKeys: [meaningKey(river)] }), 'off', 'A removed sense no longer lifts the level');
  assert.deepEqual(getUnknownMeaningKeys({ meanings: [shared], unknownMeaningKeys: [meaningKey(river), meaningKey(shared), meaningKey(shared)] }), [meaningKey(shared)]);
});

test('flash study level reaches every snapshot while preserving progress and legacy compatibility', () => {
  let flash = grade(createFlashSession(words(2), 2, false), false);
  const before = roundTrip(flash);
  const unknownMeaningKeys = [meaningKey(flash.chunks[0][0].meanings[0])];
  flash = setFlashStudyState(flash, 'word-0', { studyLevel: 'priority', unknownMeaningKeys });
  for (const card of [flash.chunks[0][0], flash.queue[0], flash.retry[0]]) {
    assert.equal(card.studyLevel, 'priority');
    assert.deepEqual(card.unknownMeaningKeys, unknownMeaningKeys);
    assert.equal(card.studyMarks, undefined);
  }
  assert.equal(flash.position, before.position);
  assert.equal(flash.revealed, before.revealed);
  assert.deepEqual(flash.retryCounts, before.retryCounts);
  assert.equal(before.retry[0].studyLevel, 'off');
  assert.equal(validSession(roundTrip(flash)), true);
  const changed = setFlashStudyState(flash, 'word-0', { studyLevel: 'off', unknownMeaningKeys });
  assert.equal(changed.retry[0].studyLevel, 'review', 'An unknown meaning keeps the card at 복습 필요 or above');
  assert.deepEqual(changed.retry[0].unknownMeaningKeys, unknownMeaningKeys);
  assert.equal(setFlashStudyState(changed, 'word-0', { studyLevel: 'unknown', unknownMeaningKeys: ['missing'] }), changed);
  assert.equal(setFlashStudyState(changed, 'word-0', { studyLevel: 'unsure', unknownMeaningKeys }), changed);
});

test('snapshot validation accepts old marks and rejects malformed canonical difficulty data', () => {
  const baseline = createFlashSession(words(1), 1, false);
  const legacy = roundTrip(baseline);
  delete legacy.chunks[0][0].studyLevel;
  delete legacy.chunks[0][0].unknownMeaningKeys;
  legacy.chunks[0][0].studyMark = 'unsure';
  assert.equal(validSession(legacy), true);
  legacy.chunks[0][0].studyMarks = ['unknown', 'review'];
  assert.equal(validSession(legacy), true, 'Snapshots saved with both old flags still restore');
  for (const fields of [
    { studyLevel: null }, { studyLevel: 'unsure' }, { studyLevel: ['unknown'] },
    { studyMarks: null }, { studyMarks: 'unknown' }, { studyMarks: ['unsure'] }, { studyMarks: ['review', 'review'] },
    { unknownMeaningKeys: null }, { unknownMeaningKeys: ['missing'] },
    { unknownMeaningKeys: Array(2).fill(meaningKey(baseline.chunks[0][0].meanings[0])) },
  ]) {
    const broken = roundTrip(baseline);
    Object.assign(broken.chunks[0][0], fields);
    assert.equal(validSession(broken), false, JSON.stringify(fields));
  }
});

test('flash per-word retry totals start at zero and count only unknown grades', () => {
  let flash = createFlashSession(words(2), 2, false);
  assert.ok(flash.sessionId);
  assert.ok(Date.parse(flash.startedAt));
  assert.deepEqual(flash.retryCounts, { 'word-0': 0, 'word-1': 0 });
  flash = grade(flash, true);
  flash = grade(flash, false);
  flash = grade(flash, false);
  flash = grade(flash, true);
  assert.equal(flash.phase, 'complete');
  assert.deepEqual(flash.retryCounts, { 'word-0': 0, 'word-1': 2 });
  assert.ok(Date.parse(flash.completedAt) >= Date.parse(flash.startedAt));
  assert.equal(validSession(flash), true);
  assert.equal(validSession({ ...flash, retryCounts: { 'word-0': 0, 'word-1': 0 } }), false);
});

test('legacy flashcard sessions remain valid without inventing missing retry totals', () => {
  let legacy = createFlashSession(words(1), 1, false);
  delete legacy.retryCounts;
  delete legacy.sessionId;
  delete legacy.startedAt;
  assert.equal(validSession(legacy), true);
  legacy = grade(grade(legacy, false), true);
  assert.equal(legacy.retryCounts, undefined);
  assert.equal(validSession(legacy), true);
});

test('study ranges include every stronger level and read old and lifted marks by their level', async () => {
  const { inStudyRange } = await import('../public/js/study-marks.js');
  const [one, two] = [sense('poly', '1'), sense('poly', '2')];
  const cards = {
    plain: { meanings: [one], studyLevel: 'off' },
    priority: { meanings: [one], studyLevel: 'priority' },
    unknown: { meanings: [one], studyLevel: 'unknown' },
    both: { meanings: [one], studyMarks: ['unknown', 'review'] },
    sense: { meanings: [one, two], studyLevel: 'off', unknownMeaningKeys: [meaningKey(two)] },
    review: { meanings: [one], studyLevel: 'review' },
    legacy: { meanings: [one], studyMark: 'unsure' },
    stale: { meanings: [one], studyLevel: 'off', unknownMeaningKeys: [meaningKey(two)] },
  };
  const pick = (level) => Object.keys(cards).filter((name) => inStudyRange(cards[name], { level }));
  assert.deepEqual(pick('all'), Object.keys(cards));
  assert.deepEqual(pick('priority'), ['priority']);
  assert.deepEqual(pick('unknown'), ['priority', 'unknown', 'both'], 'An old card with both flags counts as 모름');
  assert.deepEqual(pick('review'), ['priority', 'unknown', 'both', 'sense', 'review', 'legacy'], 'A single unknown sense lifts the card to 복습 필요; a removed sense does not');
});

test('AI ranges include every stronger level, and 모르는 의미만 keeps words with meanings to focus on', async () => {
  const { inStudyRange, getFocusMeaningKeys, rangeLabel, rangeTags } = await import('../public/js/study-marks.js');
  const [one, two] = [sense('poly', '1'), sense('poly', '2')];
  const cards = {
    plain: { meanings: [one, two], studyLevel: 'off' },
    reviewSingle: { meanings: [one], studyLevel: 'review' },
    unknownSingle: { meanings: [one], studyLevel: 'unknown' },
    prioritySingle: { meanings: [one], studyLevel: 'priority' },
    reviewEmpty: { meanings: [one, two], studyLevel: 'review' },
    reviewChosen: { meanings: [one, two], studyLevel: 'review', unknownMeaningKeys: [meaningKey(two)] },
    offChosen: { meanings: [one, two], studyLevel: 'off', unknownMeaningKeys: [meaningKey(one)] },
  };
  const pick = (range) => Object.keys(cards).filter((name) => inStudyRange(cards[name], range));
  assert.deepEqual(pick({ level: 'all' }), Object.keys(cards));
  assert.deepEqual(pick({ level: 'review' }), ['reviewSingle', 'unknownSingle', 'prioritySingle', 'reviewEmpty', 'reviewChosen', 'offChosen']);
  assert.deepEqual(pick({ level: 'unknown' }), ['unknownSingle', 'prioritySingle']);
  assert.deepEqual(pick({ level: 'priority' }), ['prioritySingle']);
  assert.deepEqual(pick({ level: 'all', unknownOnly: true }), ['unknownSingle', 'prioritySingle', 'reviewEmpty', 'reviewChosen', 'offChosen'],
    'A single meaning counts from 모름 up; several meanings count by the unknown ones');
  assert.deepEqual(getFocusMeaningKeys(cards.reviewChosen), [meaningKey(two)]);
  assert.deepEqual(getFocusMeaningKeys(cards.reviewEmpty), [meaningKey(one), meaningKey(two)]);
  assert.deepEqual(getFocusMeaningKeys(cards.reviewSingle), []);
  assert.equal(rangeLabel({ level: 'unknown', unknownOnly: true }), '모름 이상 · 모르는 의미만');
  assert.equal(rangeLabel({ level: 'all', unknownOnly: false }), '전체 단어');
  assert.deepEqual(rangeTags({ scope: 'marked' }), ['우선 학습·모름·복습 필요'], 'Exams saved with the exact-level scope keep their label');
});
