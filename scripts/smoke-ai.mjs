// Opt-in live integration check. Uses selected provider quota and an isolated copy of 10 words.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { CodexClient } from '../lib/codex-client.mjs';
import { CopilotClient } from '../lib/copilot-client.mjs';
import { ClaudeClient } from '../lib/claude-client.mjs';
import { AIService } from '../lib/ai-service.mjs';
import { collectWords, createFlashSession, gradeFlash, revealFlash } from '../public/js/model.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const provider = process.env.WORDPOP_AI_PROVIDER || 'codex';
const providers = { codex: { Client: CodexClient, account: 'chatgpt' }, copilot: { Client: CopilotClient, account: 'copilot' }, claude: { Client: ClaudeClient, account: 'claude' } };
if (!Object.hasOwn(providers, provider)) throw new Error('WORDPOP_AI_PROVIDER must be codex, copilot, or claude');
const resumeRoot = process.argv[2];
const qaRoot = resumeRoot || await mkdtemp(path.join(tmpdir(), 'wordpop-live-'));
const libraryRoot = path.join(qaRoot, 'word_list');
const recordsRoot = path.join(qaRoot, 'records');
await mkdir(path.join(libraryRoot, 'wordmaster'), { recursive: true });
const units = [];
for (const unitId of ['25', '26']) {
  const filename = `unit-${unitId}.json`;
  const unit = JSON.parse(await readFile(path.join(projectRoot, 'word_list/wordmaster', filename), 'utf8'));
  unit.words = unit.words.slice(0, 5);
  if (!resumeRoot) await writeFile(path.join(libraryRoot, 'wordmaster', filename), JSON.stringify(unit));
  units.push({ ...unit, key: `wordmaster/${filename}` });
}
const client = new providers[provider].Client();
const engine = new AIService({ clients: { [provider]: client } });
const historyCounts = [];
const ai = {
  generateExam(input) { historyCounts.push(input.history.length); return engine.generateExam(input); },
  summarizeExam(input) { return engine.summarizeExam(input); },
};
const server = createApp({ libraryRoot, recordsRoot, [provider]: client, ai });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function api(route, method = 'GET', body) {
  const response = await fetch(`${base}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(`${route}: ${data.error}`);
  return data;
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 1000));
async function makeExam(count, mode, difficulty) {
  const job = await api('/api/ai/jobs', 'POST', { unitKeys: units.map((unit) => unit.key), options: { count, mode, difficulty } });
  let previousStage = '';
  for (let i = 0; i < 1200; i++) {
    const state = await api(`/api/ai/jobs/${job.id}`);
    if (state.stage !== previousStage) { console.log(`${mode}: ${state.stage}`); previousStage = state.stage; }
    if (state.status === 'complete') return state.examId;
    if (state.status === 'failed' || state.status === 'cancelled') throw new Error(state.error);
    await pause();
  }
  throw new Error('Live generation timed out');
}

try {
  console.log(`Isolated artifacts: ${qaRoot}`);
  const status = await api(`/api/ai/status?provider=${provider}`);
  assert.equal(status.account?.type, providers[provider].account, 'Sign in using AI settings before a live test.');
  const model = process.env.WORDPOP_AI_MODEL || status.defaultModel;
  assert.ok(model, 'Choose WORDPOP_AI_MODEL from the available model list.');
  const models = Object.fromEntries(['collect', 'select', 'generate', 'verify'].map((stage) => [stage, model]));
  await api('/api/settings', 'PUT', { stages: Object.fromEntries(Object.keys(models).map((stage) => [stage, { provider, model }])) });
  console.log(`AI provider: ${provider}; actual model: ${model}`);
  const words = collectWords(units);
  await api('/api/word-mark', 'PATCH', { sourceRefs: words[0].sourceRefs, mark: 'unknown' });
  let flash = createFlashSession(words, 10, false);
  flash = gradeFlash(revealFlash(flash), false);
  while (flash.phase !== 'complete') flash = gradeFlash(revealFlash(flash), true);
  await api('/api/flash-records', 'POST', { session: flash });
  const previous = resumeRoot ? (await api('/api/ai/exams')).find((exam) => exam.status === 'complete' && Object.values(exam.providers).every((used) => used === provider)) : null;
  const id = previous?.examId || await makeExam(2, 'normal', 'medium');
  const shown = await api(`/api/ai/exams/${id}`);
  if (!previous) {
    assert.equal(shown.questions[0].answerIndex, undefined);
    assert.equal(shown.questions[0].options[0].word.meanings, undefined);
  }
  const original = JSON.parse(await readFile(path.join(recordsRoot, 'ai-test', `${id}.json`), 'utf8'));
  assert.deepEqual(original.selectedScope[0].unitIds, ['25', '26']);
  assert.deepEqual(original.models, models);
  assert.deepEqual(original.providers, Object.fromEntries(Object.keys(models).map((stage) => [stage, provider])));
  const answers = original.questions.map((q, i) => i ? (q.answerIndex + 1) % 5 : q.answerIndex);
  await api(`/api/ai/exams/${id}/progress`, 'PATCH', { answers, position: 1 });
  assert.deepEqual((await api(`/api/ai/exams/${id}`)).answers, answers);
  const result = await api(`/api/ai/exams/${id}/submit`, 'POST', { answers });
  assert.equal(result.score.correct, 1);
  for (let i = 0; i < 300; i++) {
    const saved = await api(`/api/ai/exams/${id}`);
    if (saved.summaryStatus === 'complete') break;
    if (saved.summaryStatus === 'failed') throw new Error(saved.summaryError);
    if (i === 299) throw new Error('Summary timed out');
    await pause();
  }
  const md = await readFile(path.join(recordsRoot, 'ai-test', `${id}.md`), 'utf8');
  assert.match(md, /25과/); assert.match(md, /26과/); assert.match(md, /부족한 점/);
  console.log(`Paired results and summary saved: ${id}`);
  const secondId = await makeExam(1, 'weak', 'medium');
  assert.deepEqual(historyCounts, previous ? [1] : [0, 1]);
  const report = { completedAt: new Date().toISOString(), provider, model, examIds: [id, secondId], historyCounts, recordsRoot,
    verified: [`${provider} OAuth`, 'stage model selection', 'flash marks/counts', 'both question polarities', 'blind validation', 'answer concealment', 'resume answers', 'grading', 'paired JSON/Markdown', 'second generation with prior memory'] };
  await writeFile(path.join(qaRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await client.close();
}
