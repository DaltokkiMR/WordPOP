import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIController, aiExamSummary } from '../public/js/ai-ui.js';

const stageNames = ['collect', 'select', 'generate', 'verify'];
const allStages = (provider, model) => Object.fromEntries(stageNames.map((stage) => [stage, { provider, model }]));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const claudeModels = [{ id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', isDefault: true }, { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' }];

// A small DOM surface exercises the controller's event/request boundaries without a browser dependency.
class SettingsDialog {
  events = {};
  open = false;
  innerHTML = '';
  setAttribute() {}
  addEventListener(event, handler) { this.events[event] = handler; }
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close?.(); }
}

async function setup(t, { status = {}, saved = { stages: allStages('codex', 'c1') } } = {}) {
  const originals = Object.fromEntries(['document', 'window', 'fetch', 'localStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const calls = [];
  const opened = [];
  let dialog;
  const state = {
    saved,
    status: {
      codex: { account: { type: 'chatgpt', email: 'codex@example.com' }, models: [{ id: 'c1', isDefault: true }, { id: 'c2' }] },
      copilot: { account: { type: 'copilot', login: 'learner' }, models: [{ id: 'g1', isDefault: true }, { id: 'g2' }], rateLimits: { primary: { usedPercent: 99 } } },
      claude: { account: { type: 'claude', email: 'learner@example.com' }, models: claudeModels },
      ...status,
    },
    logins: {
      copilot: { authUrl: 'https://github.com/login/device', loginId: 'device-1', userCode: 'ABCD-EFGH' },
      claude: { loginId: 'claude-1', message: '브라우저에 열린 Claude 로그인 화면에서 승인해 주세요.' },
    },
    statusOverride: null,
  };
  globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  globalThis.window = { open(url) { opened.push(url); } };
  globalThis.document = { createElement() { dialog = new SettingsDialog(); return dialog; }, body: { append() {} }, querySelector() { return null; } };
  globalThis.fetch = async (path, options = {}) => {
    calls.push({ path, ...options });
    const provider = new URL(`http://local${path}`).searchParams.get('provider');
    let body;
    if (path === '/api/settings' && options.method === 'PUT') {
      const { stages } = JSON.parse(options.body);
      state.saved = { stages: { ...state.saved.stages, ...stages } };
      body = state.saved;
    } else if (path === '/api/settings') body = state.saved;
    else if (path.startsWith('/api/ai/status')) body = await (state.statusOverride?.(provider) ?? state.status[provider]);
    else if (path.startsWith('/api/ai/login/') && options.method === 'DELETE') body = { cancelled: true };
    else if (path.startsWith('/api/ai/login')) body = await state.logins[provider];
    else throw new Error(`Unexpected request ${path}`);
    return { ok: true, json: async () => structuredClone(body) };
  };
  t.after(async () => {
    if (dialog?.open) dialog.close();
    await settle();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const controller = createAIController({ onChange() {}, onOpen() {}, announce() {} });
  controller.handleAction('ai-settings', {});
  await settle();
  const selectFor = (attribute, stage) => dialog.innerHTML.match(new RegExp(`<select ${attribute}="${stage}"[^>]*>(.*?)</select>`))?.[1] ?? '';
  return {
    state, calls, opened,
    get html() { return dialog.innerHTML; },
    async action(action, provider) { dialog.events.click({ target: { closest: () => ({ dataset: { aiSettingAction: action, provider }, disabled: false }) } }); await settle(); },
    stageProvider(stage, value) { dialog.events.change({ target: { dataset: { stageProvider: stage }, value } }); },
    model(stage, value) { dialog.events.change({ target: { dataset: { modelStage: stage }, value } }); },
    selectedModel(stage) { return selectFor('data-model-stage', stage).match(/<option value="([^"]*)" selected>/)?.[1]; },
    selectedProvider(stage) { return selectFor('data-stage-provider', stage).match(/<option value="([^"]*)" selected>/)?.[1]; },
    modelOptions(stage) { return selectFor('data-model-stage', stage); },
    providerOptions(stage) { return selectFor('data-stage-provider', stage); },
    lastSaved() { const put = calls.findLast((call) => call.method === 'PUT'); return put && JSON.parse(put.body); },
    deletes(provider) { return calls.filter((call) => call.method === 'DELETE' && call.path.endsWith(`?provider=${provider}`)).length; },
  };
}

test('All three connections load at once and each stage can switch providers, restoring its earlier model', async (t) => {
  const ui = await setup(t, { saved: { stages: { ...allStages('codex', 'c1'), verify: { provider: 'copilot', model: 'g2' } } } });
  assert.deepEqual(ui.calls.filter((call) => call.path.startsWith('/api/ai/status')).map((call) => call.path).sort(),
    ['/api/ai/status?provider=claude', '/api/ai/status?provider=codex', '/api/ai/status?provider=copilot']);
  for (const name of ['ChatGPT', 'GitHub Copilot', 'Claude']) assert.match(ui.html, new RegExp(`aria-label="${name} 연결"`));
  assert.match(ui.html, /codex@example\.com/);
  assert.match(ui.html, /learner@example\.com/);
  assert.doesNotMatch(ui.html, /1% 남음/, 'Copilot quota must not be interpreted as a Codex window');
  assert.equal(ui.selectedProvider('verify'), 'copilot');
  assert.equal(ui.selectedModel('verify'), 'g2');
  ui.stageProvider('generate', 'claude');
  assert.equal(ui.selectedModel('generate'), 'claude-sonnet-5', 'A newly chosen provider starts on its default model');
  assert.match(ui.modelOptions('generate'), /Claude Sonnet 5 · 기본/);
  ui.model('generate', 'claude-opus-5-5');
  ui.stageProvider('generate', 'codex');
  assert.equal(ui.selectedModel('generate'), 'c1');
  ui.stageProvider('generate', 'claude');
  assert.equal(ui.selectedModel('generate'), 'claude-opus-5-5', 'Switching back restores the model chosen for that provider');
  await ui.action('save');
  assert.deepEqual(ui.lastSaved(), { stages: { collect: { provider: 'codex', model: 'c1' }, select: { provider: 'codex', model: 'c1' },
    generate: { provider: 'claude', model: 'claude-opus-5-5' }, verify: { provider: 'copilot', model: 'g2' } } });
  assert.match(ui.html, /다음에 만드는 시험부터 적용합니다/);
});

test('A stage cannot be saved on a provider that is not connected', async (t) => {
  const ui = await setup(t, { status: { copilot: { account: null, models: [] } } });
  assert.match(ui.providerOptions('select'), /GitHub Copilot \(연결 안 됨\)/);
  ui.stageProvider('select', 'copilot');
  assert.match(ui.modelOptions('select'), /로그인 후 모델 선택/);
  await ui.action('save');
  assert.equal(ui.lastSaved(), undefined);
  assert.match(ui.html, /단어 선별: GitHub Copilot에 먼저 로그인하거나 다른 AI 연결을 선택해 주세요/);
  ui.stageProvider('select', 'claude');
  await ui.action('save');
  assert.deepEqual(ui.lastSaved().stages.select, { provider: 'claude', model: 'claude-sonnet-5' });
});

test('Two providers can log in at the same time and each login is cancelled on its own', async (t) => {
  const ui = await setup(t, { status: { copilot: { account: null, models: [] }, claude: { account: null, models: [] } } });
  await ui.action('login', 'copilot');
  await ui.action('login', 'claude');
  assert.match(ui.html, /ABCD-EFGH/);
  assert.match(ui.html, /Claude 로그인 화면에서 승인/);
  assert.deepEqual(ui.opened, ['https://github.com/login/device'], 'the Claude CLI opens the browser itself');
  await ui.action('cancel-login', 'copilot');
  assert.equal(ui.deletes('copilot'), 1);
  assert.equal(ui.deletes('claude'), 0);
  assert.doesNotMatch(ui.html, /ABCD-EFGH/);
  assert.match(ui.html, /Claude 로그인 화면에서 승인/);
  await ui.action('close');
  assert.equal(ui.deletes('claude'), 1);
  assert.equal(ui.deletes('copilot'), 1);
});

test('A login response arriving after closing settings is cancelled without opening a window', async (t) => {
  const ui = await setup(t, { status: { copilot: { account: null, models: [] } } });
  const pending = deferred();
  ui.state.logins.copilot = pending.promise;
  await ui.action('login', 'copilot');
  await ui.action('close');
  pending.resolve({ authUrl: 'https://github.com/login/device', loginId: 'late-login', userCode: 'ABCD-EFGH' });
  await settle();
  assert.equal(ui.opened.length, 0);
  assert(ui.calls.some((call) => call.path === '/api/ai/login/late-login?provider=copilot' && call.method === 'DELETE'));
});

test('A stale login poll cannot overwrite a newer manual connection refresh', async (t) => {
  const ui = await setup(t, { status: { copilot: { account: null, models: [] } } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await ui.action('login', 'copilot');
  const pending = deferred();
  ui.state.statusOverride = (provider) => provider === 'copilot' ? pending.promise : undefined;
  t.mock.timers.tick(3000);
  await settle();
  ui.state.statusOverride = null;
  ui.state.status.copilot = { account: null, models: [], message: '현재 연결 확인 결과' };
  await ui.action('refresh', 'copilot');
  pending.resolve({ account: null, models: [], message: '오래된 연결 확인 결과' });
  await settle();
  assert.match(ui.html, /현재 연결 확인 결과/);
  assert.doesNotMatch(ui.html, /오래된 연결 확인 결과/);
});

test('Failed device authentication and missing connected models stay actionable', async (t) => {
  const ui = await setup(t, { status: { copilot: { account: null, models: [] } } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await ui.action('login', 'copilot');
  ui.state.status.copilot = { account: null, models: [], loginStatus: { state: 'failed', message: 'GitHub 인증 코드가 만료되었습니다.' } };
  t.mock.timers.tick(3000);
  await settle();
  assert.match(ui.html, /GitHub 인증 코드가 만료되었습니다/);
  assert.doesNotMatch(ui.html, /ABCD-EFGH/);
  ui.state.status.copilot = { account: { type: 'copilot' }, models: [], message: 'Copilot 구독과 조직의 모델 사용 설정을 확인해 주세요.' };
  await ui.action('refresh', 'copilot');
  assert.match(ui.html, /조직의 모델 사용 설정/);
  ui.stageProvider('collect', 'copilot');
  await ui.action('save');
  assert.match(ui.html, /자료 수집: GitHub Copilot의 모델 목록을 다시 확인해 주세요/);
  assert.equal(ui.lastSaved(), undefined);
});

test('A completed login makes that provider selectable for stages without disturbing the other connections', async (t) => {
  const ui = await setup(t, { status: { claude: { account: null, models: [] } } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.match(ui.html, /Claude로 로그인/);
  await ui.action('login', 'claude');
  ui.state.status.claude = { account: { type: 'claude', email: 'learner@example.com' }, models: claudeModels };
  t.mock.timers.tick(3000);
  await settle();
  assert.match(ui.html, /Claude에 연결되었습니다/);
  assert.match(ui.html, /learner@example\.com/);
  assert.doesNotMatch(ui.html, /Claude로 로그인/);
  assert.doesNotMatch(ui.providerOptions('verify'), /연결 안 됨/);
  ui.stageProvider('verify', 'claude');
  ui.model('verify', 'claude-opus-5-5');
  await ui.action('save');
  assert.deepEqual(ui.lastSaved().stages.verify, { provider: 'claude', model: 'claude-opus-5-5' });
  assert.deepEqual(ui.lastSaved().stages.collect, { provider: 'codex', model: 'c1' });
  assert.equal(ui.calls.filter((call) => call.path === '/api/ai/status?provider=codex').length, 1, 'Polling Claude does not recheck other providers');
});

test('An AI O/X exam is answered with O and X, advances with Enter and shows the tested confusion after submission', async (t) => {
  const originals = Object.fromEntries(['document', 'window', 'fetch', 'localStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const scope = [{ bookId: 'book', bookTitle: '교재', unitIds: ['1'], units: [{ unitId: '1', unitTitle: '1과' }] }];
  const word = (spelling) => ({ key: spelling, word: spelling, sourceRefs: [] });
  const open = { examId: '2026-09-28-001', type: 'ai-test', format: 'ox', status: 'studying', createdAt: '2026-09-28T00:00:00.000Z', selectedScope: scope,
    options: { format: 'ox', scope: 'unknown', count: 2, mode: 'weak', difficulty: 'medium' }, providers: { collect: 'claude' }, answers: [null, null], position: 0,
    questions: [{ id: 'q1', word: word('adopt'), definition: 'to take up and use an idea' }, { id: 'q2', word: word('adapt'), definition: 'to choose a child legally' }] };
  const meanings = [{ ko: '채택하다', en: 'to take up an idea' }];
  const complete = { ...open, status: 'complete', summaryStatus: 'complete', summary: { strengths: [], weaknesses: ['혼동'], recommendations: [] }, answers: [true, true],
    results: [{ answer: true, expected: true, correct: true }, { answer: true, expected: false, correct: false }],
    questions: [{ ...open.questions[0], word: { ...word('adopt'), meanings }, meaningIndex: 0, isCorrect: true, difficulty: 'easy', explanation: '맞는 뜻' },
      { ...open.questions[1], word: { ...word('adapt'), meanings: [{ ko: '적응시키다', en: 'to change to suit' }] }, meaningIndex: 0, isCorrect: false, difficulty: 'hard', confusionTarget: 'adopt(입양하다)와 adapt(적응시키다)의 혼동', explanation: '입양은 adopt의 뜻' }] };
  const requests = [];
  globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  globalThis.window = {};
  globalThis.document = { querySelector() { return null; } };
  globalThis.fetch = async (path, options = {}) => {
    requests.push({ path, ...options });
    const body = path === '/api/ai/exams' ? [] : path.endsWith('/submit') ? complete : path.endsWith('/progress') ? open : open;
    return { ok: true, json: async () => structuredClone(body) };
  };
  let html = '';
  const controller = createAIController({ onChange() { html = controller.renderMain(); }, onOpen() {}, announce() {} });
  controller.handleAction('ai-open', { dataset: { id: open.examId } });
  await settle();
  html = controller.renderMain();
  assert.equal(controller.title, 'AI 영영풀이 O/X');
  assert.match(html, /영영풀이가 이 단어의 뜻이면 <em>O<\/em>, 아니면 <em>X<\/em>를 고르세요/);
  assert.match(html, /모름 · 헷갈리는 단어 위주/);
  const key = (code, extra = {}) => { let prevented = false; controller.keydown({ code, key: extra.key ?? '', target: { closest: () => null }, preventDefault() { prevented = true; } }); return prevented; };
  assert.equal(key('Enter', { key: 'Enter' }), false, 'Enter waits for an answer');
  assert.ok(key('KeyO'));
  assert.equal(controller.activeExam.answers[0], true);
  assert.match(html, /data-answer="o" aria-pressed="true"/);
  assert.ok(key('Enter', { key: 'Enter' }));
  assert.equal(controller.activeExam.position, 1);
  assert.ok(key('KeyX'));
  assert.ok(key('KeyO'), 'The answer can change before submission');
  assert.equal(controller.activeExam.answers[1], true);
  controller.keydown({ key: 'ArrowLeft', code: 'ArrowLeft', target: { closest: () => null }, preventDefault() {} });
  assert.equal(controller.activeExam.position, 0);
  controller.handleAction('ai-answer', { dataset: { answer: 'x' } });
  assert.equal(controller.activeExam.answers[0], false);
  controller.handleAction('ai-answer', { dataset: { answer: 'o' } });
  await settle();
  assert.ok(requests.filter((request) => request.path.endsWith('/progress')).every((request) => JSON.parse(request.body).answers.every((answer) => answer === null || typeof answer === 'boolean')));
  controller.handleAction('ai-submit', {});
  await settle();
  assert.deepEqual(JSON.parse(requests.find((request) => request.path.endsWith('/submit')).body), { answers: [true, true] });
  html = controller.renderMain();
  assert.match(html, /AI O\/X 시험 결과/);
  assert.match(html, /내 답 O · 정답 X/);
  assert.doesNotMatch(html, /내 답 O · 정답 O/, 'A correct row does not repeat the answer pair');
  assert.match(html, /확인한 혼동<\/strong>adopt\(입양하다\)와 adapt\(적응시키다\)의 혼동/);
  assert.match(html, /적응시키다/);
  const summary = aiExamSummary({ ...complete, questionCount: 2, correctCount: 1 });
  assert.deepEqual({ kind: summary.kind, fullTitle: summary.fullTitle, title: summary.title, tags: summary.tags, complete: summary.complete, statusText: summary.statusText, progress: summary.progress },
    { kind: 'ai-ox', fullTitle: 'AI 영영풀이 O/X · 1과', title: '1과', tags: ['모름', '헷갈리는 단어 위주', '보통'], complete: true, statusText: '1/2 정답', progress: [2, 2] });
  assert.deepEqual(aiExamSummary({ ...complete, options: { format: 'ox', level: 'unknown', unknownOnly: true, mode: 'weak', difficulty: 'hard' } }).tags,
    ['모름 이상', '모르는 의미만', '헷갈리는 단어 위주', '어려움'], 'New exams show their minimum level and 모르는 의미만');
});

test('Opened result explanations stay open while the summary is polled, and unchanged polls do not re-render', async (t) => {
  const originals = Object.fromEntries(['document', 'window', 'fetch', 'localStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const word = (spelling) => ({ key: spelling, word: spelling, sourceRefs: [], meanings: [{ ko: '뜻', en: 'a meaning' }] });
  const pending = { examId: '2026-09-28-002', type: 'ai-test', status: 'complete', summaryStatus: 'pending', summary: null, createdAt: '2026-09-28T00:00:00.000Z', selectedScope: [], providers: { collect: 'codex' },
    options: { count: 2, mode: 'normal', difficulty: 'easy' }, answers: [0, 1], results: [{ answer: 0, answerIndex: 0, correct: true }, { answer: 1, answerIndex: 0, correct: false }],
    questions: [0, 1].map((i) => ({ id: `q${i + 1}`, kind: 'correct', difficulty: 'easy', answerIndex: 0, explanation: `해설 ${i + 1}`, options: [word(`w${i}`)].map((w) => ({ word: w, meaningIndex: 0, definition: 'a meaning', isCorrect: true, explanation: '보기 해설' })) })) };
  let served = pending;
  globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  globalThis.window = {};
  globalThis.document = { querySelector() { return null; } };
  globalThis.fetch = async (path) => ({ ok: true, json: async () => structuredClone(path === '/api/ai/exams' ? [] : served) });
  let renders = 0;
  const controller = createAIController({ onChange() { renders++; }, onOpen() {}, announce() {} });
  const poll = async () => { t.mock.timers.tick(3000); await settle(); };
  const details = (html) => [...html.matchAll(/<details [^>]*>/g)].map(([tag]) => tag);
  controller.handleAction('ai-open', { dataset: { id: pending.examId } });
  await settle();
  assert.deepEqual(details(controller.renderMain()).map((tag) => tag.includes(' open')), [false, false]);
  controller.toggleReview({ open: true, dataset: { reviewIndex: '1' } });
  controller.toggleReview({ open: true, dataset: {} });
  renders = 0;
  await poll();
  await poll();
  assert.equal(renders, 0, 'A poll with no new summary leaves the page alone');
  served = { ...pending, summaryStatus: 'complete', summary: { strengths: [], weaknesses: ['보기 판단'], recommendations: [] } };
  await poll();
  assert.equal(renders, 1);
  const html = controller.renderMain();
  assert.match(html, /보기 판단/);
  assert.deepEqual(details(html).map((tag) => tag.includes(' open')), [false, true], 'The explanation opened before the summary arrived stays open');
  controller.toggleReview({ open: false, dataset: { reviewIndex: '1' } });
  assert.ok(details(controller.renderMain()).every((tag) => !tag.includes(' open')));
  await poll();
  assert.equal(renders, 1, 'Polling stops once the summary is complete');
});
