import { meaningKey, getStudyLevel, getUnknownMeaningKeys, isStudyLevel, isStudyMarks, isUnknownMeaningKeys, getStudyNote, mergeStudyNotes, strongestLevel, withMeaningFloor } from './study-marks.js';
export { studyLevels, meaningKey, getStudyLevel, getUnknownMeaningKeys } from './study-marks.js';
export const wordKey = (word) => word.normalize('NFKC').trim().toLocaleLowerCase('en');
// Older snapshots may still carry a single studyMark.
const legacyMarks = ['unknown', 'unsure', 'review'];
const boundedInt = (value, max) => Math.max(1, Math.min(max, Math.floor(Number(value) || 1)));

export function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Merge repeated spellings across books without discarding any sense. */
export function collectWords(units) {
  const words = new Map();
  for (const unit of units) {
    for (const item of unit.words) {
      const key = wordKey(item.word);
      const { studyMark, studyMarks, ...fields } = item;
      if (!words.has(key)) words.set(key, { ...fields, key, meanings: [], origins: [], notes: [], sourceRefs: [], studyLevel: 'off', unknownMeaningKeys: [], studyNote: '' });
      const word = words.get(key);
      word.origins.push(`${unit.bookTitle} · ${unit.unitTitle}`);
      word.sourceRefs.push({
        unitKey: unit.key ?? null, bookId: unit.bookId ?? null, bookTitle: unit.bookTitle ?? null,
        unitId: unit.unitId ?? null, unitTitle: unit.unitTitle ?? null, wordId: item.id ?? null,
        meaningKeys: item.meanings.map(meaningKey),
      });
      word.studyLevel = strongestLevel(word.studyLevel, getStudyLevel(item));
      word.unknownMeaningKeys = [...new Set([...word.unknownMeaningKeys, ...getUnknownMeaningKeys(item)])];
      word.studyNote = mergeStudyNotes([word.studyNote, getStudyNote(item)]);
      if (item.sourceNote && !word.notes.includes(item.sourceNote)) word.notes.push(item.sourceNote);
      for (const meaning of item.meanings) {
        const existing = word.meanings.find((m) => meaningKey(m) === meaningKey(meaning));
        if (!existing) word.meanings.push({ ...meaning });
        else if (!existing.wrongEn && meaning.wrongEn) existing.wrongEn = meaning.wrongEn;
      }
    }
  }
  return [...words.values()];
}

export function createFlashSession(words, chunkSize, randomize = true, random = Math.random) {
  if (!words.length) throw new Error('학습할 단어를 선택해 주세요.');
  const deck = randomize ? shuffle(words, random) : [...words];
  const size = boundedInt(chunkSize, deck.length);
  const chunks = [];
  for (let i = 0; i < deck.length; i += size) chunks.push(deck.slice(i, i + size));
  return {
    type: 'flash', phase: 'studying', chunks, chunkIndex: 0,
    queue: chunks[0], position: 0, retry: [], round: 1,
    revealed: false, mastered: 0, attempts: 0, total: deck.length,
    sessionId: globalThis.crypto?.randomUUID?.() ?? `flash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    startedAt: new Date().toISOString(),
    retryCounts: Object.fromEntries(deck.map((word) => [word.key, 0])),
  };
}

/** Replace the study level and unknown meanings on every card snapshot without advancing the deck. */
export function setFlashStudyState(session, key, state) {
  if (session.type !== 'flash' || !state || !isStudyLevel(state.studyLevel)) return session;
  const card = session.chunks.flat().find((word) => word.key === key);
  if (!card || !isUnknownMeaningKeys(state.unknownMeaningKeys, card.meanings)) return session;
  const update = (word) => {
    if (word.key !== key) return word;
    const { studyMark, studyMarks, ...rest } = word;
    const unknownMeaningKeys = getUnknownMeaningKeys({ ...state, meanings: word.meanings });
    return { ...rest, studyLevel: withMeaningFloor(state.studyLevel, unknownMeaningKeys.length), unknownMeaningKeys };
  };
  return { ...session, chunks: session.chunks.map((chunk) => chunk.map(update)), queue: session.queue.map(update), retry: session.retry.map(update) };
}

export function revealFlash(session) {
  if (session.phase !== 'studying') return session;
  return { ...session, revealed: true };
}

export function gradeFlash(session, known) {
  if (session.phase !== 'studying' || !session.revealed) return session;
  const retry = known ? session.retry : [...session.retry, session.queue[session.position]];
  const next = {
    ...session, position: session.position + 1, retry, revealed: false,
    mastered: session.mastered + Number(known), attempts: session.attempts + 1,
  };
  // An older saved session has no trustworthy per-word totals. Keep that absence.
  if (session.retryCounts) next.retryCounts = { ...session.retryCounts,
    [session.queue[session.position].key]: session.retryCounts[session.queue[session.position].key] + Number(!known),
  };
  if (next.position < session.queue.length) return next;
  if (retry.length) return { ...next, queue: retry, retry: [], position: 0, round: session.round + 1 };
  const phase = session.chunkIndex + 1 < session.chunks.length ? 'between' : 'complete';
  return { ...next, phase, ...(phase === 'complete' ? { completedAt: new Date().toISOString() } : {}) };
}

export function nextFlashChunk(session) {
  if (session.phase !== 'between') return session;
  const index = session.chunkIndex + 1;
  return { ...session, phase: 'studying', chunkIndex: index, queue: session.chunks[index], position: 0, retry: [], round: 1, revealed: false };
}

/** One spelling per test; least-exposed senses rotate across tests. */
export function createQuiz(words, count, exposure = {}, random = Math.random) {
  if (!words.length) throw new Error('시험 볼 단어를 선택해 주세요.');
  const chosen = shuffle(words, random).slice(0, boundedInt(count, words.length));
  const questions = chosen.map((word) => {
    const counts = word.meanings.map((m) => Math.max(0, Number(exposure[word.key]?.[meaningKey(m)]) || 0));
    const minimum = Math.min(...counts);
    const options = word.meanings.map((meaning, i) => ({ meaning, i })).filter(({ i }) => counts[i] === minimum);
    const { meaning, i } = options[Math.floor(random() * options.length)];
    return { word, meaning, meaningIndex: i, isCorrect: true, definition: meaning.en };
  });
  // X definitions are deliberately authored, never guessed from another word.
  const eligible = shuffle(questions.map((q, i) => i).filter((i) => questions[i].meaning.wrongEn), random);
  const targetFalse = Math.floor(questions.length / 2) + (questions.length % 2 && random() < 0.5 ? 1 : 0);
  for (const index of eligible.slice(0, targetFalse)) {
    questions[index].isCorrect = false;
    questions[index].definition = questions[index].meaning.wrongEn;
  }
  return { type: 'quiz', phase: 'studying', questions, position: 0, answers: [], revealed: false, total: questions.length };
}

export function recordExposure(exposure, question) {
  const key = question.word.key;
  const sense = meaningKey(question.meaning);
  const record = Object.hasOwn(exposure, key) ? exposure[key] : {};
  return { ...exposure, [key]: { ...record, [sense]: (Number(record?.[sense]) || 0) + 1 } };
}

export function answerQuiz(session, answer) {
  if (session.phase !== 'studying' || session.revealed) return session;
  const question = session.questions[session.position];
  return { ...session, revealed: true, answers: [...session.answers, { answer, correct: answer === question.isCorrect }] };
}

export function nextQuestion(session) {
  if (session.phase !== 'studying' || !session.revealed) return session;
  if (session.position + 1 === session.questions.length) return { ...session, phase: 'complete' };
  return { ...session, position: session.position + 1, revealed: false };
}

/** Restore only complete, internally consistent snapshots from local storage. */
export function validSession(session) {
  const integer = (n) => Number.isSafeInteger(n) && n >= 0;
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value) => typeof value === 'string' && value.trim().length > 0;
  const validMeaning = (m) => object(m) && text(m.ko) && text(m.en) && (m.wrongEn === undefined || text(m.wrongEn));
  const validWord = (w) => object(w) && text(w.word) && w.key === wordKey(w.word) &&
    Array.isArray(w.meanings) && w.meanings.length > 0 && w.meanings.every(validMeaning) &&
    (w.studyMark === undefined || w.studyMark === null || legacyMarks.includes(w.studyMark)) &&
    (w.studyMarks === undefined || isStudyMarks(w.studyMarks)) &&
    (w.studyLevel === undefined || isStudyLevel(w.studyLevel)) &&
    (w.unknownMeaningKeys === undefined || isUnknownMeaningKeys(w.unknownMeaningKeys, w.meanings)) &&
    (w.studyNote === undefined || typeof w.studyNote === 'string') &&
    Array.isArray(w.origins) && w.origins.every(text) && Array.isArray(w.notes) && w.notes.every(text);
  const unique = (words) => new Set(words.map((w) => w.key)).size === words.length;
  if (!object(session) || !['studying', 'between', 'complete'].includes(session.phase) || typeof session.revealed !== 'boolean' || !integer(session.total) || !session.total) return false;
  if (session.type === 'flash') {
    if (!(Array.isArray(session.chunks) && session.chunks.length > 0 && session.chunks.every((c) => Array.isArray(c) && c.length > 0 && c.every(validWord)) &&
      integer(session.chunkIndex) && session.chunkIndex < session.chunks.length &&
      Array.isArray(session.queue) && session.queue.length > 0 && session.queue.every(validWord) && Array.isArray(session.retry) && session.retry.every(validWord) &&
      integer(session.position) && session.position <= session.queue.length && integer(session.mastered) && integer(session.attempts) &&
      session.mastered <= session.attempts && integer(session.round) && session.round > 0)) return false;
    const deck = session.chunks.flat();
    if (session.retryCounts !== undefined && (!object(session.retryCounts) ||
      Object.keys(session.retryCounts).length !== deck.length ||
      !deck.every((word) => Object.hasOwn(session.retryCounts, word.key) && integer(session.retryCounts[word.key])) ||
      Object.values(session.retryCounts).reduce((sum, value) => sum + value, 0) !== session.attempts - session.mastered)) return false;
    const chunk = session.chunks[session.chunkIndex];
    const chunkKeys = new Set(chunk.map((w) => w.key));
    const answeredKeys = new Set(session.queue.slice(0, session.position).map((w) => w.key));
    const previousCount = session.chunks.slice(0, session.chunkIndex).reduce((sum, c) => sum + c.length, 0);
    const expectedMastered = previousCount + chunk.length - session.queue.length + session.position - session.retry.length;
    if (deck.length !== session.total || !unique(deck) || !unique(session.queue) || !unique(session.retry) ||
      !session.queue.every((w) => chunkKeys.has(w.key)) || !session.retry.every((w) => answeredKeys.has(w.key)) ||
      session.mastered !== expectedMastered) return false;
    if (session.phase === 'studying') return session.position < session.queue.length;
    if (session.position !== session.queue.length || session.revealed || session.retry.length) return false;
    return session.phase === 'between' ? session.chunkIndex < session.chunks.length - 1 :
      session.chunkIndex === session.chunks.length - 1 && session.mastered === session.total;
  }
  if (session.type === 'quiz') {
    if (!(session.phase !== 'between' && Array.isArray(session.questions) && session.questions.length === session.total &&
      session.questions.every((q) => object(q) && validWord(q.word) && validMeaning(q.meaning) && integer(q.meaningIndex) &&
        q.meaningIndex < q.word.meanings.length && meaningKey(q.meaning) === meaningKey(q.word.meanings[q.meaningIndex]) &&
        typeof q.isCorrect === 'boolean' && text(q.definition) && q.definition === (q.isCorrect ? q.meaning.en : q.meaning.wrongEn)) &&
      integer(session.position) && session.position < session.total && Array.isArray(session.answers) &&
      session.answers.length === session.position + Number(session.revealed) &&
      session.answers.every((a, i) => object(a) && typeof a.answer === 'boolean' && typeof a.correct === 'boolean' &&
        a.correct === (a.answer === session.questions[i].isCorrect)) && unique(session.questions.map((q) => q.word)))) return false;
    return session.phase === 'studying' || (session.revealed && session.position === session.total - 1 && session.answers.length === session.total);
  }
  return false;
}
