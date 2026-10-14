import { validSession } from './model.js';
import { read, write } from './storage.js';

// Version 1 kept a single unfinished flashcard slot; version 2 keeps a list of decks.
const VERSION = 2;
const emptyState = () => ({ version: VERSION, flashcards: [], exams: [] });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
let fallbackSequence = 0;
const newId = (prefix) => globalThis.crypto?.randomUUID?.() ??
  `${prefix}-${Date.now().toString(36)}-${(++fallbackSequence).toString(36)}-${Math.random().toString(36).slice(2)}`;

function validRecord(record, type) {
  return object(record) && text(record.id) && record.type === type && text(record.title) &&
    date(record.createdAt) && date(record.updatedAt) &&
    validSession(record.session) && record.session.type === type;
}
const validExam = (record) => validRecord(record, 'quiz');
// Completed decks leave the list, so only resumable progress is stored.
const validFlashcard = (record) => validRecord(record, 'flash') && record.session.phase !== 'complete';

/** Keep the newest copy of each ID, listed by creation time. */
function records(values, valid) {
  const byId = new Map();
  for (const record of Array.isArray(values) ? values : []) {
    if (!valid(record)) continue;
    const previous = byId.get(record.id);
    if (!previous || Date.parse(record.updatedAt) > Date.parse(previous.updatedAt)) byId.set(record.id, record);
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Names a deck by the units its cards came from. */
export function flashcardTitle(session) {
  const units = [...new Set(session.chunks.flat().flatMap((word) => word.origins.map((origin) => origin.split(' · ').at(-1))))];
  if (!units.length) return '플래시카드';
  return `플래시카드 · ${units.slice(0, 3).join(', ')}${units.length > 3 ? ` 외 ${units.length - 3}개` : ''}`;
}

/** The old single slot becomes one deck; its ID is stable so repeated reads do not duplicate it. */
function migrateSlot(session) {
  if (!validSession(session) || session.type !== 'flash' || session.phase === 'complete') return [];
  const timestamp = date(session.startedAt) ? new Date(session.startedAt).toISOString() : new Date().toISOString();
  return [{ id: `flash-${session.sessionId || 'legacy'}`, type: 'flash', title: flashcardTitle(session), createdAt: timestamp, updatedAt: timestamp, session }];
}

function normalizeState(state) {
  if (!object(state) || ![1, VERSION].includes(state.version)) return emptyState();
  const flashcards = records(state.version === 1 ? migrateSlot(state.flash) : state.flashcards, validFlashcard);
  return { version: VERSION, flashcards, exams: records(state.exams, validExam) };
}

/** Save a version marker even with no entries so legacy sessions migrate only once. */
export function loadLearningState() {
  const saved = read('learning', null);
  if (saved !== null) {
    const state = normalizeState(saved);
    if (saved?.version !== VERSION) saveLearningState(state);
    return state;
  }
  let state = emptyState();
  const legacy = read('session', null);
  if (validSession(legacy)) {
    if (legacy.type === 'flash') state = { ...state, flashcards: migrateSlot(legacy) };
    else if (legacy.type === 'quiz') state = saveExam(state, createExam(legacy, '영영풀이 O/X'));
  }
  return saveLearningState(state);
}

export function saveLearningState(state) {
  const saved = normalizeState(state);
  write('learning', saved);
  return saved;
}

function createRecord(session, type, title, options) {
  const timestamp = new Date(options.now ?? Date.now()).toISOString();
  return { id: options.id ?? newId(type === 'flash' ? 'flash' : 'exam'), type, title, createdAt: timestamp, updatedAt: timestamp, session };
}

export function createExam(session, title = '영영풀이 O/X', options = {}) {
  if (!validSession(session) || session.type !== 'quiz') throw new TypeError('저장할 시험 내용이 올바르지 않습니다.');
  const record = createRecord(session, 'quiz', title, options);
  if (!validExam(record)) throw new TypeError('저장할 시험 정보가 올바르지 않습니다.');
  return record;
}

export function createFlashcard(session, title = flashcardTitle(session), options = {}) {
  if (!validSession(session) || session.type !== 'flash') throw new TypeError('저장할 플래시카드 내용이 올바르지 않습니다.');
  const record = createRecord(session, 'flash', title, options);
  if (!validRecord(record, 'flash')) throw new TypeError('저장할 플래시카드 정보가 올바르지 않습니다.');
  return record;
}

/** Upsert one deck; a completed deck leaves the list while every other activity stays intact. */
export function saveFlashcard(state, record) {
  if (!validRecord(record, 'flash')) throw new TypeError('저장할 플래시카드 정보가 올바르지 않습니다.');
  const current = normalizeState(state);
  const others = current.flashcards.filter((deck) => deck.id !== record.id);
  return normalizeState({ ...current, flashcards: record.session.phase === 'complete' ? others : [record, ...others] });
}

/** Delete one deck's progress; other decks and exams stay intact. */
export function removeFlashcard(state, id) {
  const current = normalizeState(state);
  return { ...current, flashcards: current.flashcards.filter((deck) => deck.id !== id) };
}

/** Delete one exam and its answers; flashcard decks and other exams stay intact. */
export function removeExam(state, id) {
  const current = normalizeState(state);
  return { ...current, exams: current.exams.filter((exam) => exam.id !== id) };
}

/** Upsert one exam without changing its creation date or any other activity. */
export function saveExam(state, record) {
  if (!validExam(record)) throw new TypeError('저장할 시험 정보가 올바르지 않습니다.');
  const current = normalizeState(state);
  return normalizeState({ ...current, exams: [record, ...current.exams.filter((exam) => exam.id !== record.id)] });
}
