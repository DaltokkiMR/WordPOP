import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { collectWords, createFlashSession, gradeFlash, revealFlash } from '../public/js/model.js';
import { meaningKey } from '../public/js/study-marks.js';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'wordpop-api-'));
  const libraryRoot = path.join(root, 'word_list');
  const recordsRoot = path.join(root, 'records');
  await mkdir(path.join(libraryRoot, 'book'), { recursive: true });
  const unit = { schemaVersion: 1, bookId: 'book', bookTitle: '테스트 교재', unitId: '1', unitTitle: '1과',
    words: ['apple', 'bed', 'cat', 'dog', 'egg'].map((word) => ({ id: word, word, meanings: [{ ko: `${word}의 뜻`, en: `Definition of ${word}.` }] })),
  };
  await writeFile(path.join(libraryRoot, 'book/unit-1.json'), JSON.stringify(unit));
  const calls = [];
  const summaries = [];
  const models = ['collect', 'select', 'generate', 'verify'].map((id) => ({ id, model: id, displayName: id, isDefault: id === 'generate' }));
  const codex = { status: async () => ({ account: { type: 'chatgpt' }, models, defaultModel: 'generate', rateLimits: null }), close() {},
    login: async () => ({ authUrl: 'https://auth.openai.com/example', loginId: 'login' }), cancelLogin: async () => ({}), ...overrides.codex };
  const ai = {
    async generateExam(input) {
      calls.push(input);
      input.onProgress({ stage: 'verify' });
      return { questions: [{ id: 'q1', kind: 'correct', difficulty: 'easy', intent: '기본 뜻', answerIndex: 0, explanation: '첫 번째만 옳습니다.',
        options: input.words.map((word, i) => ({ word, meaningIndex: 0, definition: i === 0 ? word.meanings[0].en : 'A mismatched definition.', isCorrect: i === 0, explanation: `${word.word} 해설` })),
      }], modelsUsed: input.models };
    },
    async summarizeExam(input) { summaries.push({ provider: input.provider, model: input.model }); return { strengths: ['기본 의미 확인'], weaknesses: ['오답 문항 복습'], recommendations: ['정답과 선택한 보기를 비교하세요.'] }; },
    ...overrides.ai,
  };
  const copilot = { status: async () => ({ account: { type: 'copilot', login: 'learner' }, models, defaultModel: 'collect' }),
    close() {}, login: async () => ({ authUrl: 'https://github.com/login/device', loginId: 'gh-login', userCode: 'ABCD-EFGH' }),
    cancelLogin: async (id) => ({ cancelled: id }), ...overrides.copilot };
  const claude = { status: async () => ({ account: { type: 'claude', email: 'learner@example.com' }, models, defaultModel: 'select' }),
    close() {}, login: async () => ({ loginId: 'claude-login', message: '브라우저에서 승인해 주세요.' }),
    cancelLogin: async (id) => ({ cancelled: id }), ...overrides.claude };
  const server = createApp({ libraryRoot, recordsRoot, codex, ai, copilot, claude });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  async function request(route, method = 'GET', body, headers = {}) {
    const response = await fetch(`${base}${route}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, text };
  }
  return { root, recordsRoot, libraryRoot, request, calls, summaries, words: collectWords([{ ...unit, key: 'book/unit-1.json' }]) };
}

const stageNames = ['collect', 'select', 'generate', 'verify'];
const allStages = (provider, model = (stage) => stage) => Object.fromEntries(stageNames.map((stage) => [stage, { provider, model: typeof model === 'function' ? model(stage) : model }]));
async function waitForExam(app, jobId) {
  for (let i = 0; i < 80; i++) {
    const { data } = await app.request(`/api/ai/jobs/${jobId}`);
    if (data.status === 'complete') return (await app.request(`/api/ai/exams/${data.examId}`)).data;
    if (data.status === 'failed') assert.fail(data.error);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Generation did not finish');
}

async function generatedExam(app) {
  const started = await app.request('/api/ai/jobs', 'POST', { unitKeys: ['book/unit-1.json'], options: { count: 1, mode: 'normal', difficulty: 'easy' } });
  assert.equal(started.status, 202, started.text);
  for (let i = 0; i < 80; i++) {
    const { data } = await app.request(`/api/ai/jobs/${started.data.id}`);
    if (data.status === 'complete') return data.examId;
    if (data.status === 'failed') assert.fail(data.error);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Generation did not finish');
}

test('AI exam HTTP lifecycle retains scope/models, withholds answers, saves paired files, reuses memory', async (t) => {
  const app = await fixture(t);
  const models = { collect: 'collect', select: 'select', generate: 'generate', verify: 'verify' };
  assert.equal((await app.request('/api/settings', 'PUT', { stages: allStages('codex') })).status, 200);
  const id = await generatedExam(app);
  const listing = await app.request('/api/ai/exams');
  assert.equal(listing.data[0].questionCount, 1);
  assert.equal(listing.data[0].questions, undefined, 'the sidebar only fetches metadata');
  let result = await app.request(`/api/ai/exams/${id}`);
  assert.equal(result.data.selectedScope[0].bookId, 'book');
  assert.deepEqual(result.data.selectedScope[0].unitIds, ['1']);
  assert.deepEqual(result.data.models, models);
  assert.equal(result.data.questions[0].answerIndex, undefined);
  assert.equal(result.data.questions[0].difficulty, undefined);
  assert.equal(result.data.questions[0].options[0].isCorrect, undefined);
  assert.equal(result.data.questions[0].options[0].word.meanings, undefined);
  assert.equal(result.data.questions[0].options[0].word.sourceRefs[0].meaningKeys, undefined);
  assert.equal((await app.request(`/api/ai/exams/${id}/export?format=json`)).data.questions[0].answerIndex, undefined);
  assert.equal((await app.request(`/api/ai/exams/${id}/progress`, 'PATCH', { answers: [2], position: 0 })).status, 200);
  assert.deepEqual((await app.request(`/api/ai/exams/${id}`)).data.answers, [2]);
  result = await app.request(`/api/ai/exams/${id}/submit`, 'POST', { answers: [2] });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.data.status, 'complete');
  assert.equal(result.data.results[0].correct, false);
  assert.equal(result.data.questions[0].answerIndex, 0);
  assert.equal(result.data.questions[0].difficulty, 'easy');
  assert.equal((await app.request(`/api/ai/exams/${id}/summary`, 'POST')).data.summaryStatus, 'complete');
  const md = await readFile(path.join(app.recordsRoot, 'ai-test', `${id}.md`), 'utf8');
  assert.match(md, /테스트 교재/);
  assert.match(md, /1과/);
  const json = JSON.parse(await readFile(path.join(app.recordsRoot, 'ai-test', `${id}.json`), 'utf8'));
  assert.deepEqual(json.models, models);
  assert.equal(json.questions[0].options[0].word.sourceRefs[0].wordId, 'apple');
  await generatedExam(app);
  assert.equal(app.calls[1].history[0].examId, id);
  assert.match(app.calls[1].history[0].markdown, /테스트 교재/);
});

test('DELETE removes an AI exam, its files and pending summary, and later requests report it missing', async (t) => {
  let releaseSummary;
  let summaryStarted;
  const started = new Promise((resolve) => { summaryStarted = resolve; });
  const app = await fixture(t, { ai: { summarizeExam: ({ signal }) => new Promise((resolve, reject) => {
    releaseSummary = () => resolve({ strengths: ['늦은 요약'], weaknesses: [], recommendations: [] });
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    summaryStarted();
  }) } });
  const kept = await generatedExam(app);
  const id = await generatedExam(app);
  assert.equal((await app.request(`/api/ai/exams/${id}/submit`, 'POST', { answers: [0] })).status, 200);
  await started;
  const deleted = await app.request(`/api/ai/exams/${id}`, 'DELETE');
  assert.equal(deleted.status, 200, deleted.text);
  assert.deepEqual(deleted.data, { examId: id, deleted: true });
  releaseSummary();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual((await readdir(path.join(app.recordsRoot, 'ai-test'))).sort(), [`${kept}.json`], 'An aborted summary must not recreate deleted files');
  assert.deepEqual((await app.request('/api/ai/exams')).data.map((exam) => exam.examId), [kept]);
  assert.equal((await app.request(`/api/ai/exams/${id}`)).status, 404);
  assert.equal((await app.request(`/api/ai/exams/${id}`, 'DELETE')).status, 404);
  assert.equal((await app.request(`/api/ai/exams/${kept}`, 'DELETE', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.request(`/api/ai/exams/${kept}`)).status, 200);
});

test('flashcard API writes marks and completed counts, and rejects cross-site writes', async (t) => {
  const app = await fixture(t);
  const mark = { sourceRefs: app.words[0].sourceRefs, mark: 'unknown' };
  assert.equal((await app.request('/api/word-mark', 'PATCH', mark, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.request('/api/word-mark', 'PATCH', mark)).status, 200);
  const raw = JSON.parse(await readFile(path.join(app.libraryRoot, 'book/unit-1.json'), 'utf8'));
  assert.equal(raw.words[0].studyMark, undefined);
  assert.equal(raw.words[0].studyLevel, 'unknown');
  assert.deepEqual(raw.words[0].unknownMeaningKeys, []);
  let session = createFlashSession(app.words, 5, false);
  session = gradeFlash(revealFlash(session), false);
  while (session.phase !== 'complete') session = gradeFlash(revealFlash(session), true);
  const saved = await app.request('/api/flash-records', 'POST', { session });
  assert.equal(saved.status, 200, saved.text);
  const file = JSON.parse(await readFile(path.join(app.recordsRoot, 'flashcard/book/unit-1.json'), 'utf8'));
  assert.match(JSON.stringify(file), /apple/);
  assert.equal((await app.request('/api/flash-records', 'POST', { session })).status, 200);
});

test('a flashcard level and a selected meaning survive HTTP save, library reload and AI generation', async (t) => {
  const app = await fixture(t);
  const filename = path.join(app.libraryRoot, 'book/unit-1.json');
  const original = JSON.parse(await readFile(filename, 'utf8'));
  original.words[0].meanings.push({ ko: '사과나무', en: 'A tree that produces apples.' });
  await writeFile(filename, JSON.stringify(original));
  const library = await app.request('/api/library');
  const [word] = collectWords(library.data.books[0].units);
  const state = { studyLevel: 'priority', unknownMeaningKeys: [meaningKey(word.meanings[1])] };
  const saved = await app.request('/api/word-mark', 'PATCH', { sourceRefs: word.sourceRefs, ...state });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.data, state);
  const saved0 = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(saved0.words[0].studyLevel, state.studyLevel);
  assert.deepEqual(saved0.words[0].unknownMeaningKeys, state.unknownMeaningKeys);
  assert.deepEqual(saved0.words[0].meanings, original.words[0].meanings);
  assert.equal(saved0.words[0].studyMark, undefined);
  const reloaded = (await app.request('/api/library')).data.books[0].units[0].words[0];
  assert.equal(reloaded.studyLevel, state.studyLevel);
  assert.deepEqual(reloaded.unknownMeaningKeys, state.unknownMeaningKeys);
  await generatedExam(app);
  const received = app.calls[0].words.find((item) => item.key === word.key);
  assert.equal(received.studyLevel, state.studyLevel);
  assert.deepEqual(received.unknownMeaningKeys, state.unknownMeaningKeys);
  assert.deepEqual(received.meanings, original.words[0].meanings);
  const noted = await app.request('/api/word-mark', 'PATCH', { sourceRefs: word.sourceRefs, ...state, studyNote: ' pineapple과 헷갈림 ' });
  assert.deepEqual(noted.data, { ...state, studyNote: 'pineapple과 헷갈림' });
  assert.equal((await app.request('/api/library')).data.books[0].units[0].words[0].studyNote, 'pineapple과 헷갈림');
  await generatedExam(app);
  assert.equal(app.calls[1].words.find((item) => item.key === word.key).studyNote, 'pineapple과 헷갈림');
  await app.request('/api/word-mark', 'PATCH', { sourceRefs: word.sourceRefs, ...state, studyNote: '' });
  const raw = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(raw.words[0].studyNote, undefined, 'A blank note removes the field');
  const invalid = await app.request('/api/word-mark', 'PATCH', { sourceRefs: word.sourceRefs, ...state, unknownMeaningKeys: ['missing'] });
  assert.equal(invalid.status, 400);
  const twoFlags = await app.request('/api/word-mark', 'PATCH', { sourceRefs: word.sourceRefs, studyMarks: ['unknown', 'review'], unknownMeaningKeys: [] });
  assert.equal(twoFlags.status, 400, 'Independent flags are no longer accepted');
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), raw);
});

test('generation validates count, scope, unavailable models, and requires ChatGPT authentication', async (t) => {
  const app = await fixture(t);
  const options = { count: 2, mode: 'normal', difficulty: 'easy' };
  assert.equal((await app.request('/api/ai/jobs', 'POST', { unitKeys: ['book/unit-1.json'], options })).status, 400);
  assert.equal((await app.request('/api/ai/jobs', 'POST', { unitKeys: ['missing'], options: { ...options, count: 1 } })).status, 400);
  assert.equal((await app.request('/api/settings', 'PUT', { stages: { collect: { provider: 'codex', model: 'missing' } } })).status, 400);
  const other = await fixture(t, { codex: { status: async () => ({ account: { type: 'apiKey' }, models: [], defaultModel: null }) } });
  assert.equal((await other.request('/api/ai/jobs', 'POST', { unitKeys: ['book/unit-1.json'], options: { ...options, count: 1 } })).status, 401);
});

test('cancel stops pending generation and summary failure keeps submitted results', async (t) => {
  const app = await fixture(t, { ai: { generateExam: async ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) } });
  const started = await app.request('/api/ai/jobs', 'POST', { unitKeys: ['book/unit-1.json'], options: { count: 1, mode: 'normal', difficulty: 'easy' } });
  assert.equal(started.status, 202);
  assert.equal((await app.request(`/api/ai/jobs/${started.data.id}`, 'DELETE')).data.status, 'cancelled');
  assert.deepEqual((await app.request('/api/ai/exams')).data, []);
  const other = await fixture(t, { ai: { summarizeExam: async () => { throw new Error('사용 한도에 도달했습니다.'); } } });
  const id = await generatedExam(other);
  assert.equal((await other.request(`/api/ai/exams/${id}/submit`, 'POST', { answers: [0] })).status, 200);
  const result = await other.request(`/api/ai/exams/${id}/summary`, 'POST');
  assert.equal(result.data.summaryStatus, 'failed');
  assert.equal(result.data.results[0].correct, true);
  assert.match(await readFile(path.join(other.recordsRoot, 'ai-test', `${id}.md`), 'utf8'), /시험/);
});

test('a summary interrupted by a server restart becomes retryable without losing grading', async (t) => {
  const app = await fixture(t);
  const id = await generatedExam(app);
  await app.request(`/api/ai/exams/${id}/submit`, 'POST', { answers: [0] });
  await app.request(`/api/ai/exams/${id}/summary`, 'POST');
  const filename = path.join(app.recordsRoot, 'ai-test', `${id}.json`);
  const interrupted = JSON.parse(await readFile(filename, 'utf8'));
  interrupted.summaryStatus = 'pending'; interrupted.summary = null;
  await writeFile(filename, JSON.stringify(interrupted));
  const recovered = await app.request(`/api/ai/exams/${id}`);
  assert.equal(recovered.data.summaryStatus, 'failed');
  assert.equal(recovered.data.score.correct, 1);
  assert.match(recovered.data.summaryError, /다시/);
  assert.equal((await app.request(`/api/ai/exams/${id}/summary`, 'POST')).data.summaryStatus, 'complete');
});

test('All three providers report status and log in independently while settings mix providers per stage', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/ai/status')).data.provider, 'codex');
  assert.equal((await app.request('/api/ai/status?provider=copilot')).data.account.type, 'copilot');
  assert.equal((await app.request('/api/ai/status?provider=claude')).data.account.type, 'claude');
  const login = await app.request('/api/ai/login?provider=copilot', 'POST');
  assert.equal(login.data.userCode, 'ABCD-EFGH');
  assert.match(login.data.authUrl, /github.com/);
  assert.equal((await app.request('/api/ai/login?provider=claude', 'POST')).data.loginId, 'claude-login');
  assert.equal((await app.request('/api/ai/login/gh-login?provider=copilot', 'DELETE')).data.cancelled, 'gh-login');
  assert.equal((await app.request('/api/ai/login/claude-login?provider=claude', 'DELETE')).data.cancelled, 'claude-login');
  const stages = { collect: { provider: 'claude', model: 'collect' }, select: { provider: 'codex', model: 'select' }, generate: { provider: 'copilot', model: 'generate' }, verify: { provider: 'claude', model: null } };
  const saved = await app.request('/api/settings', 'PUT', { stages });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.data.stages, stages);
  assert.deepEqual((await app.request('/api/settings', 'PUT', { stages: { select: { provider: 'claude', model: 'verify' } } })).data.stages, { ...stages, select: { provider: 'claude', model: 'verify' } });
  assert.equal((await app.request('/api/ai/status?provider=missing')).status, 400);
  for (const body of [{ stages: { collect: { provider: 'missing', model: null } } }, { stages: { collect: { provider: null } } }, { stages: { unknown: { provider: 'codex' } } }, { provider: 'copilot' }, { stages: { collect: { provider: 'codex', model: 3 } } }]) {
    assert.equal((await app.request('/api/settings', 'PUT', body)).status, 400, JSON.stringify(body));
  }
});
test('Mixed-provider exams send each stage to its provider and summarize with the collect provider after settings change', async (t) => {
  const app = await fixture(t);
  const stages = { collect: { provider: 'copilot', model: 'collect' }, select: { provider: 'claude', model: 'select' }, generate: { provider: 'codex', model: 'generate' }, verify: { provider: 'claude', model: 'verify' } };
  await app.request('/api/settings', 'PUT', { stages });
  const id = await generatedExam(app);
  const providers = { collect: 'copilot', select: 'claude', generate: 'codex', verify: 'claude' };
  assert.deepEqual(app.calls[0].providers, providers);
  assert.deepEqual(app.calls[0].models, { collect: 'collect', select: 'select', generate: 'generate', verify: 'verify' });
  assert.deepEqual((await app.request(`/api/ai/exams/${id}`)).data.providers, providers);
  assert.deepEqual((await app.request('/api/ai/exams')).data[0].providers, providers);
  await app.request('/api/settings', 'PUT', { stages: allStages('codex') });
  await app.request(`/api/ai/exams/${id}/submit`, 'POST', { answers: [0] });
  await app.request(`/api/ai/exams/${id}/summary`, 'POST');
  assert.deepEqual(app.summaries, [{ provider: 'copilot', model: 'collect' }]);
  const saved = JSON.parse(await readFile(path.join(app.recordsRoot, 'ai-test', `${id}.json`), 'utf8'));
  assert.deepEqual(saved.providers, providers);
  const markdown = await readFile(path.join(app.recordsRoot, 'ai-test', `${id}.md`), 'utf8');
  assert.match(markdown, /collect: collect \(GitHub Copilot\)/);
  assert.match(markdown, /select: select \(Claude \(Claude Code\)\)/);
  assert.match(markdown, /generate: generate \(ChatGPT \(Codex\)\)/);
  await generatedExam(app);
  assert.deepEqual(app.calls[1].providers, { collect: 'codex', select: 'codex', generate: 'codex', verify: 'codex' });
  assert.equal(app.calls[1].history[0].examId, id, 'study evidence is shared across providers');
});
test('A stage without a saved model uses its provider default, and legacy single-provider exams still summarize', async (t) => {
  const app = await fixture(t);
  await app.request('/api/settings', 'PUT', { stages: { ...allStages('codex'), generate: { provider: 'claude', model: null } } });
  const id = await generatedExam(app);
  assert.equal(app.calls[0].models.generate, 'select', 'the Claude default model is used when none is saved');
  assert.equal(app.calls[0].providers.generate, 'claude');
  const filename = path.join(app.recordsRoot, 'ai-test', `${id}.json`);
  const legacy = JSON.parse(await readFile(filename, 'utf8'));
  delete legacy.providers;
  legacy.provider = 'claude';
  await writeFile(filename, JSON.stringify(legacy));
  await app.request(`/api/ai/exams/${id}/submit`, 'POST', { answers: [0] });
  await app.request(`/api/ai/exams/${id}/summary`, 'POST');
  assert.deepEqual(app.summaries, [{ provider: 'claude', model: 'collect' }]);
  assert.match(await readFile(path.join(app.recordsRoot, 'ai-test', `${id}.md`), 'utf8'), /verify: verify \(Claude \(Claude Code\)\)/);
});
test('Any disconnected stage provider blocks generation without falling back to another provider', async (t) => {
  const app = await fixture(t, { claude: { status: async () => ({ account: null, models: [], defaultModel: null, message: 'Claude 구독이 아닌 방식' }) } });
  assert.equal((await app.request('/api/settings', 'PUT', { stages: { ...allStages('codex'), verify: { provider: 'claude', model: null } } })).status, 200);
  const result = await app.request('/api/ai/jobs', 'POST', { unitKeys: ['book/unit-1.json'], options: { count: 1, mode: 'normal', difficulty: 'easy' } });
  assert.equal(result.status, 401); assert.match(result.data.error, /Claude/);
  assert.equal(app.calls.length, 0);
  assert.equal((await app.request('/api/settings', 'PUT', { stages: { verify: { provider: 'claude', model: 'verify' } } })).status, 400);
});
test('stage providers and models freeze before generation, even when settings change during the request', async (t) => {
  let release;
  let originalGenerate;
  const app = await fixture(t, { ai: { generateExam: async (input) => {
    originalGenerate = input;
    await new Promise((resolve) => { release = resolve; });
    return { questions: [{ id: 'q1', kind: 'correct', difficulty: 'easy', intent: '기본 뜻', answerIndex: 0, explanation: '첫 번째가 정답',
      options: input.words.map((word, i) => ({ word, meaningIndex: 0, definition: i === 0 ? word.meanings[0].en : 'Mismatch.', isCorrect: i === 0, explanation: '단어 풀이' })) }], modelsUsed: input.models };
  } } });
  await app.request('/api/settings', 'PUT', { stages: allStages('copilot') });
  const started = await app.request('/api/ai/jobs', 'POST', { unitKeys: ['book/unit-1.json'], options: { count: 1, mode: 'normal', difficulty: 'easy' } });
  assert.equal(started.data.providers.collect, 'copilot');
  await app.request('/api/settings', 'PUT', { stages: allStages('codex', 'verify') });
  assert.equal(originalGenerate.models.collect, 'collect');
  release();
  const saved = await waitForExam(app, started.data.id);
  assert.deepEqual(saved.providers, { collect: 'copilot', select: 'copilot', generate: 'copilot', verify: 'copilot' });
  assert.equal(saved.models.collect, 'collect');
});
test('Copilot disconnection and unknown models do not silently fall back to Codex', async (t) => {
  const app = await fixture(t, { copilot: { status: async () => ({ account: null, models: [], defaultModel: null }) } });
  assert.equal((await app.request('/api/settings', 'PUT', { stages: allStages('copilot', null) })).status, 200);
  const request = { unitKeys: ['book/unit-1.json'], options: { count: 1, mode: 'normal', difficulty: 'easy' } };
  const result = await app.request('/api/ai/jobs', 'POST', request);
  assert.equal(result.status, 401);
  assert.match(result.data.error, /Copilot/);
  assert.equal(app.calls.length, 0);
  assert.equal((await app.request('/api/settings', 'PUT', { stages: { collect: { provider: 'copilot', model: 'missing' } } })).status, 400);
});
test('slow model validation cannot overwrite a later stage change', async (t) => {
  let release;
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const app = await fixture(t, { codex: { status: async () => {
    notifyStarted();
    await new Promise((resolve) => { release = resolve; });
    return { account: { type: 'chatgpt' }, models: [{ id: 'model' }], defaultModel: 'model' };
  } } });
  const first = app.request('/api/settings', 'PUT', { stages: allStages('codex', 'model') });
  await started;
  const second = app.request('/api/settings', 'PUT', { stages: { collect: { provider: 'copilot', model: null } } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  const { stages } = (await app.request('/api/settings')).data;
  assert.deepEqual(stages.collect, { provider: 'copilot', model: null });
  assert.deepEqual(stages.verify, { provider: 'codex', model: 'model' });
});

test('AI O/X jobs draw from a minimum level, optionally 모르는 의미만, allow one question per word and hide answers until submission', async (t) => {
  const seen = [];
  const app = await fixture(t, { ai: { async generateExam(input) {
    seen.push(input);
    input.onProgress({ stage: 'verify' });
    return { modelsUsed: input.models, questions: input.words.slice(0, input.options.count).map((word, i) => ({ id: `q${i + 1}`, difficulty: 'easy', intent: '뜻 확인',
      confusionTarget: '비슷한 단어와 혼동', word, meaningIndex: 0, definition: i ? 'A wrong definition.' : word.meanings[0].en, isCorrect: i === 0, explanation: '해설' })) };
  } } });
  assert.equal((await app.request('/api/settings', 'PUT', { stages: allStages('codex') })).status, 200);
  const job = (options) => app.request('/api/ai/jobs', 'POST', { unitKeys: ['book/unit-1.json'], options: { format: 'ox', mode: 'weak', difficulty: 'easy', ...options } });
  const empty = await job({ level: 'unknown', count: 1 });
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /‘모름 이상’에 해당하는 단어가 없습니다/);
  assert.match((await job({ level: 'priority', count: 1 })).data.error, /‘우선 학습’에 해당하는 단어가 없습니다/);
  assert.match((await job({ level: 'all', unknownOnly: true, count: 1 })).data.error, /‘모르는 의미만’에 해당하는 단어가 없습니다/);
  const [apple, bed, cat] = app.words;
  await app.request('/api/word-mark', 'PATCH', { sourceRefs: apple.sourceRefs, studyLevel: 'priority', unknownMeaningKeys: [] });
  await app.request('/api/word-mark', 'PATCH', { sourceRefs: bed.sourceRefs, studyLevel: 'review', unknownMeaningKeys: [] });
  await app.request('/api/word-mark', 'PATCH', { sourceRefs: cat.sourceRefs, studyLevel: 'unknown', unknownMeaningKeys: [] });
  assert.match((await job({ level: 'unknown', count: 3 })).data.error, /1~2개/, '모름 이상 includes 우선 학습');
  assert.match((await job({ level: 'review', count: 4 })).data.error, /1~3개/, '복습 필요 이상 includes every marked word');
  assert.match((await job({ level: 'review', unknownOnly: true, count: 3 })).data.error, /1~2개/, 'A single-meaning word joins 모르는 의미만 only from 모름 up');
  assert.match((await job({ level: 'all', count: 6 })).data.error, /1~5개/, 'O/X allows one question per word, beyond the five-option limit of 1');
  assert.equal((await job({ level: 'everything', count: 1 })).status, 400);
  assert.equal((await job({ level: 'all', unknownOnly: 'yes', count: 1 })).status, 400);
  assert.equal((await job({ scope: 'unknown', count: 1 })).status, 400, 'The earlier exact-level scope is refused rather than guessed');
  assert.equal((await job({ format: 'essay', level: 'all', count: 1 })).status, 400);

  const started = await job({ level: 'review', unknownOnly: true, count: 2 });
  assert.equal(started.status, 202, started.text);
  assert.equal(started.data.format, 'ox');
  const exam = await waitForExam(app, started.data.id);
  assert.deepEqual(seen[0].words.map((word) => word.key), ['apple', 'cat']);
  assert.deepEqual(seen[0].options, { format: 'ox', level: 'review', unknownOnly: true, count: 2, mode: 'weak', difficulty: 'easy' });
  assert.equal(exam.format, 'ox');
  assert.deepEqual(Object.keys(exam.questions[0]).sort(), ['definition', 'id', 'word']);
  assert.deepEqual(Object.keys(exam.questions[0].word).sort(), ['key', 'sourceRefs', 'word']);
  assert.equal(exam.questions[0].word.sourceRefs[0].meaningKeys, undefined);
  assert.equal((await app.request('/api/ai/exams')).data[0].format, 'ox');
  assert.equal((await app.request(`/api/ai/exams/${exam.examId}/progress`, 'PATCH', { answers: [1, null], position: 0 })).status, 400);
  assert.equal((await app.request(`/api/ai/exams/${exam.examId}/progress`, 'PATCH', { answers: [true, null], position: 1 })).status, 200);
  const submitted = await app.request(`/api/ai/exams/${exam.examId}/submit`, 'POST', { answers: [true, true] });
  assert.equal(submitted.status, 200, submitted.text);
  assert.deepEqual(submitted.data.score, { correct: 1, total: 2 });
  assert.deepEqual(submitted.data.questions.map((question) => question.isCorrect), [true, false]);
  assert.equal(submitted.data.questions[1].confusionTarget, '비슷한 단어와 혼동');
  const md = await app.request(`/api/ai/exams/${exam.examId}/export?format=md`);
  assert.match(md.text, /# AI 영영풀이 O\/X 시험/);
  assert.match(md.text, /- 내 답: O \/ 정답: X/);
});

test('Five-option AI jobs honor the chosen minimum level and still default to every word', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/settings', 'PUT', { stages: allStages('codex') })).status, 200);
  const job = (options) => app.request('/api/ai/jobs', 'POST', { unitKeys: ['book/unit-1.json'], options: { count: 1, mode: 'weak', difficulty: 'easy', ...options } });
  assert.match((await job({ level: 'review' })).data.error, /‘복습 필요 이상’에 해당하는 단어가 없습니다/);
  assert.equal((await job({ level: 'everything' })).status, 400);
  for (const word of app.words.slice(0, 3)) await app.request('/api/word-mark', 'PATCH', { sourceRefs: word.sourceRefs, studyLevel: 'unknown', unknownMeaningKeys: [] });
  assert.match((await job({ level: 'unknown' })).data.error, /출제 범위에 단어가 5개 이상 필요합니다. 지금은 3개입니다/);
  for (const word of app.words.slice(3)) await app.request('/api/word-mark', 'PATCH', { sourceRefs: word.sourceRefs, studyLevel: 'off', unknownMeaningKeys: [meaningKey(word.meanings[0])] });
  assert.match((await job({ level: 'review', unknownOnly: true })).data.error, /지금은 3개입니다/, 'Single-meaning words lifted to 복습 필요 by their check sit out 모르는 의미만');
  const started = await job({ level: 'review' });
  assert.equal(started.status, 202, started.text);
  const exam = await waitForExam(app, started.data.id);
  assert.equal(app.calls[0].words.length, 5, '복습 필요 이상 includes words lifted to 복습 필요 by a single sense');
  assert.deepEqual(app.calls[0].options, { level: 'review', unknownOnly: false, count: 1, mode: 'weak', difficulty: 'easy' });
  assert.equal(exam.format, 'choice');
  await app.request(`/api/ai/exams/${exam.examId}/submit`, 'POST', { answers: [0] });
  const md = (await app.request(`/api/ai/exams/${exam.examId}/export?format=md`)).text;
  assert.match(md, /- 출제 범위: 복습 필요 이상\n/);
  assert.match(md, /- 출제 모드: 헷갈리는 단어 위주/);
  const legacy = await app.request('/api/ai/jobs', 'POST', { unitKeys: ['book/unit-1.json'], options: { count: 1, mode: 'normal', difficulty: 'easy' } });
  assert.equal(legacy.status, 202, 'Requests without a range use every selected word');
  await waitForExam(app, legacy.data.id);
  assert.equal(app.calls[1].options.level, 'all');
});
