import test from 'node:test';
import assert from 'node:assert/strict';

const PREFIX = 'wordpop.v1.';
const meanings = [
  { ko: '은행', en: 'an organization that keeps and lends money' },
  { ko: '강둑', en: 'the land along the side of a river' },
];
const keys = meanings.map((meaning) => `${meaning.ko}\u001f${meaning.en}`);
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
let moduleSequence = 0;

// Exercise the app's actual rendering, keyboard handlers, persistence, and requests
// with only the DOM operations used by the flashcard flow.
async function setup(t, { stored = {}, wordCount = 1, library = null } = {}) {
  const originals = Object.fromEntries(['document', 'window', 'fetch', 'localStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const storage = new Map(Object.entries({ selection: ['book:1'], settings: { shuffle: false }, ...stored }).map(([key, value]) => [PREFIX + key, JSON.stringify(value)]));
  const app = { innerHTML: '', events: {}, addEventListener(event, handler) { this.events[event] = handler; }, querySelectorAll() { return []; } };
  const documentEvents = {};
  const announcer = { textContent: '' };
  const deleteDialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const restartDialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const calls = [];
  const pending = [];
  const words = Array.from({ length: wordCount }, (_, index) => ({ id: index ? `word-${index}` : 'bank', word: index ? `word-${index}` : 'bank', meanings, studyLevel: 'off', unknownMeaningKeys: [] }));
  const state = {
    failMarks: false,
    nextMarkGate: null,
    nextLibraryGate: null,
    jobs: [],
    aiExams: [],
    failDelete: false,
    library: library ?? { warnings: [], books: [{ id: 'book', title: 'Test book', units: [{ key: 'book:1', bookId: 'book', bookTitle: 'Test book', unitId: '1', unitTitle: '1과', words }] }] },
  };
  globalThis.localStorage = {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, value); },
    removeItem(key) { storage.delete(key); },
  };
  globalThis.window = { scrollTo() {} };
  globalThis.document = {
    addEventListener(event, handler) { documentEvents[event] = handler; },
    querySelector(selector) { return { '#app': app, '#announcer': announcer, '#delete-dialog': deleteDialog, '#restart-dialog': restartDialog }[selector] ?? null; },
  };
  globalThis.fetch = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path === '/api/library') {
      const snapshot = structuredClone(state.library);
      const gate = state.nextLibraryGate;
      state.nextLibraryGate = null;
      if (gate) await gate.promise;
      return { ok: true, json: async () => snapshot };
    }
    if (path === '/api/ai/exams') return { ok: true, json: async () => structuredClone(state.aiExams) };
    if (path === '/api/flash-records') return { ok: true, json: async () => ({ saved: true }) };
    const examPath = path.match(/^\/api\/ai\/exams\/([^/]+)$/);
    if (examPath && options.method === 'DELETE') {
      if (state.failDelete) return { ok: false, status: 500, json: async () => ({ error: '파일을 지우지 못했습니다.' }) };
      state.aiExams = state.aiExams.filter((exam) => exam.examId !== decodeURIComponent(examPath[1]));
      return { ok: true, json: async () => ({ examId: decodeURIComponent(examPath[1]), deleted: true }) };
    }
    if (path === '/api/ai/jobs' && options.method === 'POST') {
      state.jobs.push({ body: JSON.parse(options.body), word: structuredClone(state.library.books[0].units[0].words[0]) });
      return { ok: true, json: async () => ({ id: 'test-job', status: 'complete' }) };
    }
    assert.equal(path, '/api/word-mark', 'The fixture must cover every request made by this flow');
    assert.equal(options.method, 'PATCH');
    const gate = state.nextMarkGate;
    state.nextMarkGate = null;
    if (gate) await gate.promise;
    if (state.failMarks) return { ok: false, status: 503, json: async () => ({ error: '표시 저장 실패' }) };
    const body = JSON.parse(options.body);
    const units = state.library.books.flatMap((book) => book.units);
    const sources = body.sourceRefs.map((ref) => units.find((unit) => unit.key === ref.unitKey)?.words.find((word) => word.id === ref.wordId));
    assert(sources.every(Boolean), 'The mark request must identify existing source words');
    const canonical = typeof body.studyLevel === 'string';
    assert(!Object.hasOwn(body, 'studyMarks'), 'The app no longer sends independent flags');
    const unknownMeaningKeys = body.unknownMeaningKeys ?? [...new Set(sources.flatMap((word) => word.unknownMeaningKeys))];
    const level = body.studyLevel ?? ({ unknown: 'unknown', unsure: 'review', review: 'review' }[body.mark] || 'off');
    const saved = { studyLevel: level === 'off' && unknownMeaningKeys.length ? 'review' : level, unknownMeaningKeys };
    if (typeof body.studyNote === 'string') saved.studyNote = body.studyNote.trim();
    for (const word of sources) {
      if (typeof body.studyNote === 'string') { if (saved.studyNote) word.studyNote = saved.studyNote; else delete word.studyNote; }
      word.studyLevel = saved.studyLevel;
      delete word.studyMarks;
      if (canonical) word.unknownMeaningKeys = saved.unknownMeaningKeys.filter((key) => word.meanings.some((meaning) => `${meaning.ko}\u001f${meaning.en}` === key));
    }
    return { ok: true, json: async () => ({ updated: 1, ...saved }) };
  };
  t.after(async () => {
    for (const gate of pending) gate.resolve();
    await settle();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const ui = {
    state, calls, deleteDialog,
    get html() { return app.innerHTML; },
    get marks() { return calls.filter((call) => call.path === '/api/word-mark').map((call) => JSON.parse(call.body)); },
    saved(key) { return JSON.parse(storage.get(PREFIX + key) ?? 'null'); },
    // The newest saved deck, which is the one a test just started.
    get flash() { return this.saved('learning').flashcards[0]?.session ?? null; },
    button(action, attributes = {}) {
      return [...app.innerHTML.matchAll(/<button\b[^>]*>/g)].map(([html]) => ({
        html, attributes: Object.fromEntries([...html.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value])),
      })).find((button) => button.attributes['data-action'] === action && Object.entries(attributes).every(([name, value]) => button.attributes[`data-${name}`] === String(value)));
    },
    click(action, attributes = {}) {
      const button = this.button(action, attributes);
      assert(button, `Missing button ${action} ${JSON.stringify(attributes)}`);
      const dataset = Object.fromEntries(Object.entries(button.attributes).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
      const target = { dataset, disabled: /\sdisabled(?:\s|>|=)/.test(button.html) };
      app.events.click({ target: { closest() { return target; } } });
    },
    // `focused` is the dataset (or just the data-action) of the button that holds keyboard focus.
    press(key, { code = '', focused = null } = {}) {
      let prevented = false;
      const dataset = typeof focused === 'string' ? { action: focused } : focused;
      const button = dataset ? { dataset } : null;
      const matches = (selector) => selector.startsWith('button') && !selector.includes(`[data-action="${dataset.action}"]`);
      documentEvents.keydown({ key, code, target: { dataset: dataset ?? {}, closest(selector) { return button && matches(selector) ? button : null; } }, preventDefault() { prevented = true; } });
      return prevented;
    },
    change(target) { app.events.change({ target: { dataset: {}, ...target } }); },
    typeNote(text) { app.events.input({ target: { id: 'study-note', value: text } }); },
    commitNote(text) { app.events.input({ target: { id: 'study-note', value: text } }); app.events.change({ target: { id: 'study-note', value: text } }); },
    pointer(type) { documentEvents[type](); },
    get note() { return app.innerHTML.match(/<textarea id="study-note"[^>]*>([^<]*)<\/textarea>/)?.[1]; },
    holdNextMark() { const gate = deferred(); pending.push(gate); state.nextMarkGate = gate; return gate; },
    holdNextLibrary() { const gate = deferred(); pending.push(gate); state.nextLibraryGate = gate; return gate; },
    async reload() {
      app.events = {};
      for (const key of Object.keys(documentEvents)) delete documentEvents[key];
      await import(`../public/js/app.js?ui-test=${++moduleSequence}`);
      await settle();
    },
  };
  await ui.reload();
  return ui;
}

/** A study-level stop that holds keyboard focus. */
const levelStop = { action: 'slider', slider: 'study-level' };

/** Exactly one slider stop is checked, and only it takes part in the Tab order. */
function assertLevel(ui, level) {
  for (const value of ['priority', 'unknown', 'review', 'off']) {
    const stop = ui.button('slider', { slider: 'study-level', value });
    assert.equal(stop?.attributes['aria-checked'], String(value === level), value);
    assert.equal(stop.attributes.tabindex, value === level ? '0' : '-1');
  }
  assert.match(ui.html, new RegExp(`data-slider="study-level" data-key="[^"]*" data-value="${level}"`));
}

function assertMeaning(ui, index, selected) {
  assert.equal(ui.button('mark-meaning', { 'meaning-index': index })?.attributes['aria-pressed'], String(selected));
}

function assertNoProgress(ui, revealed) {
  const flash = ui.flash;
  assert.equal(flash.position, 0);
  assert.equal(flash.attempts, 0);
  assert.equal(flash.mastered, 0);
  assert.equal(flash.revealed, revealed);
}

test('Flashcard shortcuts Q W E R pick exactly one level without revealing or advancing the card', async (t) => {
  const ui = await setup(t);
  ui.click('start');
  assertLevel(ui, 'off');
  for (const [key, level] of [['q', 'priority'], ['w', 'unknown'], ['e', 'review'], ['r', 'off'], ['w', 'unknown']]) {
    assert.equal(ui.press(key, { code: `Key${key.toUpperCase()}` }), true);
    await settle();
    assertLevel(ui, level);
    assert.deepEqual(ui.marks.at(-1), { sourceRefs: ui.marks.at(-1).sourceRefs, studyLevel: level, unknownMeaningKeys: [] });
    assert.equal(ui.state.library.books[0].units[0].words[0].studyLevel, level);
  }
  assert.equal(ui.marks.length, 5);
  assert.equal(ui.press('w', { code: 'KeyW' }), true);
  await settle();
  assert.equal(ui.marks.length, 5, 'Choosing the level already shown sends nothing');
  assert.equal(ui.press('1'), false, 'Meaning numbers do nothing before the meanings are revealed');
  assert.equal(ui.press('3'), false);
  await settle();
  assert.equal(ui.marks.length, 5);
  ui.click('slider', { slider: 'study-level', value: 'priority' });
  await settle();
  assertLevel(ui, 'priority');
  assert.match(ui.html, /aria-label="학습 필요성"/);
  assert.match(ui.html, /우선 학습<\/span><kbd>Q<\/kbd>.*모름<\/span><kbd>W<\/kbd>.*복습 필요<\/span><kbd>E<\/kbd>.*끔<\/span><kbd>R<\/kbd>/);
  assertNoProgress(ui, false);
});

test('Arrow keys move along the slider only while one of its stops has focus', async (t) => {
  const ui = await setup(t);
  ui.click('start');
  assert.equal(ui.press('ArrowLeft'), false, 'Arrows do nothing while focus is elsewhere');
  await settle();
  assert.equal(ui.marks.length, 0);
  assert.equal(ui.press('ArrowLeft', { focused: levelStop }), true);
  await settle();
  assertLevel(ui, 'review');
  ui.press('ArrowUp', { focused: levelStop });
  ui.press('ArrowLeft', { focused: levelStop });
  await settle();
  assertLevel(ui, 'priority');
  assert.equal(ui.press('ArrowLeft', { focused: levelStop }), true);
  await settle();
  assertLevel(ui, 'priority');
  const requestCount = ui.marks.length;
  ui.press('ArrowRight', { focused: levelStop });
  await settle();
  assertLevel(ui, 'unknown');
  assert.equal(ui.marks.length, requestCount + 1);
  assertNoProgress(ui, false);
});

test('A green curtain shows only the word, then drops to the 아직 모르겠어요 strip, with 알고 있어요 outside the card', async (t) => {
  const ui = await setup(t, { wordCount: 2 });
  ui.click('start');
  const closed = ui.button('reveal');
  assert.match(closed.html, /class="flash-curtain"/);
  assert.match(ui.html, /class="flash-curtain" data-action="reveal"><span class="curtain-word" lang="en">bank<\/span>/);
  assert.match(ui.button('known').html, / inert/, 'The 알고 있어요 button waits until the card is revealed');
  assert.match(ui.html, /<\/section><button type="button" class="flash-known"/, 'The 알고 있어요 button sits outside the card');
  assert.match(ui.html, /<textarea id="study-note" rows="1" aria-label="내 노트"/, 'The note field keeps its name for screen readers');
  assert.doesNotMatch(ui.html, />내 노트</, 'No visible 내 노트 label');
  assert.equal(ui.button('unknown'), undefined);
  assert.doesNotMatch(ui.html, /class="study-actions"/, 'The answer buttons live inside the card now');
  ui.click('reveal');
  assert.equal(ui.button('reveal'), undefined);
  assert.match(ui.button('unknown').html, /class="flash-curtain" data-action="unknown" data-enter="curtain:bank:1"/);
  assert.match(ui.button('known').html, /data-enter="known:bank:1"/);
  assert.match(ui.html, /아직 모르겠어요<kbd>Space<\/kbd>/);
  assert.doesNotMatch(ui.button('known').html, /inert/);
  assert.match(ui.html, /<span class="flash-known-arrow">[\s\S]*<\/span><span>알고 있어요<\/span><kbd>Enter<\/kbd>/);
  ui.click('unknown');
  assert.equal(ui.flash.attempts, 1);
  assert.equal(ui.flash.revealed, false, 'The next card starts under the curtain again');
  ui.click('reveal');
  ui.click('known');
  assert.equal(ui.flash.mastered, 1);
});

test('A single-meaning word has no 이 뜻 모름 choice, and its number key does nothing', async (t) => {
  const library = { warnings: [], books: [{ id: 'book', title: 'Test book', units: [{ key: 'book:1', bookId: 'book', bookTitle: 'Test book', unitId: '1', unitTitle: '1과',
    words: [{ id: 'solo', word: 'solo', meanings: [meanings[0]], studyLevel: 'off', unknownMeaningKeys: [] }, { id: 'bank', word: 'bank', meanings, studyLevel: 'off', unknownMeaningKeys: [] }] }] }] };
  const ui = await setup(t, { library });
  ui.click('start');
  ui.click('reveal');
  assert.equal(ui.button('mark-meaning', { 'meaning-index': 0 }), undefined);
  assert.doesNotMatch(ui.html, /selectable-meaning/);
  assert.equal(ui.press('1'), false);
  await settle();
  assert.equal(ui.marks.length, 0);
  assert.equal(ui.press('0'), false, 'There is no all-meanings key');
  assert.equal(ui.button('mark-all-meanings'), undefined);
  ui.click('known');
  ui.click('reveal');
  assert.ok(ui.button('mark-meaning', { 'meaning-index': 1 }), 'A word with several meanings keeps its choices');
  assert.equal(ui.button('mark-all-meanings'), undefined);
});

test('Choosing an unknown meaning lifts 끔 to 복습 필요 and leaves any stronger level alone', async (t) => {
  const ui = await setup(t);
  ui.click('start');
  ui.click('mark-meaning', { 'meaning-index': 0 });
  await settle();
  assert.equal(ui.marks.length, 0, 'Meanings under the curtain cannot be marked');
  ui.click('reveal');
  ui.click('mark-meaning', { 'meaning-index': 1 });
  await settle();
  assertMeaning(ui, 0, false);
  assertMeaning(ui, 1, true);
  assertLevel(ui, 'review');
  assert.deepEqual(ui.marks.at(-1), { sourceRefs: ui.marks.at(-1).sourceRefs, studyLevel: 'review', unknownMeaningKeys: [keys[1]] });
  assert.equal(ui.marks.at(-1).sourceRefs[0].wordId, 'bank');
  ui.press('q', { code: 'KeyQ' });
  await settle();
  assertLevel(ui, 'priority');
  assert.deepEqual(ui.marks.at(-1).unknownMeaningKeys, [keys[1]], 'A stronger level keeps the chosen meanings');
  assert.doesNotMatch(ui.html, /모든 뜻을 복습 대상으로/, 'A word level no longer claims every meaning is unknown');
  ui.click('mark-meaning', { 'meaning-index': 0 });
  await settle();
  assertMeaning(ui, 0, true);
  assertMeaning(ui, 1, true);
  assertLevel(ui, 'priority');
  assert.deepEqual(new Set(ui.marks.at(-1).unknownMeaningKeys), new Set(keys));
  ui.click('mark-meaning', { 'meaning-index': 1 });
  await settle();
  assertMeaning(ui, 0, true);
  assertMeaning(ui, 1, false);
  assert.deepEqual(ui.marks.at(-1).unknownMeaningKeys, [keys[0]]);
  assertLevel(ui, 'priority');
  ui.press('e', { code: 'KeyE' });
  await settle();
  assertLevel(ui, 'review');
  assert.doesNotMatch(ui.html, /모든 뜻을 복습 대상으로/);
  ui.click('mark-meaning', { 'meaning-index': 0 });
  await settle();
  assertMeaning(ui, 0, false);
  assertLevel(ui, 'review');
  assert.deepEqual(ui.marks.at(-1), { sourceRefs: ui.marks.at(-1).sourceRefs, studyLevel: 'review', unknownMeaningKeys: [] }, 'Clearing the last meaning does not lower the level');
  ui.click('mark-meaning', { 'meaning-index': 1 });
  await settle();
  ui.press('r', { code: 'KeyR' });
  await settle();
  assertLevel(ui, 'off');
  assertMeaning(ui, 1, false);
  assert.deepEqual(ui.marks.at(-1), { sourceRefs: ui.marks.at(-1).sourceRefs, studyLevel: 'off', unknownMeaningKeys: [] }, '끔 also clears the chosen meanings');
  assertNoProgress(ui, true);
});

test('Number keys toggle unknown meanings in order once the meanings are revealed', async (t) => {
  const ui = await setup(t);
  ui.click('start');
  ui.click('reveal');
  assert.equal(ui.press('2'), true);
  await settle();
  assertMeaning(ui, 0, false);
  assertMeaning(ui, 1, true);
  assert.equal(ui.press('1'), true);
  await settle();
  assert.deepEqual(new Set(ui.marks.at(-1).unknownMeaningKeys), new Set(keys));
  assert.equal(ui.press('3'), false, 'A number without a matching meaning is ignored');
  ui.press('2');
  await settle();
  assertMeaning(ui, 0, true);
  assertMeaning(ui, 1, false);
  assert.equal(ui.marks.at(-1).studyLevel, 'review');
  assertLevel(ui, 'review');
  assert.match(ui.button('mark-meaning', { 'meaning-index': 1 }).html, /aria-label="2번째 뜻 모름/);
  assertNoProgress(ui, true);
});

test('Enter and Space grade the card even while a mark button keeps focus', async (t) => {
  const ui = await setup(t, { wordCount: 2 });
  ui.click('start');
  ui.click('slider', { slider: 'study-level', value: 'review' });
  await settle();
  assert.equal(ui.press(' ', { focused: levelStop }), true);
  assertLevel(ui, 'review');
  assert.equal(ui.flash.revealed, true, 'Space reveals instead of toggling the focused mark');
  ui.click('mark-meaning', { 'meaning-index': 0 });
  await settle();
  const requestCount = ui.marks.length;
  assert.equal(ui.press('Enter', { focused: 'mark-meaning' }), true);
  await settle();
  assert.equal(ui.marks.length, requestCount, 'Enter must not toggle the focused meaning again');
  assert.equal(ui.flash.mastered, 1);
  ui.click('reveal');
  ui.click('slider', { slider: 'study-level', value: 'unknown' });
  await settle();
  assert.equal(ui.press(' ', { focused: levelStop }), true);
  assert.equal(ui.flash.attempts, 2, 'Space marks the revealed card as not yet known');
  assert.equal(ui.press('Enter', { focused: 'home' }), false, 'Other buttons keep their native Enter behavior');
});

test('A study note saves on blur, keeps its draft across re-renders and survives later mark-only saves', async (t) => {
  const ui = await setup(t);
  ui.click('start');
  assert.match(ui.html, /<div class="flash-content" inert>[\s\S]*<textarea id="study-note"/, 'The note waits under the curtain until the meanings are revealed');
  ui.click('reveal');
  assert.doesNotMatch(ui.html, /class="flash-content" inert/);
  assert.equal(ui.note, '');
  ui.typeNote('bench와 헷갈림');
  ui.press('w', { code: 'KeyW' });
  await settle();
  assert.equal(ui.note, 'bench와 헷갈림', 'Re-rendering must not erase unsaved note text');
  assert.equal(ui.marks.at(-1).studyNote, undefined);
  ui.commitNote('  bench와 헷갈림 ');
  await settle();
  assert.equal(ui.marks.at(-1).studyNote, 'bench와 헷갈림');
  assert.equal(ui.marks.at(-1).studyLevel, 'unknown');
  assert.equal(ui.state.library.books[0].units[0].words[0].studyNote, 'bench와 헷갈림');
  const requestCount = ui.marks.length;
  ui.commitNote('bench와 헷갈림');
  await settle();
  assert.equal(ui.marks.length, requestCount, 'An unchanged note is not saved again');
  ui.press('q', { code: 'KeyQ' });
  await settle();
  assert.equal(Object.hasOwn(ui.marks.at(-1), 'studyNote'), false, 'Mark-only saves leave the stored note alone');
  assert.equal(ui.state.library.books[0].units[0].words[0].studyNote, 'bench와 헷갈림');
  assert.equal(ui.note, 'bench와 헷갈림');
  ui.commitNote('');
  await settle();
  assert.equal(ui.marks.at(-1).studyNote, '');
  assert.equal(Object.hasOwn(ui.state.library.books[0].units[0].words[0], 'studyNote'), false);
  assertNoProgress(ui, true);
});

test('A queued note is kept when a mark toggle replaces it before the slow save finishes', async (t) => {
  const ui = await setup(t);
  ui.click('start');
  ui.click('reveal');
  const firstSave = ui.holdNextMark();
  ui.press('w', { code: 'KeyW' });
  ui.commitNote('river bank');
  ui.press('q', { code: 'KeyQ' });
  firstSave.resolve();
  await settle();
  assert.deepEqual(ui.marks.at(-1), { sourceRefs: ui.marks.at(-1).sourceRefs, studyLevel: 'priority', unknownMeaningKeys: [], studyNote: 'river bank' });
  assert.equal(ui.state.library.books[0].units[0].words[0].studyNote, 'river bank');
  assert.equal(ui.saved('pending-word-marks')?.length ?? 0, 0);
});

test('Clicking an answer button to leave the note field still advances and saves the note for the previous card', async (t) => {
  const ui = await setup(t, { wordCount: 2 });
  ui.click('start');
  ui.click('reveal');
  ui.typeNote('money bank');
  ui.pointer('pointerdown');
  // Blur fires change during mousedown; saving must wait until the click has run.
  ui.commitNote('money bank');
  assert.equal(ui.marks.length, 0);
  ui.click('known');
  ui.pointer('pointerup');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await settle();
  assert.equal(ui.flash.mastered, 1);
  assert.equal(ui.marks.at(-1).studyNote, 'money bank');
  assert.equal(ui.marks.at(-1).sourceRefs[0].wordId, 'bank');
  assert.equal(ui.state.library.books[0].units[0].words[0].studyNote, 'money bank');
  assert.equal(ui.state.library.books[0].units[0].words[1].studyNote, undefined);
});

test('Deleting a local O/X exam asks first, then removes only that exam and its answers', async (t) => {
  const ui = await setup(t, { wordCount: 5, stored: { settings: { shuffle: false, mode: 'quiz', questionCount: 2 } } });
  ui.click('start');
  ui.click('home');
  ui.click('mode', { mode: 'flash' });
  ui.click('start');
  ui.click('home');
  ui.click('feed');
  const [exam] = ui.saved('learning').exams;
  assert.equal(ui.saved('learning').flashcards.length, 1, 'The test keeps an unfinished flashcard deck alongside the exam');
  const row = ui.button('confirm-delete-exam', { id: exam.id });
  assert.equal(row.attributes['data-kind'], 'quiz');
  ui.click('confirm-delete-exam', { id: exam.id });
  assert.equal(ui.deleteDialog.open, true);
  assert.match(ui.html, /시험을 삭제할까요\?/);
  assert.equal(ui.saved('learning').exams.length, 1, 'Nothing is removed before confirming');
  ui.click('delete-exam');
  assert.equal(ui.deleteDialog.open, false);
  assert.deepEqual(ui.saved('learning').exams, []);
  assert.equal(ui.saved('learning').flashcards.length, 1, 'The flashcard deck is not part of the deleted exam');
  assert.equal(ui.button('open-exam', { id: exam.id }), undefined);
});

test('Deleting an AI exam calls the server, forgets its local draft and keeps the entry when deletion fails', async (t) => {
  const exam = { examId: '2026-09-27-001', type: 'ai-test', status: 'studying', createdAt: '2026-09-27T01:00:00.000Z', questionCount: 1, answeredCount: 0,
    selectedScope: [{ bookId: 'book', bookTitle: 'Test book', unitIds: ['1'], units: [{ unitId: '1', unitTitle: '1과' }] }] };
  const ui = await setup(t, { stored: { 'ai-drafts': { [exam.examId]: { answers: [1], position: 0 } } } });
  ui.state.aiExams = [exam];
  await ui.reload();
  ui.click('feed');
  ui.state.failDelete = true;
  ui.click('confirm-delete-exam', { id: exam.examId });
  assert.equal(ui.button('confirm-delete-exam', { id: exam.examId }).attributes['data-kind'], 'ai');
  assert.match(ui.html, /시험 JSON과 결과 Markdown도 함께 지우며/);
  ui.click('delete-exam');
  await settle();
  assert.match(ui.html, /시험을 삭제하지 못했어요\. 파일을 지우지 못했습니다\./);
  assert(ui.button('ai-open', { id: exam.examId }), 'A failed delete keeps the exam listed');
  ui.state.failDelete = false;
  ui.click('confirm-delete-exam', { id: exam.examId });
  assert.doesNotMatch(ui.html, /시험을 삭제하지 못했어요/);
  ui.click('delete-exam');
  await settle();
  assert.equal(ui.calls.filter((call) => call.method === 'DELETE').length, 2);
  assert.equal(ui.button('ai-open', { id: exam.examId }), undefined);
  assert.deepEqual(ui.saved('ai-drafts'), {});
});

test('Rapid level changes remain responsive and save the latest level after a slow request', async (t) => {
  const ui = await setup(t);
  ui.click('start');
  const firstSave = ui.holdNextMark();
  ui.press('q', { code: 'KeyQ' });
  ui.press('w', { code: 'KeyW' });
  ui.press('e', { code: 'KeyE' });
  assertLevel(ui, 'review');
  assert.equal(ui.marks.length, 1);
  assertNoProgress(ui, false);
  firstSave.resolve();
  await settle();
  assert.equal(ui.marks.length, 2, 'Only the latest queued state needs a second request');
  assert.equal(ui.marks.at(-1).studyLevel, 'review');
  assert.equal(ui.state.library.books[0].units[0].words[0].studyLevel, 'review');
  assertLevel(ui, 'review');
  assert.equal(ui.saved('pending-word-marks')?.length ?? 0, 0);
});

test('Failed meaning saves remain visible and retry after reload without losing the selected meaning', async (t) => {
  const ui = await setup(t);
  ui.click('start');
  ui.click('reveal');
  ui.state.failMarks = true;
  ui.click('mark-meaning', { 'meaning-index': 1 });
  await settle();
  assertMeaning(ui, 1, true);
  assert.equal(ui.saved('pending-word-marks').length, 1);
  assert(ui.button('retry-mark'));
  assertNoProgress(ui, true);
  await ui.reload();
  ui.click('feed');
  ui.click('open-flash', { id: ui.saved('learning').flashcards[0].id });
  assertMeaning(ui, 0, false);
  assertMeaning(ui, 1, true);
  assert.equal(ui.saved('pending-word-marks').length, 1);
  ui.state.failMarks = false;
  ui.click('retry-mark');
  await settle();
  assert.deepEqual(ui.marks.at(-1).unknownMeaningKeys, [keys[1]]);
  assert.equal(ui.marks.at(-1).studyLevel, 'review');
  assert.equal(ui.saved('pending-word-marks')?.length ?? 0, 0);
  assertNoProgress(ui, true);
});

test('A stale library response cannot erase a mark saved while the reload was in flight', async (t) => {
  const ui = await setup(t);
  ui.click('start');
  const markSave = ui.holdNextMark();
  ui.press('q', { code: 'KeyQ' });
  ui.click('home');
  const libraryReload = ui.holdNextLibrary();
  ui.click('reload');
  markSave.resolve();
  await settle();
  assert.equal(ui.state.library.books[0].units[0].words[0].studyLevel, 'priority');
  libraryReload.resolve();
  await settle();
  assert.equal(ui.calls.filter((call) => call.path === '/api/library').length, 3, 'Reload must fetch again when its old snapshot predates a completed save');
  ui.click('feed');
  ui.click('open-flash', { id: ui.saved('learning').flashcards[0].id });
  assertLevel(ui, 'priority');
  ui.press('w', { code: 'KeyW' });
  await settle();
  assert.equal(ui.marks.at(-1).studyLevel, 'unknown');
  assertLevel(ui, 'unknown');
  assertNoProgress(ui, false);
});

test('Legacy pending single-mark saves migrate into the mark queue', async (t) => {
  const ui = await setup(t, { stored: { 'pending-word-mark': { sourceRefs: [{ unitKey: 'book:1', wordId: 'bank', meaningKeys: keys }], mark: 'unsure', word: 'bank' } } });
  assert.equal(ui.marks.length, 1);
  assert.equal(ui.state.library.books[0].units[0].words[0].studyLevel, 'review');
  assert.deepEqual(ui.state.library.books[0].units[0].words[0].unknownMeaningKeys, []);
  assert.equal(ui.saved('pending-word-mark'), null);
  assert.equal(ui.saved('pending-word-marks')?.length ?? 0, 0);
  ui.click('start');
  assertLevel(ui, 'review');
});

test('Saves queued with both old flags go out as 모름, and a lone unknown meaning as 복습 필요', async (t) => {
  const sourceRefs = [{ unitKey: 'book:1', wordId: 'bank', meaningKeys: keys }];
  const ui = await setup(t, { wordCount: 2, stored: { 'pending-word-marks': [
    { sourceRefs, word: 'bank', studyMarks: ['unknown', 'review'], unknownMeaningKeys: [], studyNote: '둑' },
    { sourceRefs: [{ unitKey: 'book:1', wordId: 'word-1', meaningKeys: keys }], word: 'word-1', studyMarks: [], unknownMeaningKeys: [keys[0]] },
  ] } });
  assert.deepEqual(ui.marks, [
    { sourceRefs, studyLevel: 'unknown', unknownMeaningKeys: [], studyNote: '둑' },
    { sourceRefs: [{ unitKey: 'book:1', wordId: 'word-1', meaningKeys: keys }], studyLevel: 'review', unknownMeaningKeys: [keys[0]] },
  ]);
  assert.deepEqual(ui.state.library.books[0].units[0].words.map((word) => word.studyLevel), ['unknown', 'review']);
  assert.equal(ui.saved('pending-word-marks')?.length ?? 0, 0);
});

test('Library words saved with both old flags show the 모름 stop', async (t) => {
  const library = { warnings: [], books: [{ id: 'book', title: 'Test book', units: [{ key: 'book:1', bookId: 'book', bookTitle: 'Test book', unitId: '1', unitTitle: '1과',
    words: [{ id: 'bank', word: 'bank', meanings, studyMarks: ['unknown', 'review'], unknownMeaningKeys: [] }] }] }] };
  const ui = await setup(t, { library });
  ui.click('start');
  assertLevel(ui, 'unknown');
  assert.equal(ui.marks.length, 0, 'Reading an old mark does not rewrite it');
  ui.press('e', { code: 'KeyE' });
  await settle();
  assert.equal(ui.state.library.books[0].units[0].words[0].studyLevel, 'review');
  assert.equal(Object.hasOwn(ui.state.library.books[0].units[0].words[0], 'studyMarks'), false);
});

test('Legacy flag saves preserve separate unknown-meaning selections for overlapping source words', async (t) => {
  const units = ['1', '2'].map((id) => ({ key: `book:${id}`, bookId: 'book', bookTitle: 'Test book', unitId: id, unitTitle: `${id}과`,
    words: [{ id: 'bank', word: 'bank', meanings, studyLevel: 'off', unknownMeaningKeys: id === '1' ? [keys[1]] : [] }] }));
  const sourceRefs = units.map((unit) => ({ unitKey: unit.key, bookId: unit.bookId, unitId: unit.unitId, wordId: 'bank', meaningKeys: keys }));
  const ui = await setup(t, { library: { warnings: [], books: [{ id: 'book', title: 'Test book', units }] },
    stored: { selection: ['book:2'], 'pending-word-mark': { sourceRefs, mark: 'review', word: 'bank' } } });
  assert.deepEqual(units[0].words[0].unknownMeaningKeys, [keys[1]]);
  assert.deepEqual(units[1].words[0].unknownMeaningKeys, [], 'A legacy flag write leaves each original sense selection intact');
  ui.click('start');
  ui.click('reveal');
  assertLevel(ui, 'review');
  assertMeaning(ui, 0, false);
  assertMeaning(ui, 1, false);
  ui.press('q', { code: 'KeyQ' });
  await settle();
  assert.deepEqual(ui.marks.at(-1).unknownMeaningKeys, [], 'A later level edit must not copy a different source\'s unknown sense');
});

test('AI generation waits for pending meaning marks and stays blocked when saving fails', async (t) => {
  const ui = await setup(t, { wordCount: 5 });
  ui.click('start');
  ui.press('w', { code: 'KeyW' });
  await settle();
  ui.click('reveal');
  ui.state.failMarks = true;
  ui.click('mark-meaning', { 'meaning-index': 1 });
  await settle();
  ui.click('home');
  ui.click('mode', { mode: 'ai' });
  ui.click('start');
  await settle();
  assert.equal(ui.state.jobs.length, 0, 'AI must not generate from the old server marks after a failed save');
  assert.equal(ui.saved('pending-word-marks').length, 1);
  ui.state.failMarks = false;
  const save = ui.holdNextMark();
  ui.click('start');
  await settle();
  assert.equal(ui.state.jobs.length, 0, 'AI must await the mark request before creating the generation job');
  save.resolve();
  await settle();
  assert.equal(ui.state.jobs.length, 1);
  assert.deepEqual(ui.state.jobs[0].body.unitKeys, ['book:1']);
  assert.equal(ui.state.jobs[0].word.studyLevel, 'unknown');
  assert.deepEqual(ui.state.jobs[0].word.unknownMeaningKeys, [keys[1]]);
  assert.equal(ui.saved('pending-word-marks')?.length ?? 0, 0);
});

/** The count shown under each range stop, left to right. */
const rangeNotes = (ui) => ['all', 'review', 'unknown', 'priority'].map((value) => ui.html.match(new RegExp(`data-slider="scope" data-value="${value}"[^>]*><span>[^<]*</span><span class="level-stop-note">([^<]*)</span>`))?.[1]);

test('A new flashcard deck draws from the range slider, each stop taking its level and every stronger one', async (t) => {
  const word = (id, state) => ({ id, word: id, meanings, studyLevel: 'off', unknownMeaningKeys: [], ...state });
  const words = [
    word('plain'), word('priority', { studyLevel: 'priority' }), word('unknown', { studyLevel: 'unknown' }), word('sense', { unknownMeaningKeys: [keys[1]] }),
    word('review', { studyLevel: 'review' }), { id: 'both', word: 'both', meanings, studyMarks: ['unknown', 'review'], unknownMeaningKeys: [] },
  ];
  const library = { warnings: [], books: [{ id: 'book', title: 'Test book', units: [{ key: 'book:1', bookId: 'book', bookTitle: 'Test book', unitId: '1', unitTitle: '1과', words }] }] };
  const ui = await setup(t, { library });
  const choose = (value) => ui.click('slider', { slider: 'scope', value });
  const deck = () => ui.flash.chunks.flat().map((card) => card.word);
  assert.doesNotMatch(ui.html, /<select id="flash-filter"/);
  assert.match(ui.html, /<span class="slider-field-label">카드 범위<\/span>/);
  assert.deepEqual(rangeNotes(ui), ['6', '5', '3', '1']);

  choose('priority');
  assert.equal(ui.saved('settings').flashScope, 'priority');
  ui.click('start');
  assert.deepEqual(deck(), ['priority']);
  assert.equal(ui.saved('learning').flashcards[0].title, '플래시카드 (우선 학습) · 1과');

  ui.click('home');
  choose('unknown');
  ui.click('start');
  assert.deepEqual(deck(), ['priority', 'unknown', 'both'], 'A card once marked both 모름 and 복습 필요 counts as 모름');
  assert.equal(ui.saved('learning').flashcards[0].title, '플래시카드 (모름 이상) · 1과');

  ui.click('home');
  choose('review');
  ui.click('start');
  assert.deepEqual(deck(), ['priority', 'unknown', 'sense', 'review', 'both'], 'A single unknown sense puts the card at 복습 필요');
});

test('The start button stays disabled when no selected card is in range, and an old exact filter becomes that level and above', async (t) => {
  const ui = await setup(t, { wordCount: 2, stored: { settings: { shuffle: false, flashFilter: 'review' } } });
  assert.equal(ui.button('slider', { slider: 'scope', value: 'review' }).attributes['aria-checked'], 'true');
  assert.match(ui.button('start').html, /disabled/);
  assert.match(ui.html, /선택한 과에 ‘복습 필요 이상’에 해당하는 카드가 없습니다/);
  ui.click('start');
  assert.deepEqual(ui.saved('learning').flashcards, []);
  ui.click('slider', { slider: 'scope', value: 'all' });
  ui.click('start');
  assert.equal(ui.flash.total, 2);
});

test('The O/X quiz draws its questions from its own range slider', async (t) => {
  const word = (id, state) => ({ id, word: id, meanings: meanings.map((meaning) => ({ ...meaning, wrongEn: `not ${meaning.en}` })), studyLevel: 'off', unknownMeaningKeys: [], ...state });
  const words = [word('plain'), word('review', { studyLevel: 'review' }), word('unknown', { studyLevel: 'unknown' }), word('priority', { studyLevel: 'priority' })];
  const library = { warnings: [], books: [{ id: 'book', title: 'Test book', units: [{ key: 'book:1', bookId: 'book', bookTitle: 'Test book', unitId: '1', unitTitle: '1과', words }] }] };
  const ui = await setup(t, { library, stored: { settings: { shuffle: false, mode: 'quiz', questionCount: 20 } } });
  assert.match(ui.html, /<span class="slider-field-label">출제 범위<\/span>/);
  assert.deepEqual(rangeNotes(ui), ['4', '3', '2', '1']);
  assert.match(ui.button('all-questions').html, /data-action="all-questions"/);
  assert.match(ui.html, /선택한 단어 모두 출제/);
  ui.click('slider', { slider: 'scope', value: 'unknown' });
  assert.equal(ui.saved('settings').quizScope, 'unknown');
  assert.equal(ui.saved('settings').flashScope, 'all', 'The flashcard range stays separate');
  assert.match(ui.html, /4개 단어 중 모름 이상 2개/);
  assert.match(ui.html, /범위의 단어 모두 출제/);
  ui.click('all-questions');
  assert.equal(ui.saved('settings').questionCount, 2);
  ui.click('start');
  const [exam] = ui.saved('learning').exams;
  assert.deepEqual(exam.session.questions.map((question) => question.word.word).sort(), ['priority', 'unknown']);
  assert.equal(exam.title, '영영풀이 O/X (모름 이상) · 1과');
  ui.click('home');
  ui.click('slider', { slider: 'scope', value: 'priority' });
  ui.click('mode', { mode: 'flash' });
  assert.equal(ui.button('slider', { slider: 'scope', value: 'all' }).attributes['aria-checked'], 'true', 'Each mode shows its own range');
});

test('AI O/X picks a minimum level on a slider, can keep only unknown meanings, and sends range, count, focus and difficulty', async (t) => {
  const word = (id, state) => ({ id, word: id, meanings, studyLevel: 'off', unknownMeaningKeys: [], ...state });
  const words = [word('plain'), word('unknown', { studyLevel: 'unknown' }), word('sense', { studyLevel: 'unknown', unknownMeaningKeys: [keys[1]], studyNote: 'bench와 의미 혼동' }),
    word('review', { studyLevel: 'review' }), word('solo', { studyLevel: 'review', meanings: [meanings[0]] }), word('soloUnknown', { studyLevel: 'unknown', meanings: [meanings[0]] })];
  const library = { warnings: [], books: [{ id: 'book', title: 'Test book', units: [{ key: 'book:1', bookId: 'book', bookTitle: 'Test book', unitId: '1', unitTitle: '1과', words }] }] };
  const ui = await setup(t, { library });
  const notes = () => rangeNotes(ui);
  ui.click('mode', { mode: 'ai-ox' });
  assert.equal(ui.saved('settings').mode, 'ai-ox');
  assert.match(ui.html, /AI O\/X 시험 만들기/);
  assert.equal(ui.button('slider', { slider: 'scope', value: 'all' }).attributes['aria-checked'], 'true');
  assert.deepEqual(notes(), ['6', '5', '3', '0'], 'Each stop counts its level and every stronger one');
  assert.doesNotMatch(ui.html, /<select id="ai-ox-scope"|<select id="ai-ox-difficulty"/);
  assert.match(ui.html, /최대 6/, 'One question per word, unlike the five-option test');
  ui.click('slider', { slider: 'scope', value: 'unknown' });
  assert.equal(ui.saved('settings').aiOxScope, 'unknown');
  assert.match(ui.html, /최대 3/);
  assert.match(ui.html, /6개 단어 중 모름 이상 3개/);
  ui.change({ id: 'ai-ox-unknown-only', checked: true });
  assert.equal(ui.saved('settings').aiOxUnknownOnly, true);
  assert.deepEqual(notes(), ['4', '4', '3', '0'], 'Unmarked words and a single meaning at 복습 필요 have nothing to focus on');
  ui.click('slider', { slider: 'scope', value: 'review' });
  assert.match(ui.html, /6개 단어 중 복습 필요 이상 · 모르는 의미만 4개/);
  assert.doesNotMatch(ui.html, /노트에 적은 혼동/);
  ui.change({ id: 'ai-ox-weak', checked: true });
  assert.match(ui.html, /모르는 뜻과 노트에 적은 혼동을 먼저 확인하는 문제를 내요/);
  ui.change({ id: 'ai-ox-count', value: '9' });
  assert.equal(ui.saved('settings').aiOxCount, 4, 'The count is clamped to the words in the chosen range');
  assert.equal(ui.button('slider', { slider: 'ai-difficulty', value: 'medium' }).attributes['aria-checked'], 'true');
  ui.click('slider', { slider: 'ai-difficulty', value: 'hard' });
  assert.equal(ui.saved('settings').aiOxDifficulty, 'hard');
  ui.click('start');
  await settle();
  assert.deepEqual(ui.state.jobs[0].body, { unitKeys: ['book:1'], options: { format: 'ox', level: 'review', unknownOnly: true, count: 4, mode: 'weak', difficulty: 'hard' } });
  ui.click('home');
  ui.click('mode', { mode: 'flash' });
  ui.click('slider', { slider: 'scope', value: 'unknown' });
  assert.equal(ui.saved('settings').flashScope, 'unknown');
  assert.equal(ui.saved('settings').aiOxScope, 'review', 'The flashcard range stays separate');
  assert.equal(ui.saved('settings').aiScope, 'all', 'So does the five-option range');
});

test('The AI O/X start button stays disabled when the chosen range is empty, and an old 모름·복습 필요 range becomes 복습 필요 이상', async (t) => {
  const ui = await setup(t, { wordCount: 3, stored: { settings: { mode: 'ai-ox', aiOxScope: 'marked' } } });
  assert.equal(ui.button('slider', { slider: 'scope', value: 'review' }).attributes['aria-checked'], 'true');
  assert.match(ui.button('start').html, /disabled/);
  assert.match(ui.html, /선택한 과에 ‘복습 필요 이상’에 해당하는 단어가 없습니다/);
  ui.click('start');
  await settle();
  assert.equal(ui.state.jobs.length, 0);
});

test('Several flashcard decks keep their own progress, can be deleted one by one and leave the list when finished', async (t) => {
  const ui = await setup(t, { wordCount: 3 });
  const decks = () => ui.saved('learning').flashcards;
  ui.click('start');
  ui.click('reveal');
  ui.click('known');
  const first = decks()[0];
  assert.equal(first.session.mastered, 1);
  ui.click('home');
  ui.click('start');
  assert.equal(decks().length, 2, 'A new deck no longer replaces the unfinished one');
  const second = decks().find((deck) => deck.id !== first.id);
  assert.equal(second.session.mastered, 0);
  assert.equal(first.title, '플래시카드 · 1과');
  ui.click('home');
  ui.click('feed');
  assert.ok(ui.button('open-flash', { id: first.id }) && ui.button('open-flash', { id: second.id }));
  assert.match(ui.html, /1\/3개 암기 · 구간 1\/1/);

  ui.click('open-flash', { id: first.id });
  ui.click('reveal');
  ui.click('known');
  assert.equal(decks().find((deck) => deck.id === first.id).session.mastered, 2);
  assert.equal(decks().find((deck) => deck.id === second.id).session.mastered, 0, 'The other deck is untouched');

  ui.click('home');
  ui.click('confirm-delete-exam', { id: second.id });
  assert.equal(ui.button('confirm-delete-exam', { id: first.id }).attributes['data-kind'], 'flash');
  assert.match(ui.html, /플래시카드를 삭제할까요\?/);
  ui.click('delete-exam');
  assert.deepEqual(decks().map((deck) => deck.id), [first.id]);

  ui.click('open-flash', { id: first.id });
  ui.click('reveal');
  ui.click('known');
  await settle();
  assert.match(ui.html, /플래시카드 완료/);
  assert.deepEqual(decks(), [], 'A finished deck leaves the list');
  assert.equal(ui.calls.filter((call) => call.path === '/api/flash-records').length, 1, 'Its result is still recorded');
  ui.click('home');
  assert.equal(ui.button('open-flash', { id: first.id }), undefined);
});

test('Reviewing missed O/X words starts its own deck beside an unfinished one', async (t) => {
  const ui = await setup(t, { wordCount: 2 });
  ui.click('start');
  ui.click('home');
  ui.click('mode', { mode: 'quiz' });
  ui.click('start');
  for (let i = 0; i < 2; i++) { ui.click('answer-x'); ui.click('next-question'); }
  ui.click('review-missed');
  const decks = ui.saved('learning').flashcards;
  assert.equal(decks.length, 2);
  assert.equal(decks[0].title, '틀린 단어 복습 · 1과');
  assert.equal(decks[0].session.total, 2);
  assert.match(ui.html, /flash-card/, 'The review deck opens right away');
});

test('The five-option AI exam picks its own range and difficulty on sliders and turns weak-word focus on with a toggle', async (t) => {
  const word = (id, state) => ({ id, word: id, meanings, studyLevel: 'off', unknownMeaningKeys: [], ...state });
  const words = [...Array.from({ length: 5 }, (_, i) => word(`plain-${i}`)), ...Array.from({ length: 6 }, (_, i) => word(`unknown-${i}`, { studyLevel: 'unknown' })),
    word('review', { studyLevel: 'review' }), word('priority', { studyLevel: 'priority' })];
  const library = { warnings: [], books: [{ id: 'book', title: 'Test book', units: [{ key: 'book:1', bookId: 'book', bookTitle: 'Test book', unitId: '1', unitTitle: '1과', words }] }] };
  const ui = await setup(t, { library, stored: { settings: { mode: 'ai', aiMode: 'weak' } } });
  const notes = () => rangeNotes(ui);
  assert.deepEqual(notes(), ['13', '8', '7', '1']);
  assert.match(ui.html, /최대 2/);
  assert.match(ui.html, /<input id="ai-weak" type="checkbox" checked>/, 'A saved weak mode shows as an enabled toggle');
  assert.match(ui.html, /<input id="ai-unknown-only" type="checkbox" >/);
  assert.doesNotMatch(ui.html, /id="ai-mode"/);
  assert.match(ui.html, /헷갈리는 단어를 먼저 출제해요/);
  ui.click('slider', { slider: 'scope', value: 'unknown' });
  assert.match(ui.html, /최대 1/);
  assert.match(ui.html, /13개 단어 중 모름 이상 7개/);
  ui.change({ id: 'ai-count', value: '5' });
  assert.equal(ui.saved('settings').aiCount, 1);
  ui.change({ id: 'ai-weak', checked: false });
  assert.equal(ui.saved('settings').aiMode, 'normal');
  assert.doesNotMatch(ui.html, /헷갈리는 단어를 먼저 출제해요/);
  ui.click('slider', { slider: 'ai-difficulty', value: 'easy' });
  ui.click('start');
  await settle();
  assert.deepEqual(ui.state.jobs[0].body.options, { level: 'unknown', unknownOnly: false, count: 1, mode: 'normal', difficulty: 'easy' });
  ui.click('home');
  ui.click('slider', { slider: 'scope', value: 'priority' });
  assert.match(ui.html, /5지선다 AI 시험에는 출제 범위에 단어가 5개 이상 필요합니다/);
  assert.match(ui.button('start').html, /disabled/);
  assert.equal(ui.saved('settings').aiOxScope, 'all', 'The O/X range stays separate');
  assert.equal(ui.saved('settings').aiOxDifficulty, 'medium', 'So does the O/X difficulty');
});

test('The feed pill shows saved activities as cards filtered by kind, and the setup panel returns on demand', async (t) => {
  const exam = { examId: '2026-09-27-002', type: 'ai-test', format: 'ox', status: 'complete', createdAt: '2026-09-27T02:00:00.000Z', questionCount: 4, correctCount: 3,
    options: { format: 'ox', scope: 'unknown', count: 4, mode: 'weak', difficulty: 'hard' }, selectedScope: [{ bookId: 'book', bookTitle: 'Test book', unitIds: ['1'], units: [{ unitId: '1', unitTitle: '1과' }] }] };
  const ui = await setup(t, { wordCount: 2 });
  ui.state.aiExams = [exam];
  await ui.reload();
  ui.click('start');
  ui.click('home');
  assert.match(ui.html, /<h1>학습 만들기<\/h1>/);
  assert.doesNotMatch(ui.html, /feed-card/, 'Cards appear only after the pill is pressed');
  ui.click('feed');
  assert.match(ui.html, /<h1>만든 학습물<\/h1>/);
  assert.equal(ui.button('start'), undefined, 'The feed replaces the setup panel');
  assert.equal((ui.html.match(/class="feed-card"/g) || []).length, 2);
  assert.match(ui.html, /data-tone="sky" data-enter="feed:2026-09-27-002"/, 'AI O/X cards carry their own color');
  assert.match(ui.html, /<span class="feed-tags"><span>모름<\/span><span>헷갈리는 단어 위주<\/span><span>어려움<\/span><\/span>/);
  assert.match(ui.html, /3\/4 정답/);
  assert.match(ui.html, /data-tone="peach" data-enter="feed:/, 'Flashcard decks use the peach tone');
  ui.click('feed-filter', { filter: 'flash' });
  assert.equal((ui.html.match(/class="feed-card"/g) || []).length, 1);
  assert.doesNotMatch(ui.html, /class="feed-card" data-tone="sky"/, 'Only the chip keeps its color; the AI card is filtered out');
  ui.click('feed-active');
  assert.equal((ui.html.match(/class="feed-card"/g) || []).length, 1, 'The unfinished deck stays under the active-only filter');
  ui.click('feed-filter', { filter: 'ai-ox' });
  assert.match(ui.html, /이 조건에 맞는 학습물이 없어요/);
  ui.click('feed-filter', { filter: 'all' });
  assert.equal((ui.html.match(/class="feed-card"/g) || []).length, 1, 'Active-only still hides the finished exam');
  ui.click('open-flash', { id: ui.saved('learning').flashcards[0].id });
  assert.match(ui.html, /flash-card/);
  ui.click('home');
  assert.match(ui.html, /<h1>만든 학습물<\/h1>/, 'Returning from a card lands back on the feed');
  ui.click('setup');
  assert.match(ui.html, /<h1>학습 만들기<\/h1>/);
  assert(ui.button('start'));
});
