/** One word-level study level, strongest first. Meaning-level difficulty is stored separately. */
export const studyLevels = Object.freeze(['priority', 'unknown', 'review', 'off']);
export const studyLevelLabels = Object.freeze({ priority: '우선 학습', unknown: '모름', review: '복습 필요', off: '끔' });
export const isStudyLevel = (value) => studyLevels.includes(value);
/** When sources or older flags disagree, the stronger level wins. */
export const strongestLevel = (...levels) => studyLevels.find((level) => levels.includes(level)) ?? 'off';
/** Any meaning marked unknown keeps the word at 복습 필요 or above. */
export const withMeaningFloor = (level, unknownCount) => level === 'off' && unknownCount > 0 ? 'review' : level;
export const meaningKey = (meaning) => `${meaning.ko.trim()}\u001f${meaning.en.trim()}`;

/** Older files and snapshots store independent flags (studyMarks) or a single studyMark. */
export const isStudyMarks = (value) => Array.isArray(value) &&
  value.every((mark) => ['unknown', 'review'].includes(mark)) && new Set(value).size === value.length;

export function isUnknownMeaningKeys(value, meanings) {
  if (!Array.isArray(value) || value.some((key) => typeof key !== 'string') || new Set(value).size !== value.length) return false;
  const available = new Set(meanings.map(meaningKey));
  return value.every((key) => available.has(key));
}

/** studyLevel wins over older fields, and an explicit empty studyMarks still clears a legacy studyMark. Old words marked both 모름 and 복습 필요 read as 모름. */
export function getStudyLevel(word) {
  const stored = Object.hasOwn(word, 'studyLevel') ? (isStudyLevel(word.studyLevel) ? word.studyLevel : 'off')
    : Object.hasOwn(word, 'studyMarks') ? strongestLevel(...(Array.isArray(word.studyMarks) ? word.studyMarks : []))
      : strongestLevel(word.studyMark === 'unsure' ? 'review' : word.studyMark);
  return withMeaningFloor(stored, getUnknownMeaningKeys(word).length);
}

/** The learner's free-text memo for a word; blank means no note. */
export const STUDY_NOTE_LIMIT = 1000;
export const isStudyNote = (value) => typeof value === 'string' && value.trim().length <= STUDY_NOTE_LIMIT;
export const getStudyNote = (word) => typeof word?.studyNote === 'string' ? word.studyNote.trim() : '';
/** Repeated spellings keep every distinct source note. */
export const mergeStudyNotes = (notes) => [...new Set(notes.map((note) => note.trim()).filter(Boolean))].join('\n');

/** Keep only actual senses, in the same order as the word's definitions. */
export function getUnknownMeaningKeys(word) {
  const selected = new Set(Array.isArray(word.unknownMeaningKeys) ? word.unknownMeaningKeys : []);
  return [...new Set((word.meanings ?? []).map(meaningKey))].filter((key) => selected.has(key));
}

/**
 * The meanings a learner does not know: the ones they chose, or every meaning when the word carries a level
 * but none is chosen. An unmarked (끔) word says nothing about its meanings.
 */
export function getEffectiveUnknownMeaningKeys(word) {
  const chosen = getUnknownMeaningKeys(word);
  return chosen.length || getStudyLevel(word) === 'off' ? chosen : [...new Set((word.meanings ?? []).map(meaningKey))];
}

/** Flashcards, the O/X quiz and AI exams draw from a minimum level, so each range also includes every stronger level. */
export const rangeLevels = Object.freeze(['all', 'review', 'unknown', 'priority']);
export const rangeLevelLabels = Object.freeze({ all: '전체', review: '복습 필요 이상', unknown: '모름 이상', priority: '우선 학습' });
export const matchesRangeLevel = (word, scope) => scope === 'all' || studyLevels.indexOf(getStudyLevel(word)) <= studyLevels.indexOf(scope);

/**
 * The meanings a 모르는 의미만 exam may test: the unknown ones of a word with several meanings,
 * or the only meaning of a word marked 모름 or above.
 */
export function getFocusMeaningKeys(word) {
  const keys = [...new Set((word.meanings ?? []).map(meaningKey))];
  if (keys.length === 1) return ['priority', 'unknown'].includes(getStudyLevel(word)) ? keys : [];
  return getEffectiveUnknownMeaningKeys(word);
}

/** A study range: a minimum level, optionally (AI exams only) narrowed to words that have meanings to focus on. */
export const inStudyRange = (word, { level, unknownOnly }) => matchesRangeLevel(word, level) && (!unknownOnly || getFocusMeaningKeys(word).length > 0);

/** AI exams saved before the level range carry an exact-level scope, shown under its original name. */
const legacyScopeLabels = Object.freeze({ marked: '우선 학습·모름·복습 필요', priority: '우선 학습', unknown: '모름', review: '복습 필요' });

/** How a range reads; an unfiltered range adds no tag. */
export function rangeTags(options = {}) {
  const range = Object.hasOwn(options, 'level') ? (options.level === 'all' ? '' : rangeLevelLabels[options.level] ?? '')
    : legacyScopeLabels[options.scope] ?? '';
  return [range, options.unknownOnly === true ? '모르는 의미만' : ''].filter(Boolean);
}
export const rangeLabel = (options) => rangeTags(options).join(' · ') || '전체 단어';
