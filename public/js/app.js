import { collectWords, createFlashSession, revealFlash, gradeFlash, nextFlashChunk, createQuiz, answerQuiz, nextQuestion, recordExposure, wordKey, validSession } from './model.js';
import { studyLevels, studyLevelLabels, strongestLevel, withMeaningFloor, isStudyMarks, meaningKey, getStudyLevel, getUnknownMeaningKeys, getStudyNote, mergeStudyNotes, STUDY_NOTE_LIMIT, rangeLevels, inStudyRange, rangeTags } from './study-marks.js';
import { renderSlider } from './slider.js';
import { read, write, storageUnavailable } from './storage.js';
import { icon } from './icons.js';
import { renderHomeView, difficultyStops } from './home-view.js';
import { loadLearningState, saveLearningState, createFlashcard, saveFlashcard, removeFlashcard, flashcardTitle, saveExam, createExam, removeExam } from './learning-store.js';
import { createAIController, request } from './ai-ui.js';

const app = document.querySelector('#app');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const savedSettings = read('settings', {});
// Ranges used to name one exact level; 모름·복습 필요 becomes 복습 필요 이상, and an exact level becomes that level and above.
const savedScope = (value) => value === 'marked' ? 'review' : rangeLevels.includes(value) ? value : 'all';
const settings = {
  mode: ['quiz', 'ai', 'ai-ox'].includes(savedSettings?.mode) ? savedSettings.mode : 'flash',
  chunkSize: Math.max(1, Math.floor(Number(savedSettings?.chunkSize) || 10)),
  questionCount: Math.max(1, Math.floor(Number(savedSettings?.questionCount) || 20)),
  shuffle: savedSettings?.shuffle !== false,
  flashScope: savedScope(savedSettings?.flashScope ?? savedSettings?.flashFilter),
  quizScope: savedScope(savedSettings?.quizScope),
  aiCount: Math.max(1, Math.floor(Number(savedSettings?.aiCount) || 5)),
  aiMode: savedSettings?.aiMode === 'weak' ? 'weak' : 'normal',
  aiScope: savedScope(savedSettings?.aiScope),
  aiUnknownOnly: savedSettings?.aiUnknownOnly === true,
  aiDifficulty: ['easy', 'medium', 'hard'].includes(savedSettings?.aiDifficulty) ? savedSettings.aiDifficulty : 'medium',
  aiOxCount: Math.max(1, Math.floor(Number(savedSettings?.aiOxCount) || 10)),
  aiOxScope: savedScope(savedSettings?.aiOxScope),
  aiOxUnknownOnly: savedSettings?.aiOxUnknownOnly === true,
  aiOxWeak: savedSettings?.aiOxWeak === true,
  aiOxDifficulty: ['easy', 'medium', 'hard'].includes(savedSettings?.aiOxDifficulty) ? savedSettings.aiOxDifficulty : 'medium',
};
const storedSelection = read('selection', []);
let selected = new Set(Array.isArray(storedSelection) ? storedSelection : []);
let library = { books: [], warnings: [] };
let activeBook = '';
let expandedBooks = new Set();
let screen = 'home';
// The home workspace shows either the setup panel or the feed of saved activities.
let feedOpen = false;
let feedFilter = 'all';
let feedActiveOnly = false;
let learning = loadLearningState();
let session = null;
let activeExamId = null;
let activeFlashId = null;
let exposure = read('exposure', {});
if (!exposure || typeof exposure !== 'object' || Array.isArray(exposure)) exposure = {};
let fetching = false;
let loadError = '';
let pendingFlashRecords = read('pending-flash-records', []);
if (!Array.isArray(pendingFlashRecords)) pendingFlashRecords = [];
pendingFlashRecords = pendingFlashRecords.filter((item) => validSession(item) && item.type === 'flash' && item.phase === 'complete');
let recordSaving = false;
let recordError = '';
const legacyPendingMark = read('pending-word-mark', null);
let pendingMarks = read('pending-word-marks', legacyPendingMark ? [legacyPendingMark] : []);
if (!Array.isArray(pendingMarks)) pendingMarks = [];
pendingMarks = pendingMarks.filter((change) => change && Array.isArray(change.sourceRefs) && change.sourceRefs.length &&
  ((studyLevels.includes(change.studyLevel) || isStudyMarks(change.studyMarks)) &&
    Array.isArray(change.unknownMeaningKeys) && change.unknownMeaningKeys.every((key) => typeof key === 'string') &&
    (change.studyNote === undefined || typeof change.studyNote === 'string') ||
    !Object.hasOwn(change, 'studyLevel') && !Object.hasOwn(change, 'studyMarks') && [null, 'unknown', 'unsure', 'review'].includes(change.mark)))
  // Saves queued before the level slider carry both flags; 모름 wins over 복습 필요.
  .map(({ studyMarks, ...change }) => studyMarks && !change.studyLevel
    ? { ...change, studyLevel: withMeaningFloor(strongestLevel(...studyMarks), change.unknownMeaningKeys.length) } : change);
write('pending-word-marks', pendingMarks);
write('pending-word-mark', null);
let markSaving = false;
let markSaveTask = null;
let savedMarkRevision = 0;
let markError = '';
// Shown once after a mark or note save lands; cleared when the card changes.
let markSaved = false;
// Unsaved note text survives re-renders caused by mark saves while the learner types.
let noteDraft = null;
let pendingDelete = null;
let deleteError = '';
let pointerHeld = false;
// The pointer dragging across the level slider, if any.
let sliderDrag = null;
let deferredNote = null;
const levelKeys = { priority: 'Q', unknown: 'W', review: 'E', off: 'R' };
const levelCodes = { KeyQ: 'priority', KeyW: 'unknown', KeyE: 'review', KeyR: 'off' };
const levelTones = { priority: 'red', unknown: 'orange', review: 'green', off: 'grey' };
const levelAnnouncements = { priority: '‘우선 학습’으로 표시했어요.', unknown: '‘모름’으로 표시했어요.', review: '‘복습 필요’로 표시했어요.', off: '단어 표시를 껐어요.' };
const ai = createAIController({
  onChange: () => render(),
  onOpen: () => { screen = 'ai'; window.scrollTo(0, 0); render(true); },
  announce,
});

const allUnits = () => library.books.flatMap((book) => book.units);
const selectedUnits = () => allUnits().filter((unit) => selected.has(unit.key));
const selectedWords = () => collectWords(selectedUnits()).map(refreshWord);
/** Largest allowed value for each numeric field; AI O/X asks one question per word in its range. */
const numberFields = { 'chunk-size': 'chunkSize', 'question-count': 'questionCount', 'ai-count': 'aiCount', 'ai-ox-count': 'aiOxCount' };
/** The AI five-option and O/X exams keep separate settings under the same names. */
const aiSetting = (name, ox = settings.mode === 'ai-ox') => ox ? `aiOx${name}` : `ai${name}`;
/** Every study mode remembers its own range; only the AI exams can also narrow it to 모르는 의미만. */
const scopeSetting = (mode = settings.mode) => ({ flash: 'flashScope', quiz: 'quizScope', ai: 'aiScope', 'ai-ox': 'aiOxScope' })[mode];
const studyRange = (mode = settings.mode) => ({ level: settings[scopeSetting(mode)], unknownOnly: mode.startsWith('ai') && settings[aiSetting('UnknownOnly', mode === 'ai-ox')] });
const rangeWords = (range = studyRange()) => selectedWords().filter((word) => inStudyRange(word, range));
const fieldMax = (id) => id === 'ai-count' ? Math.max(1, Math.floor(rangeWords(studyRange('ai')).length / 5))
  : id === 'ai-ox-count' ? Math.max(1, rangeWords(studyRange('ai-ox')).length) : 100000;
/** A deck or exam title names its range unless it covers every word. */
const rangeTitle = (label) => { const tags = rangeTags(studyRange()); return tags.length ? `${label} (${tags.join(' · ')})` : label; };
const changeSetting = (name, value) => { settings[name] = value; rememberSettings(); render(); };
/** What each slider changes; values run left to right. */
const sliders = {
  'study-level': { values: studyLevels, current: () => session?.type === 'flash' ? getStudyLevel(refreshWord(session.queue[session.position])) : null, set: (level) => changeStudyMark({ level }) },
  scope: { values: rangeLevels, current: () => settings[scopeSetting()], set: (value) => changeSetting(scopeSetting(), value) },
  'ai-difficulty': { values: difficultyStops.map((stop) => stop.value), current: () => settings[aiSetting('Difficulty')], set: (value) => changeSetting(aiSetting('Difficulty'), value) },
};
function setSlider(name, value) {
  const slider = sliders[name];
  if (slider?.values.includes(value) && value !== slider.current()) slider.set(value);
}
function moveSlider(name, step) {
  const slider = sliders[name];
  const next = slider.values[slider.values.indexOf(slider.current()) + step];
  if (!next) return;
  setSlider(name, next);
  app.querySelector?.(`.level-stop[data-slider="${name}"][data-value="${next}"]`)?.focus({ preventScroll: true });
}
const brand = () => `<span class="brand">Word<span>POP</span><span class="brand-spark" aria-hidden="true">✳</span></span>`;
const kbd = (key) => `<kbd>${key}</kbd>`;
function announce(message) { document.querySelector('#announcer').textContent = message; }
function persistSession() {
  if (!session) return;
  if (session.type === 'flash') {
    if (session.phase === 'complete') {
      const id = session.sessionId || session.completedAt;
      if (!pendingFlashRecords.some((item) => (item.sessionId || item.completedAt) === id)) {
        pendingFlashRecords.push(session);
        write('pending-flash-records', pendingFlashRecords);
      }
      void flushFlashRecords();
    }
    // A completed deck leaves the list; its result is kept in the server record above.
    const deck = learning.flashcards.find((item) => item.id === activeFlashId);
    if (deck) learning = saveFlashcard(learning, { ...deck, session, updatedAt: new Date().toISOString() });
  }
  else {
    const exam = learning.exams.find((item) => item.id === activeExamId);
    if (exam) learning = saveExam(learning, { ...exam, session, updatedAt: new Date().toISOString() });
  }
  saveLearningState(learning);
}
function rememberSettings() { write('settings', settings); }
function selectionChanged() { write('selection', [...selected]); render(); }

async function flushFlashRecords() {
  if (recordSaving || !pendingFlashRecords.length) return;
  recordSaving = true;
  recordError = '';
  while (pendingFlashRecords.length) {
    try {
      await request('/api/flash-records', { method: 'POST', body: JSON.stringify({ session: pendingFlashRecords[0] }) });
      pendingFlashRecords.shift();
      write('pending-flash-records', pendingFlashRecords);
    } catch (error) { recordError = error.message; break; }
  }
  recordSaving = false;
  render();
}

function recordNotice() {
  return pendingFlashRecords.length ? `<div class="notice ${recordError ? 'error' : 'warning'}" role="status">${recordError ? `${esc(recordError)} 완료한 플래시카드 ${pendingFlashRecords.length}개는 이 브라우저에 보관 중입니다.` : '플래시카드 기록 저장 중…'}${recordError ? ' <button class="inline-link" data-action="retry-flash-records">저장 다시 시도</button>' : ''}</div>` : '';
}

function markNotice() {
  if (!pendingMarks.length) return '';
  return markSaving ? '<p class="save-state" role="status">표시·노트 저장 중…</p>' : `<div class="notice error" role="alert">${esc(markError || '단어 표시와 노트를 아직 저장하지 못했습니다.')} 선택한 표시와 노트는 이 브라우저에 보관 중입니다. <button class="inline-link" data-action="retry-mark">저장 다시 시도</button></div>`;
}

const sameSource = (a, b) => a.unitKey === b.unitKey && a.wordId === b.wordId;
const sameSources = (a, b) => a.length === b.length && a.every((ref) => b.some((other) => sameSource(ref, other)));

function pendingSourceWord(word, ref) {
  const change = pendingMarks.findLast((item) => item.sourceRefs.some((source) => sameSource(source, ref)));
  if (!change) return word;
  return { ...word, studyLevel: change.studyLevel ?? getStudyLevel({ studyMark: change.mark }),
    unknownMeaningKeys: change.unknownMeaningKeys ?? getUnknownMeaningKeys(word),
    studyNote: typeof change.studyNote === 'string' ? change.studyNote : getStudyNote(word) };
}

/** Recover old cards only when their displayed origin identifies one source. */
function refreshWord(word) {
  let refs = word.sourceRefs;
  if (!refs?.length && word.origins?.length) {
    const units = word.origins.map((origin) => allUnits().filter((unit) => `${unit.bookTitle} · ${unit.unitTitle}` === origin && unit.words.filter((item) => wordKey(item.word) === word.key).length === 1));
    if (units.every((matches) => matches.length === 1)) refs = collectWords(units.flat()).find((item) => item.key === word.key)?.sourceRefs;
  }
  if (!refs?.length) return word;
  const sources = refs.map((ref) => {
    const source = allUnits().find((unit) => unit.key === ref.unitKey)?.words.find((item) => item.id === ref.wordId);
    return source ? pendingSourceWord(source, ref) : null;
  }).filter(Boolean);
  if (!sources.length) return word;
  const unknown = new Set(sources.flatMap(getUnknownMeaningKeys));
  const { studyMark, studyMarks, ...fields } = word;
  return { ...fields, sourceRefs: refs, studyLevel: strongestLevel(...sources.map(getStudyLevel)),
    unknownMeaningKeys: word.meanings.map(meaningKey).filter((key) => unknown.has(key)), studyNote: mergeStudyNotes(sources.map(getStudyNote)) };
}

function refreshSessionWords(current) {
  if (!current) return current;
  if (current.type === 'flash') return { ...current, chunks: current.chunks.map((chunk) => chunk.map(refreshWord)), queue: current.queue.map(refreshWord), retry: current.retry.map(refreshWord) };
  return { ...current, questions: current.questions.map((question) => ({ ...question, word: refreshWord(question.word) })) };
}

function refreshLearningMarks() {
  const refresh = (record) => ({ ...record, session: refreshSessionWords(record.session) });
  learning = { ...learning, flashcards: learning.flashcards.map(refresh), exams: learning.exams.map(refresh) };
  session = refreshSessionWords(session);
  saveLearningState(learning);
}

function applySavedMark(change, saved) {
  savedMarkRevision++;
  for (const ref of change.sourceRefs) {
    const word = allUnits().find((unit) => unit.key === ref.unitKey)?.words.find((item) => item.id === ref.wordId);
    if (!word) continue;
    word.studyLevel = saved.studyLevel ?? change.studyLevel ?? getStudyLevel({ studyMark: change.mark });
    word.unknownMeaningKeys = getUnknownMeaningKeys({ ...word,
      // A legacy mark-only write preserves each source's own meaning choices.
      unknownMeaningKeys: Object.hasOwn(change, 'studyLevel')
        ? saved.unknownMeaningKeys ?? change.unknownMeaningKeys : getUnknownMeaningKeys(word) });
    delete word.studyMark;
    delete word.studyMarks;
    if (typeof change.studyNote === 'string') {
      const note = saved.studyNote ?? change.studyNote.trim();
      if (note) word.studyNote = note; else delete word.studyNote;
    }
  }
  refreshLearningMarks();
}

function saveMark() {
  if (markSaveTask) return markSaveTask;
  if (!pendingMarks.length) return Promise.resolve();
  markSaveTask = flushMarks().finally(() => { markSaveTask = null; });
  return markSaveTask;
}

async function flushMarks() {
  if (!pendingMarks.length || markSaving) return;
  markSaving = true;
  markError = '';
  render();
  while (pendingMarks.length) {
    const change = pendingMarks[0];
    try {
      const payload = Object.hasOwn(change, 'studyLevel')
        ? { sourceRefs: change.sourceRefs, studyLevel: change.studyLevel, unknownMeaningKeys: change.unknownMeaningKeys,
          ...(typeof change.studyNote === 'string' ? { studyNote: change.studyNote } : {}) }
        : { sourceRefs: change.sourceRefs, mark: change.mark };
      const saved = await request('/api/word-mark', { method: 'PATCH', body: JSON.stringify(payload) });
      // Rapid edits replace the queued snapshot, so an older response cannot erase them.
      if (pendingMarks[0] === change) pendingMarks.shift();
      write('pending-word-marks', pendingMarks);
      applySavedMark(change, saved);
    } catch (error) { markError = error.message; announce('표시나 노트를 저장하지 못했어요. 다시 시도할 수 있어요.'); break; }
  }
  markSaving = false;
  if (!pendingMarks.length) { markSaved = true; announce('단어 표시와 노트를 저장했어요.'); }
  render();
}

/** A word holds one level; toggling an unknown meaning lifts 끔 to 복습 필요 and leaves any stronger level alone. */
function changeStudyMark({ level, meaningIndex }) {
  if (session?.type !== 'flash' || session.phase !== 'studying') return;
  const word = refreshWord(session.queue[session.position]);
  if (level !== undefined && !studyLevels.includes(level)) return;
  if (meaningIndex !== undefined && (!session.revealed || !hasMeaningChoice(word) || !Number.isInteger(meaningIndex) || !word.meanings[meaningIndex])) return;
  const current = getStudyLevel(word);
  if (level === current || !hasSources(word)) return;
  const unknown = new Set(getUnknownMeaningKeys(word));
  // 끔 means no mark at all, so it also clears the unknown meanings that would hold the word at 복습 필요.
  if (level === 'off') unknown.clear();
  else if (level === undefined) {
    const key = meaningKey(word.meanings[meaningIndex]);
    if (unknown.has(key)) unknown.delete(key); else unknown.add(key);
  }
  const next = withMeaningFloor(level ?? current, unknown.size);
  queueWordChange(word, { studyLevel: next, unknownMeaningKeys: [...unknown] });
  if (next !== current) announce(`${level === undefined ? '모르는 뜻을 골라 ' : ''}${levelAnnouncements[next]}`);
}

/** The key is captured on blur, because a click that caused the blur may already have advanced the card. */
function saveStudyNote(text, key) {
  if (noteDraft?.key === key) noteDraft = null;
  const card = session?.type === 'flash' ? session.chunks.flat().find((item) => item.key === key) : null;
  if (!card) return;
  const word = refreshWord(card);
  const note = String(text).trim();
  if (note === getStudyNote(word) || !hasSources(word)) return;
  if (note.length > STUDY_NOTE_LIMIT) { markError = `노트는 ${STUDY_NOTE_LIMIT}자 이하로 작성해 주세요.`; announce(markError); render(); return; }
  queueWordChange(word, { studyLevel: getStudyLevel(word), unknownMeaningKeys: getUnknownMeaningKeys(word), studyNote: note });
}

function hasSources(word) {
  if (word.sourceRefs?.length) return true;
  markError = '이전 플래시카드의 출처를 확인할 수 없어요. 교재에서 과를 다시 선택해 주세요.';
  announce(markError);
  render();
  return false;
}

/** Each change carries the word's whole state, so the latest queued snapshot wins. */
function queueWordChange(word, state) {
  const change = { sourceRefs: word.sourceRefs, word: word.word, ...state };
  markSaved = false;
  const index = pendingMarks.length && sameSources(pendingMarks.at(-1).sourceRefs, change.sourceRefs) ? pendingMarks.length - 1 : -1;
  // Mark-only edits omit the note; keep an unsent note from the snapshot they replace.
  if (index >= 0 && change.studyNote === undefined && typeof pendingMarks[index].studyNote === 'string') change.studyNote = pendingMarks[index].studyNote;
  if (index < 0) pendingMarks.push(change); else pendingMarks[index] = change;
  write('pending-word-marks', pendingMarks);
  refreshLearningMarks();
  render();
  void saveMark();
}

async function load() {
  fetching = true;
  if (library.books.length) render();
  try {
    // A library response captured before a completed mark save is already stale.
    while (true) {
      const revision = savedMarkRevision;
      const response = await fetch('/api/library');
      if (!response.ok) throw new Error('단어장을 읽지 못했어요. 로컬 서버가 켜져 있는지 확인해 주세요.');
      const loaded = await response.json();
      if (revision !== savedMarkRevision) continue;
      library = loaded;
      break;
    }
    const keys = new Set(allUnits().map((unit) => unit.key));
    selected = new Set([...selected].filter((key) => keys.has(key)));
    if (!library.books.some((b) => b.id === activeBook)) activeBook = library.books[0]?.id || '';
    expandedBooks.add(activeBook);
    learning = { ...learning, flashcards: learning.flashcards.map((deck) => ({ ...deck, session: refreshSessionWords(deck.session) })) };
    session = refreshSessionWords(session);
    loadError = '';
    write('selection', [...selected]);
  } catch (error) { loadError = error.message; }
  fetching = false;
  render();
  void flushFlashRecords();
  if (pendingMarks.length) void saveMark();
}

function renderHome() {
  app.innerHTML = renderHomeView({ library, selected, words: selectedWords(), expandedBooks, activeBook, settings, learning, fetching, loadError, storageWarning: storageUnavailable(), brand: brand(), aiExams: ai.exams, feed: { open: feedOpen, filter: feedFilter, activeOnly: feedActiveOnly }, aiGenerating: ai.isGenerating, aiNotice: ai.renderHomeNotice(), extraNotice: recordNotice() + markNotice() + (deleteError ? `<div class="notice error" role="alert">${esc(deleteError)}</div>` : '') }) + dialogs();
}

function meaningsMarkup(word, selectedMeaning, selectable = false) {
  const meanings = selectedMeaning ? [selectedMeaning] : word.meanings;
  const unknown = new Set(getUnknownMeaningKeys(word));
  return `<div class="meanings">${meanings.map((m, i) => {
    const index = selectedMeaning ? word.meanings.findIndex((item) => meaningKey(item) === meaningKey(m)) : i;
    const marked = unknown.has(meaningKey(m));
    return `<div class="meaning ${selectable ? 'selectable-meaning' : ''} ${selectable && marked ? 'meaning-unknown' : ''}" style="--i: ${i}"><span class="meaning-number">${String(index + 1).padStart(2, '0')}</span><div class="meaning-copy"><strong>${esc(m.ko)}</strong><p lang="en">${esc(m.en)}</p></div>${selectable ? `<button type="button" class="meaning-mark ${marked ? 'active' : ''}" data-action="mark-meaning" data-meaning-index="${index}" aria-label="${index + 1}번째 뜻 모름: ${esc(m.ko)}" aria-pressed="${marked}">${marked ? icon('check') : '<span class="meaning-mark-box" aria-hidden="true"></span>'}이 뜻 모름${index < 9 ? kbd(index + 1) : ''}</button>` : ''}</div>`;
  }).join('')}</div>${word.notes?.length ? `<details class="source-note"><summary>원문 뜻 참고</summary>${word.notes.map((note) => `<p>${esc(note)}</p>`).join('')}<p>원문: ${esc(word.sourceMeaning)}</p></details>` : ''}`;
}

/** A marked word with no meaning chosen counts as not knowing any of them, so a single meaning needs no choice of its own. */
const hasMeaningChoice = (word) => word.meanings.length > 1;

function studyHeader() {
  return `<header class="study-header"><button class="brand-button" data-action="home" aria-label="WordPOP 홈">${brand()}</button><span class="study-mode-label">${icon(session.type === 'flash' ? 'cards' : 'quiz')}${session.type === 'flash' ? '플래시카드' : esc(learning.exams.find((exam) => exam.id === activeExamId)?.title || '영영풀이 O / X')}</span><button class="text-button" data-action="home">${icon('back')}돌아가기</button></header>`;
}

function progress(value, total) { return `<progress class="progress-track" max="${total}" value="${value}" aria-label="전체 학습 진행"></progress>`; }

function renderFlash() {
  const s = session;
  const word = s.queue[s.position];
  const level = getStudyLevel(word);
  // Meanings and the note are laid out under the curtain from the start, so dropping it reveals them in place without resizing the card.
  // The 알고 있어요 button beside the card keeps its space too, and shows only once the card is revealed.
  const covered = s.revealed ? '' : ' inert';
  const cardKey = `${esc(word.key)}:${s.round}`;
  const curtain = s.revealed
    ? `<button type="button" class="flash-curtain" data-action="unknown" data-enter="curtain:${cardKey}"><span class="curtain-label">아직 모르겠어요${kbd('Space')}</span><span class="curtain-word" lang="en" aria-hidden="true">${esc(word.word)}</span></button>`
    : `<button type="button" class="flash-curtain" data-action="reveal"><span class="curtain-word" lang="en">${esc(word.word)}</span><span class="curtain-hint">뜻 확인하기${kbd('Space')}</span></button>`;
  return `<main class="study-main"><div class="study-topline"><span class="pill"><span class="live-dot"></span>구간 ${s.chunkIndex + 1} / ${s.chunks.length}</span><span>${s.mastered} / ${s.total}개 기억했어요</span></div>${progress(s.mastered, s.total)}
    <div class="card-caption"><span>${s.round > 1 ? `${s.round}번째 반복` : ''}</span><span>${s.position + 1} / ${s.queue.length}</span></div>
    <div class="flash-stage ${s.revealed ? 'revealed' : ''}"><section class="flash-card ${s.revealed ? 'revealed' : ''}" tabindex="-1" id="study-focus" data-enter="card:${cardKey}">
      <div class="flash-content"${covered}><div class="card-overline">${esc(word.origins[0])}</div><h1 lang="en">${esc(word.word)}</h1>
        ${meaningsMarkup(word, null, hasMeaningChoice(word))}
        <label class="study-note"><textarea id="study-note" rows="1" aria-label="내 노트" maxlength="${STUDY_NOTE_LIMIT}" placeholder="헷갈리는 점, 외우는 방법… AI 시험을 만들 때 참고해요.">${esc(noteDraft?.key === word.key ? noteDraft.text : getStudyNote(word))}</textarea><span class="study-note-hint">입력칸을 벗어나면 저장돼요 · ${kbd('Esc')}로 빠져나와요</span></label>
      </div>
      ${curtain}
    </section><button type="button" class="flash-known" data-action="known"${covered}${s.revealed ? ` data-enter="known:${cardKey}"` : ''}><span class="flash-known-arrow">${icon('arrow')}</span><span>알고 있어요</span>${kbd('Enter')}</button></div>
    ${renderSlider({ name: 'study-level', key: word.key, label: '학습 필요성', className: 'study-level-slider', value: level, stops: studyLevels.map((value) => ({ value, label: studyLevelLabels[value], tone: levelTones[value], key: levelKeys[value] })) })}${markNotice() || (markError ? `<p class="notice error">${esc(markError)}</p>` : markSaved ? '<p class="save-state saved" role="status">표시·노트를 저장했어요</p>' : '')}
    </main>`;
}

function renderQuiz() {
  const s = session;
  const q = s.questions[s.position];
  const answer = s.answers[s.position];
  return `<main class="study-main quiz-main"><div class="study-topline"><span class="pill"><span class="live-dot"></span>영영풀이 O / X</span><span>${s.position + 1} / ${s.total}문항</span></div>${progress(s.answers.length, s.total)}
    
    <section class="quiz-card ${s.revealed && !answer.correct ? 'shake' : ''}" id="study-focus" tabindex="-1" data-enter="quiz:${s.position}"><h1 lang="en">${esc(q.word.word)}</h1><span class="definition-divider"></span><p class="quiz-definition" lang="en">${esc(q.definition)}</p></section>
    ${s.revealed ? `<section class="quiz-feedback ${answer.correct ? 'correct' : 'incorrect'}" aria-label="채점 결과" data-enter="feedback:${s.position}"><div class="feedback-title">${icon(answer.correct ? 'check' : 'close')}<strong>${answer.correct ? '정답' : '오답'}</strong>${answer.correct ? '' : `<span>정답은 ${q.isCorrect ? 'O' : 'X'}였어요</span>`}</div>${meaningsMarkup(q.word, q.meaning)}${q.word.meanings.length > 1 ? `<details class="other-meanings"><summary>이 단어의 모든 뜻 보기 (${q.word.meanings.length}개)</summary>${meaningsMarkup(q.word)}</details>` : ''}</section><button class="primary-button next-button" data-action="next-question">${s.position + 1 === s.total ? '시험 결과 보기' : '다음 문제'}${kbd('Enter')}</button>` : `<div class="study-actions ox-actions"><button class="ox-button o-button" data-action="answer-o"><span class="ox-symbol">O</span><span>올바른 뜻이에요</span>${kbd('O')}</button><button class="ox-button x-button" data-action="answer-x"><span class="ox-symbol">X</span><span>다른 뜻이에요</span>${kbd('X')}</button></div>`}</main>`;
}

function renderMilestone() {
  const s = session;
  if (s.phase === 'between') return `<main class="result-main" id="study-focus" tabindex="-1" data-enter="between:${s.chunkIndex}"><div class="celebration-icon">${icon('leaf')}</div><h1>${s.chunkIndex + 1}번째 구간 완료</h1><div class="result-stats"><div><strong>${s.mastered}</strong><span>기억한 단어</span></div><div><strong>${s.total - s.mastered}</strong><span>남은 단어</span></div></div><button class="primary-button" data-action="next-chunk">다음 구간으로${kbd('Enter')}</button><button class="text-button" data-action="home">잠깐 쉬어가기</button></main>`;
  if (s.type === 'flash') return `<main class="result-main" id="study-focus" tabindex="-1" data-enter="complete"><div class="celebration-icon">${icon('spark')}</div><h1>플래시카드 완료</h1><div class="result-stats"><div><strong>${s.total}</strong><span>기억한 단어</span></div><div><strong>${s.attempts - s.total}</strong><span>다시 본 횟수</span></div></div><button class="primary-button" data-action="home">돌아가기${icon('arrow')}</button></main>`;
  const correct = s.answers.filter((answer) => answer.correct).length;
  const missed = s.questions.filter((q, i) => !s.answers[i].correct);
  return `<main class="result-main quiz-result" id="study-focus" tabindex="-1" data-enter="complete"><div class="celebration-icon">${icon('spark')}</div><h1>시험 결과</h1><div class="result-stats"><div><strong>${Math.round(correct / s.total * 100)}<small>%</small></strong><span>정답률</span></div><div><strong>${correct}<small> / ${s.total}</small></strong><span>맞힌 문항</span></div></div><div class="result-buttons"><button class="primary-button" data-action="home">돌아가기${icon('arrow')}</button>${missed.length ? `<button class="secondary-button" data-action="review-missed">틀린 단어 ${missed.length}개 플래시카드로 복습</button>` : ''}</div><section class="answer-review"><h2>문항별 풀이 <span>${s.total}</span></h2>${s.questions.map((q, i) => `<details class="review-item"><summary><span class="review-badge ${s.answers[i].correct ? 'correct' : 'incorrect'}">${s.answers[i].correct ? '정답' : '오답'}</span><strong lang="en">${esc(q.word.word)}</strong><span>${s.answers[i].correct ? '' : `내 답 ${s.answers[i].answer ? 'O' : 'X'} · 정답 ${q.isCorrect ? 'O' : 'X'}`}</span>${icon('chevron')}</summary><div class="review-content"><p class="review-question" lang="en">제시한 풀이: ${esc(q.definition)}</p>${meaningsMarkup(q.word, q.meaning)}</div></details>`).join('')}</section></main>`;
}

function dialogs() {
  return `<dialog id="help-dialog" aria-labelledby="help-title"><button class="dialog-close text-button" data-action="close-dialog" aria-label="안내 닫기">${icon('close')}</button><h2 id="help-title">WordPOP 사용 방법</h2><ol class="help-steps"><li><strong>오늘 공부할 과를 골라요.</strong><p>교재 폴더를 열고 과를 선택해 주세요. 여러 교재의 과를 함께 담을 수도 있어요.</p></li><li><strong>플래시카드로 기억해요.</strong><p>모르는 단어만 반복하고, 한 구간을 모두 알게 되면 다음으로 넘어가요. 뜻을 펼친 뒤 ‘이 뜻 모름’으로 모르는 뜻만 고를 수 있고, ‘내 노트’는 AI 시험을 만들 때 참고해요.</p><dl class="key-list"><dt>${kbd('Space')}</dt><dd>뜻 확인 · 아직 모르겠어요</dd><dt>${kbd('Enter')}</dt><dd>알고 있어요</dd><dt>${kbd('Q')} ${kbd('W')} ${kbd('E')} ${kbd('R')}</dt><dd>우선 학습 · 모름 · 복습 필요 · 끔 (하나만 선택)</dd><dt>${kbd('1')}–${kbd('9')}</dt><dd>그 번호의 뜻만 모름 (끔이면 복습 필요로 올려요). 표시한 단어에서 아무 뜻도 고르지 않으면 모든 뜻을 모르는 것으로 봐요.</dd></dl></li><li><strong>O/X로 정확한 뜻을 확인해요.</strong><p>영영풀이가 단어의 뜻 중 하나에 해당하면 ${kbd('O')}, 그렇지 않으면 ${kbd('X')}를 눌러요. ${kbd('Enter')}로 다음 문항으로 넘어가요.</p></li></ol><p class="dialog-note">만든 학습물은 사이드바의 ‘학습물 보기’에서 카드로 모아 보고, 다시 열거나 휴지통 버튼으로 삭제할 수 있어요. 플래시카드 진행과 O/X 시험은 이 브라우저에, 단어 표시·노트와 AI 시험은 컴퓨터에 저장돼요.</p><button class="primary-button" data-action="close-dialog">시작해 볼게요${icon('arrow')}</button></dialog>
  <dialog id="delete-dialog" aria-labelledby="delete-title"><h2 id="delete-title">${pendingDelete?.kind === 'flash' ? '플래시카드를' : '시험을'} 삭제할까요?</h2><p><strong>${esc(pendingDelete?.title)}</strong>${pendingDelete?.kind === 'flash' ? '의 진행 내용이 지워지며, 되돌릴 수 없어요. 이미 완료한 플래시카드의 암기 기록은 그대로 남아요.' : '의 문항과 풀이 결과가 모두 지워지며, 되돌릴 수 없어요.'}${pendingDelete?.kind === 'ai' ? ' 컴퓨터에 저장된 시험 JSON과 결과 Markdown도 함께 지우며, 이후 AI 출제에서 이 시험 기록을 참고하지 않아요.' : ''}</p><div class="dialog-actions"><button class="secondary-button" data-action="close-dialog">취소</button><button class="primary-button danger-button" data-action="delete-exam">삭제</button></div></dialog>`;
}

// Entry animations run only for elements whose data-enter key was not in the previous render of the same screen.
let enteredKeys = new Set();
let enteredScreen = '';
function animateEntries() {
  if (enteredScreen !== screen) { enteredKeys = new Set(); enteredScreen = screen; }
  const keys = new Set();
  for (const element of app.querySelectorAll('[data-enter]')) {
    keys.add(element.dataset.enter);
    if (!enteredKeys.has(element.dataset.enter)) element.classList.add('enter');
  }
  enteredKeys = keys;
}
/** Where each slider's thumb is right now, in stops from the left, including partway through a glide. */
function sliderSnapshots() {
  const snapshots = new Map();
  for (const slider of app.querySelectorAll?.('.level-slider') ?? []) {
    const thumb = slider.querySelector('.level-thumb');
    const step = (slider.querySelector('.level-track').clientWidth - thumb.offsetWidth) / (Number(slider.dataset.stops) - 1);
    if (step > 0) snapshots.set(slider.dataset.slider, { key: slider.dataset.key, position: thumb.offsetLeft / step, color: getComputedStyle(slider.querySelector('.level-fill')).backgroundColor });
  }
  return snapshots;
}
/** Sliders are rebuilt on every render too, so each new one starts where its old thumb was and glides to its stop. A save landing mid-glide therefore continues the glide instead of jumping. */
function animateSliders(previous) {
  if (typeof requestAnimationFrame !== 'function') return;
  for (const slider of app.querySelectorAll?.('.level-slider') ?? []) {
    const before = previous.get(slider.dataset.slider);
    if (!before || before.key !== slider.dataset.key || Math.abs(before.position - Number(slider.dataset.index)) < 0.01) continue;
    const fill = slider.querySelector('.level-fill');
    slider.style.setProperty('--level', before.position);
    fill.style.backgroundColor = before.color;
    // The thumb stretches once as it leaves a stop, not again when a glide is picked up mid-way.
    if (Math.abs(before.position - Math.round(before.position)) < 0.01) slider.classList.add('sliding');
    requestAnimationFrame(() => requestAnimationFrame(() => { slider.style.removeProperty('--level'); fill.style.removeProperty('background-color'); }));
  }
}
/** The bar is rebuilt on every render, so its fill is animated by starting from the previous value. */
function animateProgress(previous) {
  const bar = app.querySelector?.('.progress-track');
  if (!bar || !previous || previous.max !== bar.max || previous.value === bar.value || typeof requestAnimationFrame !== 'function') return;
  const target = bar.value;
  bar.value = previous.value;
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.value = target; }));
}

function render(focus = false) {
  const active = document.activeElement?.dataset;
  const markFocus = !focus && ['slider', 'mark-meaning'].includes(active?.action)
    ? { action: active.action, slider: active.slider, value: active.value, meaningIndex: active.meaningIndex } : null;
  // Toggling a setting re-renders the panel, so its switch gets focus back.
  const fieldFocus = !focus && document.activeElement?.closest?.('.setting-fields') ? document.activeElement.id : '';
  const noteField = !focus && document.activeElement?.id === 'study-note' ? document.activeElement : null;
  const noteSelection = noteField ? [noteField.selectionStart, noteField.selectionEnd] : null;
  const bar = app.querySelector?.('.progress-track');
  const previousProgress = bar ? { value: bar.value, max: bar.max } : null;
  const previousSliders = sliderSnapshots();
  document.title = `WordPOP · ${screen === 'home' ? (feedOpen ? '만든 학습물' : '학습 만들기') : screen === 'ai' ? ai.title : session?.type === 'flash' ? '플래시카드' : '영영풀이 O/X'}`;
  if (screen === 'ai') app.innerHTML = `<div class="study-shell"><header class="study-header"><button class="brand-button" data-action="home" aria-label="WordPOP 홈">${brand()}</button><span class="study-mode-label">${icon('spark')}${esc(ai.title)}</span><button class="text-button" data-action="home">${icon('back')}돌아가기</button></header>${ai.renderMain()}${dialogs()}</div>`;
  else if (screen === 'home' || !session) renderHome();
  else app.innerHTML = `<div class="study-shell">${studyHeader()}${session.phase === 'complete' ? `<div class="study-notices">${recordNotice()}${markNotice()}</div>` : ''}${session.phase !== 'studying' ? renderMilestone() : session.type === 'flash' ? renderFlash() : renderQuiz()}${dialogs()}</div>`;
  animateEntries();
  animateProgress(previousProgress);
  animateSliders(previousSliders);
  if (focus) document.querySelector('#study-focus')?.focus({ preventScroll: true });
  else if (markFocus) [...app.querySelectorAll(`[data-action="${markFocus.action}"]`)]
    .find((button) => button.dataset.slider === markFocus.slider && button.dataset.value === markFocus.value && button.dataset.meaningIndex === markFocus.meaningIndex)?.focus({ preventScroll: true });
  else if (fieldFocus) document.getElementById(fieldFocus)?.focus({ preventScroll: true });
  else if (noteSelection) {
    const field = document.querySelector('#study-note');
    field?.focus({ preventScroll: true });
    field?.setSelectionRange(...noteSelection);
  }
}

async function startAIExam() {
  const ox = settings.mode === 'ai-ox';
  // Both formats draw from the marked range like a flashcard deck; O/X asks one question per word.
  const range = studyRange();
  const words = rangeWords(range);
  const count = ox ? Math.min(settings.aiOxCount, words.length) : Math.min(settings.aiCount, Math.floor(words.length / 5));
  if (!count) return;
  const keys = [...selected];
  const options = ox ? { format: 'ox', ...range, count, mode: settings.aiOxWeak ? 'weak' : 'normal', difficulty: settings.aiOxDifficulty }
    : { ...range, count, mode: settings.aiMode, difficulty: settings.aiDifficulty };
  if (pendingMarks.length) {
    announce('선택한 표시와 노트를 저장한 뒤 AI 시험을 만들어요.');
    await saveMark();
    if (pendingMarks.length) {
      announce('표시·노트 저장을 다시 시도한 뒤 AI 시험을 만들어 주세요.');
      return;
    }
  }
  await ai.start(keys, options);
}

function startSession(reviewWords = null) {
  const isFlash = reviewWords !== null || settings.mode === 'flash';
  // Missed-answer review keeps its own words; a new deck or quiz honors the chosen range.
  const words = reviewWords || rangeWords();
  if (!words.length) return;
  session = isFlash ? createFlashSession(words, settings.chunkSize, settings.shuffle) : createQuiz(words, settings.questionCount, exposure);
  activeExamId = null;
  activeFlashId = null;
  if (isFlash) {
    // Every deck is kept separately, so a new one never replaces unfinished progress.
    const range = selectedUnits().map((unit) => unit.unitTitle).join(', ');
    const title = reviewWords ? flashcardTitle(session).replace('플래시카드', '틀린 단어 복습')
      : `${rangeTitle('플래시카드')} · ${range}`;
    const deck = createFlashcard(session, title);
    learning = saveFlashcard(learning, deck);
    activeFlashId = deck.id;
  } else {
    const range = selectedUnits().map((unit) => unit.unitTitle).join(', ');
    const exam = createExam(session, `${rangeTitle('영영풀이 O/X')} · ${range}`);
    learning = saveExam(learning, exam);
    activeExamId = exam.id;
  }
  screen = 'study';
  if (session.type === 'quiz') markQuestionShown();
  persistSession();
  window.scrollTo(0, 0);
  render(true);
  announce(`${session.type === 'flash' ? '플래시카드를' : 'O/X 시험을'} 시작합니다. ${session.total}개 단어.`);
}

async function deleteExam() {
  const target = pendingDelete;
  pendingDelete = null;
  if (!target) return;
  if (target.kind === 'quiz') {
    learning = removeExam(learning, target.id);
    saveLearningState(learning);
    if (activeExamId === target.id) { session = null; activeExamId = null; }
  } else if (target.kind === 'flash') {
    learning = removeFlashcard(learning, target.id);
    saveLearningState(learning);
    if (activeFlashId === target.id) { session = null; activeFlashId = null; }
  } else {
    try { await ai.deleteExam(target.id); }
    catch (error) { deleteError = `시험을 삭제하지 못했어요. ${error.message}`; announce(deleteError); render(); return; }
  }
  announce(`삭제했어요: ${target.title}`);
  render();
}

function markQuestionShown() {
  exposure = recordExposure(exposure, session.questions[session.position]);
  write('exposure', exposure);
}

function updateStudy(next) {
  if (next === session) return;
  session = next;
  markSaved = false;
  persistSession();
  render(true);
  if (session.phase === 'complete') announce('학습을 모두 마쳤어요.');
  else if (session.phase === 'between') announce('이 구간의 모든 단어를 기억했어요. 다음 구간으로 이동할 수 있어요.');
}

function act(action, target) {
  if (ai.handleAction(action, target)) return;
  switch (action) {
    case 'book': {
      const id = target.dataset.id;
      activeBook = id;
      if (expandedBooks.has(id)) expandedBooks.delete(id); else expandedBooks.add(id);
      render(); break;
    }
    case 'select-book': {
      const units = library.books.find((book) => book.id === target.dataset.id).units;
      const remove = units.every((u) => selected.has(u.key));
      units.forEach((u) => remove ? selected.delete(u.key) : selected.add(u.key));
      selectionChanged(); break;
    }
    case 'mode': settings.mode = target.dataset.mode; rememberSettings(); render(); break;
    case 'all-questions': settings.questionCount = rangeWords().length || 1; rememberSettings(); render(); break;
    case 'reload': load(); ai.init(); break;
    case 'retry-flash-records': void flushFlashRecords(); render(); break;
    case 'retry-mark': void saveMark(); break;
    case 'slider': setSlider(target.dataset.slider, target.dataset.value); break;
    case 'mark-meaning': changeStudyMark({ meaningIndex: Number(target.dataset.meaningIndex) }); break;
    case 'feed': feedOpen = !feedOpen; window.scrollTo(0, 0); render(); break;
    case 'setup': feedOpen = false; window.scrollTo(0, 0); render(); break;
    case 'feed-filter': feedFilter = target.dataset.filter; render(); break;
    case 'feed-active': feedActiveOnly = !feedActiveOnly; render(); break;
    case 'help': document.querySelector('#help-dialog').showModal(); break;
    case 'close-dialog': target.closest('dialog').close(); break;
    case 'start':
      if (settings.mode === 'ai' || settings.mode === 'ai-ox') void startAIExam();
      else startSession();
      break;
    case 'confirm-delete-exam':
      pendingDelete = { kind: target.dataset.kind, id: target.dataset.id, title: target.dataset.title };
      deleteError = '';
      render();
      document.querySelector('#delete-dialog')?.showModal();
      break;
    case 'delete-exam': document.querySelector('#delete-dialog')?.close(); void deleteExam(); break;
    case 'open-flash': {
      const deck = learning.flashcards.find((item) => item.id === target.dataset.id);
      if (!deck) break;
      session = refreshSessionWords(deck.session); activeFlashId = deck.id; activeExamId = null; screen = 'study'; window.scrollTo(0, 0); render(true); announce('플래시카드를 이어서 학습합니다.'); break;
    }
    case 'open-exam': {
      const exam = learning.exams.find((item) => item.id === target.dataset.id);
      if (!exam) break;
      session = refreshSessionWords(exam.session); activeExamId = exam.id; activeFlashId = null; screen = 'study'; window.scrollTo(0, 0); render(true); announce(session.phase === 'complete' ? '저장된 시험 결과입니다.' : '시험을 이어서 풉니다.'); break;
    }
    case 'home': screen = 'home'; markSaved = false; window.scrollTo(0, 0); render(); announce(''); break;
    case 'reveal': if (session?.type === 'flash') { updateStudy(revealFlash(session)); announce('뜻을 확인했습니다. Enter는 아는 단어, Space는 모르는 단어입니다.'); } break;
    case 'known': case 'unknown': if (session?.type === 'flash') updateStudy(gradeFlash(session, action === 'known')); break;
    case 'next-chunk': if (session?.type === 'flash') updateStudy(nextFlashChunk(session)); break;
    case 'answer-o': case 'answer-x': if (session?.type === 'quiz') {
      const next = answerQuiz(session, action === 'answer-o');
      if (next !== session) { updateStudy(next); announce(session.answers.at(-1).correct ? '정답이에요.' : '오답이에요. 올바른 뜻을 확인해 주세요.'); }
      break;
    }
    case 'next-question': if (session?.type === 'quiz') {
      const next = nextQuestion(session);
      if (next !== session) {
        session = next;
        if (session.phase === 'studying') markQuestionShown();
        persistSession(); render(true); window.scrollTo(0, 0);
        if (session.phase === 'complete') announce('시험을 마쳤습니다. 결과를 확인해 주세요.');
      }
      break;
    }
    case 'review-missed': {
      startSession(session.questions.filter((q, i) => !session.answers[i].correct).map((q) => refreshWord(q.word)));
      break;
    }
  }
}

// toggle does not bubble, so a capturing listener records opened AI explanations before the next re-render.
app.addEventListener('toggle', (event) => { if (event.target.dataset?.reviewIndex !== undefined) ai.toggleReview(event.target); }, true);

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (target && !target.disabled) act(target.dataset.action, target);
});

// Apply valid numeric edits immediately, including while the field still has focus.
app.addEventListener('input', (event) => {
  const input = event.target;
  if (input.id === 'study-note') {
    if (session?.type === 'flash') noteDraft = { key: session.queue[session.position].key, text: input.value };
    return;
  }
  if (!Object.hasOwn(numberFields, input.id)) return;
  const value = Number(input.value);
  if (Number.isFinite(value) && value >= 1) {
    settings[numberFields[input.id]] = Math.min(fieldMax(input.id), Math.floor(value));
    rememberSettings();
  }
});

app.addEventListener('change', (event) => {
  const input = event.target;
  if (input.id === 'study-note') {
    if (session?.type !== 'flash') return;
    const note = { text: input.value, key: session.queue[session.position].key };
    // Re-rendering between mousedown and mouseup would swallow the click that blurred the field.
    if (pointerHeld) deferredNote = note; else saveStudyNote(note.text, note.key);
    return;
  }
  if (input.dataset.unit) {
    if (input.checked) selected.add(input.dataset.unit); else selected.delete(input.dataset.unit);
    const key = input.dataset.unit;
    selectionChanged();
    [...app.querySelectorAll('.tree-unit input')].find((node) => node.dataset.unit === key)?.focus({ preventScroll: true });
    return;
  }
  if (Object.hasOwn(numberFields, input.id)) {
    const value = Math.max(1, Math.min(fieldMax(input.id), Math.floor(Number(input.value) || 1)));
    settings[numberFields[input.id]] = value;
    input.value = value;
  }
  if (input.id === 'shuffle') settings.shuffle = input.checked;
  if (input.id === 'ai-unknown-only') { changeSetting('aiUnknownOnly', input.checked); return; }
  if (input.id === 'ai-weak') { settings.aiMode = input.checked ? 'weak' : 'normal'; rememberSettings(); render(); return; }
  if (input.id === 'ai-ox-unknown-only') { changeSetting('aiOxUnknownOnly', input.checked); return; }
  if (input.id === 'ai-ox-weak') { settings.aiOxWeak = input.checked; rememberSettings(); render(); return; }
  rememberSettings();
});

document.addEventListener('pointerdown', () => { pointerHeld = true; }, true);
// Dragging across a slider snaps to the nearest stop as it passes, the same as pressing that stop.
app.addEventListener('pointerdown', (event) => {
  const slider = event.button === 0 ? event.target.closest?.('.level-slider') : null;
  if (!slider) return;
  sliderDrag = { pointerId: event.pointerId, name: slider.dataset.slider };
  // A touch is captured by the pressed stop, which the next render replaces; releasing keeps the moves reaching the document.
  event.target.releasePointerCapture?.(event.pointerId);
});
document.addEventListener('pointermove', (event) => {
  if (event.pointerId !== sliderDrag?.pointerId) return;
  const { name } = sliderDrag;
  const centers = [...app.querySelectorAll(`.level-slider[data-slider="${name}"] .level-track > .level-dots .level-dot`)].map((dot) => { const box = dot.getBoundingClientRect(); return box.left + box.width / 2; });
  if (!centers.length) return;
  const nearest = centers.reduce((best, center, i) => Math.abs(event.clientX - center) < Math.abs(event.clientX - centers[best]) ? i : best, 0);
  setSlider(name, sliders[name].values[nearest]);
});
const releasePointer = () => {
  // Focus follows the chosen stop, so Tab and the arrow keys continue from it.
  if (sliderDrag && document.activeElement?.closest?.('.level-slider')) app.querySelector(`.level-slider[data-slider="${sliderDrag.name}"] .level-stop[aria-checked="true"]`)?.focus({ preventScroll: true });
  sliderDrag = null;
  // Click follows pointerup in the same task, so the timeout runs after the click's own action.
  setTimeout(() => {
    pointerHeld = false;
    const note = deferredNote;
    deferredNote = null;
    if (note) saveStudyNote(note.text, note.key);
  }, 0);
};
document.addEventListener('pointerup', releasePointer, true);
document.addEventListener('pointercancel', releasePointer, true);

document.addEventListener('keydown', (event) => {
  // Blurring commits the note (change event) and hands the keyboard back to study shortcuts.
  if (event.key === 'Escape' && event.target.id === 'study-note') { event.target.blur(); return; }
  if (event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || document.querySelector('dialog[open]') || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  // Arrow keys move along a slider once one of its stops has focus, as in a radio group.
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
  if (step && event.target.dataset?.action === 'slider' && sliders[event.target.dataset.slider]) { event.preventDefault(); moveSlider(event.target.dataset.slider, step); return; }
  if (screen === 'ai') { ai.keydown(event); return; }
  if (screen !== 'study' || !session) return;
  // Native controls keep their Enter/Space behavior; the card uses study shortcuts.
  // Mark toggles keep focus after a click, so Enter/Space must still grade the card there.
  if (['Enter', ' '].includes(event.key) && event.target.closest('button:not([data-action="slider"], [data-action="mark-meaning"]), a, summary')) return;
  const key = event.key.toLowerCase();
  let action;
  if (session.type === 'flash') {
    if (session.phase === 'between' && key === 'enter') action = 'next-chunk';
    else if (session.phase === 'studying') {
      // Physical key codes keep Q/W/E/R working while a Korean input source is active.
      const level = levelCodes[event.code];
      if (level) { event.preventDefault(); changeStudyMark({ level }); return; }
      const meaningIndex = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
      const card = session.queue[session.position];
      if (session.revealed && hasMeaningChoice(card) && card.meanings[meaningIndex]) { event.preventDefault(); changeStudyMark({ meaningIndex }); return; }
      if (key === ' ') action = session.revealed ? 'unknown' : 'reveal';
      else if (key === 'enter' && session.revealed) action = 'known';
    }
  } else if (session.phase === 'studying') {
    if (session.revealed && ['enter', ' '].includes(key)) action = 'next-question';
    else if (!session.revealed && (event.code === 'KeyO' || event.code === 'KeyX')) action = event.code === 'KeyO' ? 'answer-o' : 'answer-x';
  }
  if (action) { event.preventDefault(); act(action); }
  else if (key === ' ' || key === 'enter') event.preventDefault();
});

load();
void ai.init();
