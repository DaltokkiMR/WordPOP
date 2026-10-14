// Live Copilot verification with wholly synthetic data. Never reads the user's word_list or records.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { CopilotClient } from '../lib/copilot-client.mjs';
import { AIService } from '../lib/ai-service.mjs';
import { collectWords, createFlashSession, revealFlash, gradeFlash } from '../public/js/model.js';

const root = await mkdtemp(path.join(tmpdir(), 'wordpop-copilot-synthetic-'));
const libraryRoot = path.join(root, 'word_list');
const recordsRoot = path.join(root, 'records');
await mkdir(path.join(libraryRoot, 'synthetic'), { recursive: true });
const examples = [
  ['apple', '사과', 'A round fruit that grows on a tree and has red, green, or yellow skin.'],
  ['bed', '침대', 'A piece of furniture that people sleep on.'],
  ['cat', '고양이', 'A small animal with soft fur that is often kept as a pet and catches mice.'],
  ['dog', '개', 'An animal commonly kept as a pet that often barks.'],
  ['egg', '알', 'An oval object laid by a bird, usually with a hard shell.'],
  ['chair', '의자', 'A seat for one person, usually with a back and four legs.'],
  ['book', '책', 'A set of printed pages held together inside a cover.'],
  ['river', '강', 'A large natural stream of water flowing across land.'],
  ['shoe', '신발', 'A covering for a foot, typically made with a firm sole.'],
  ['window', '창문', 'An opening in a wall, usually fitted with glass, that lets in light.'],
];
const unit = { schemaVersion: 1, bookId: 'synthetic', bookTitle: '가상 테스트 교재', unitId: '1', unitTitle: '1과',
  words: examples.map(([word, ko, en]) => ({ id: word, word, meanings: [{ ko, en }] })) };
await writeFile(path.join(libraryRoot, 'synthetic/unit-1.json'), JSON.stringify(unit));
const client = new CopilotClient();
const engine = new AIService({ clients: { copilot: client } });
const historyCounts = [];
const ai = {
  generateExam(input) { historyCounts.push(input.history.length); return engine.generateExam(input); },
  summarizeExam(input) { return engine.summarizeExam(input); },
};
const server = createApp({ libraryRoot, recordsRoot, copilot: client, ai });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function api(route, method = 'GET', body) {
  const response = await fetch(base + route, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok) throw new Error(`${route}: ${value.error}`);
  return value;
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 1000));
async function generate(count, mode) {
  const job = await api('/api/ai/jobs', 'POST', { unitKeys: ['synthetic/unit-1.json'], options: { count, mode, difficulty: 'easy' } });
  let previous;
  for (let i = 0; i < 1200; i++) {
    const current = await api(`/api/ai/jobs/${job.id}`);
    if (current.stage !== previous) { console.log(`${mode}: ${current.stage}`); previous = current.stage; }
    if (current.status === 'complete') return current.examId;
    if (['failed', 'cancelled'].includes(current.status)) throw new Error(current.error);
    await pause();
  }
  throw new Error('Synthetic exam timed out');
}
try {
  const status = await api('/api/ai/status?provider=copilot');
  assert.equal(status.account?.type, 'copilot', 'Sign in to GitHub Copilot first.');
  const model = process.env.WORDPOP_AI_MODEL || 'gpt-5.6-terra';
  assert.ok(status.models.some((item) => item.id === model), 'Select an available WORDPOP_AI_MODEL.');
  const models = Object.fromEntries(['collect', 'select', 'generate', 'verify'].map((stage) => [stage, model]));
  await api('/api/settings', 'PUT', { stages: Object.fromEntries(Object.keys(models).map((stage) => [stage, { provider: 'copilot', model }])) });
  const words = collectWords([{ ...unit, key: 'synthetic/unit-1.json' }]);
  await api('/api/word-mark', 'PATCH', { sourceRefs: words[0].sourceRefs, mark: 'unknown' });
  let flash = createFlashSession(words, 10, false);
  flash = gradeFlash(revealFlash(flash), false);
  while (flash.phase !== 'complete') flash = gradeFlash(revealFlash(flash), true);
  await api('/api/flash-records', 'POST', { session: flash });
  console.log(`Synthetic only: ${root}; Copilot model: ${model}`);
  const first = await generate(2, 'normal');
  const shown = await api(`/api/ai/exams/${first}`);
  assert.deepEqual(Object.values(shown.providers), ['copilot', 'copilot', 'copilot', 'copilot']);
  assert.equal(shown.questions[0].answerIndex, undefined);
  const original = JSON.parse(await readFile(path.join(recordsRoot, 'ai-test', `${first}.json`), 'utf8'));
  assert.deepEqual(original.models, models);
  const answers = original.questions.map((q, index) => index ? (q.answerIndex + 1) % 5 : q.answerIndex);
  await api(`/api/ai/exams/${first}/progress`, 'PATCH', { answers, position: 1 });
  assert.deepEqual((await api(`/api/ai/exams/${first}`)).answers, answers);
  assert.equal((await api(`/api/ai/exams/${first}/submit`, 'POST', { answers })).score.correct, 1);
  for (let i = 0; i < 300; i++) {
    const result = await api(`/api/ai/exams/${first}`);
    if (result.summaryStatus === 'complete') break;
    if (result.summaryStatus === 'failed') throw new Error(result.summaryError);
    if (i === 299) throw new Error('Synthetic summary timed out');
    await pause();
  }
  const markdown = await readFile(path.join(recordsRoot, 'ai-test', `${first}.md`), 'utf8');
  assert.match(markdown, /GitHub Copilot/); assert.match(markdown, /가상 테스트 교재/);
  const second = await generate(1, 'weak');
  assert.deepEqual(historyCounts, [0, 1]);
  const report = { completedAt: new Date().toISOString(), provider: 'copilot', model, examIds: [first, second], historyCounts, recordsRoot,
    verified: ['managed login', 'four stages', 'independent verification', 'synthetic flash records', 'answer concealment', 'resume', 'grading', 'paired JSON/Markdown', 'reuse synthetic history'] };
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await client.close();
}
