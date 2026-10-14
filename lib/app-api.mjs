import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadLibrary } from './library.mjs';
import { collectWords } from '../public/js/model.js';
import { RecordStore, examFormat } from './records.mjs';
import { rangeLevels, inStudyRange, rangeLabel } from '../public/js/study-marks.js';
import { CodexClient } from './codex-client.mjs';
import { CopilotClient } from './copilot-client.mjs';
import { ClaudeClient } from './claude-client.mjs';
import { AIService } from './ai-service.mjs';

const stages = ['collect', 'select', 'generate', 'verify'];
const stageNames = { collect: '자료 수집', select: '단어 선별', generate: '문제 생성', verify: '독립 검수' };
const providerNames = { codex: 'ChatGPT', copilot: 'GitHub Copilot', claude: 'Claude' };
const accountTypes = { codex: 'chatgpt', copilot: 'copilot', claude: 'claude' };
function checkProvider(provider) {
  if (typeof provider !== 'string' || !Object.hasOwn(providerNames, provider)) throw apiError('지원하지 않는 AI 연결입니다.');
  return provider;
}
export const apiError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const modelId = (model) => model.id || model.model;

// Exam answers and source meanings are withheld until the user submits the test.
export function publicExam(exam) {
  if (exam.status === 'complete') return exam;
  const word = ({ key, word: spelling, sourceRefs }) => ({ key, word: spelling, sourceRefs: sourceRefs?.map(({ meaningKeys, ...source }) => source) });
  const format = examFormat(exam);
  return {
    examId: exam.examId, type: 'ai-test', format, status: exam.status,
    createdAt: exam.createdAt, updatedAt: exam.updatedAt,
    selectedScope: exam.selectedScope, options: exam.options, models: exam.models, providers: exam.providers,
    answers: exam.answers, position: exam.position,
    questions: exam.questions.map((q) => format === 'ox'
      ? { id: q.id, word: word(q.word), definition: q.definition }
      : { id: q.id, kind: q.kind, options: q.options.map((o) => ({ word: word(o.word), definition: o.definition })) }),
  };
}

function examSummary(exam) {
  return { examId: exam.examId, type: 'ai-test', format: examFormat(exam), status: exam.status, providers: exam.providers, createdAt: exam.createdAt,
    updatedAt: exam.updatedAt, selectedScope: exam.selectedScope, questionCount: exam.questions.length,
    answeredCount: exam.answers.filter((answer) => answer !== null).length,
    ...(exam.status === 'complete' ? { correctCount: exam.score.correct } : {}) };
}

function selectedScope(units) {
  const books = new Map();
  for (const unit of units) {
    if (!books.has(unit.bookId)) books.set(unit.bookId, { bookId: unit.bookId, bookTitle: unit.bookTitle, unitIds: [], units: [] });
    const book = books.get(unit.bookId);
    book.unitIds.push(unit.unitId);
    book.units.push({ unitId: unit.unitId, unitTitle: unit.unitTitle, unitKey: unit.key });
  }
  return [...books.values()];
}

async function readJSON(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw apiError('JSON 형식으로 요청해 주세요.', 415);
  const buffers = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw apiError('요청 내용이 너무 큽니다.', 413);
    buffers.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw apiError('요청 내용을 읽지 못했습니다.'); }
}

export function createAPI({ libraryRoot, recordsRoot, store = new RecordStore({ libraryRoot, recordsRoot }),
  codex = new CodexClient(), copilot = new CopilotClient(), claude = new ClaudeClient(),
  ai = new AIService({ clients: { codex, copilot, claude } }) }) {
  const clients = { codex, copilot, claude };
  // Every provider keeps its own login, so status and login requests name the provider.
  const providerFor = (url) => checkProvider(url.searchParams.get('provider') ?? 'codex');
  const jobs = new Map();
  const summaries = new Map();
  const summaryControllers = new Map();
  let settingsQueue = Promise.resolve();
  let reservingJob = false;
  const publicJob = ({ controller, ...job }) => job;

  function updateSettings(body) {
    // Preserve arrival order even when checking one provider takes longer than another.
    const update = settingsQueue.then(async () => {
      if (!object(body.stages) || !Object.keys(body.stages).length || Object.keys(body).some((key) => key !== 'stages')) throw apiError('단계별 AI 연결과 모델을 선택해 주세요.');
      const entries = Object.entries(body.stages).map(([stage, value]) => {
        if (!stages.includes(stage) || !object(value) || Object.keys(value).some((key) => !['provider', 'model'].includes(key))) throw apiError('단계별 AI 연결과 모델을 확인해 주세요.');
        if (value.model !== undefined && value.model !== null && typeof value.model !== 'string') throw apiError('모델 이름을 확인해 주세요.');
        return [stage, { provider: checkProvider(value.provider), model: value.model ?? null }];
      });
      const statuses = new Map();
      for (const [stage, { provider, model }] of entries) {
        if (model === null) continue;
        if (!statuses.has(provider)) statuses.set(provider, clients[provider].status());
        const status = await statuses.get(provider);
        if (!status.models.some((item) => modelId(item) === model)) throw apiError(`${stageNames[stage]} 단계에서 ${providerNames[provider]}의 사용 가능한 모델을 선택해 주세요.`);
      }
      return store.saveSettings({ stages: Object.fromEntries(entries) });
    });
    settingsQueue = update.catch(() => {});
    return update;
  }

  async function recoverSummary(exam) {
    if (exam.status === 'complete' && exam.summaryStatus === 'pending' && !summaries.has(exam.examId)) {
      return store.markSummaryFailed(exam.examId, '서버가 다시 시작되어 AI 요약이 중단되었습니다. 요약을 다시 요청해 주세요.');
    }
    return exam;
  }

  async function summarize(id) {
    if (summaries.has(id)) return summaries.get(id);
    const controller = new AbortController();
    summaryControllers.set(id, controller);
    const task = (async () => {
      const exam = await store.getExam(id);
      if (exam.summaryStatus === 'complete') return store.repairExamMarkdown(id);
      try {
        // Deletion can abort before the AI request starts listening to the signal.
        controller.signal.throwIfAborted();
        // The summary reuses the provider and model that collected the study evidence.
        const summary = await ai.summarizeExam({ exam, model: exam.models.collect, provider: checkProvider(exam.providers.collect), signal: controller.signal });
        return await store.saveSummary(id, summary);
      } catch (error) {
        // A deleted exam has nothing left to mark as failed.
        if (controller.signal.aborted) return null;
        return store.markSummaryFailed(id, error.message);
      }
    })().finally(() => { summaries.delete(id); summaryControllers.delete(id); });
    summaries.set(id, task);
    return task;
  }

  async function startJob(body) {
    if (reservingJob || [...jobs.values()].some((job) => job.status === 'running')) throw apiError('이미 시험을 만들고 있습니다.', 409);
    reservingJob = true;
    try {
      const library = await loadLibrary(libraryRoot);
      if (!Array.isArray(body.unitKeys) || !body.unitKeys.length || body.unitKeys.some((key) => typeof key !== 'string')) throw apiError('시험 범위를 선택해 주세요.');
      const keys = new Set(body.unitKeys);
      const units = library.books.flatMap((book) => book.units).filter((unit) => keys.has(unit.key));
      if (units.length !== keys.size) throw apiError('선택한 과를 찾을 수 없습니다. 자료를 새로고침해 주세요.');
      const options = body.options || {};
      if (![undefined, 'choice', 'ox'].includes(options.format)) throw apiError('시험 형식을 확인해 주세요.');
      const ox = options.format === 'ox';
      // The range is a minimum level plus the 모르는 의미만 switch. The earlier exact-level scope meant something else, so it is refused rather than guessed.
      const level = options.level ?? 'all';
      if (Object.hasOwn(options, 'scope') || !rangeLevels.includes(level) || ![undefined, true, false].includes(options.unknownOnly)) throw apiError('출제 범위를 확인해 주세요. 앱을 새로고침한 뒤 다시 시도해 주세요.');
      const range = { level, unknownOnly: options.unknownOnly === true };
      const words = collectWords(units).filter((word) => inStudyRange(word, range));
      if (!words.length) throw apiError(`선택한 과에 ‘${rangeLabel(range)}’에 해당하는 단어가 없습니다.`);
      if (!ox && words.length < 5) throw apiError(`5지선다 AI 시험에는 출제 범위에 단어가 5개 이상 필요합니다. 지금은 ${words.length}개입니다.`);
      const maxCount = ox ? words.length : Math.floor(words.length / 5);
      if (!Number.isSafeInteger(options.count) || options.count < 1 || options.count > maxCount) throw apiError(`문항 수는 1~${maxCount}개로 설정해 주세요.`);
      if (!['normal', 'weak'].includes(options.mode) || !['easy', 'medium', 'hard'].includes(options.difficulty)) throw apiError('출제 모드와 난이도를 확인해 주세요.');
      const settings = await store.getSettings();
      const providers = Object.fromEntries(stages.map((stage) => [stage, checkProvider(settings.stages[stage].provider)]));
      const used = [...new Set(Object.values(providers))];
      const statuses = Object.fromEntries(await Promise.all(used.map(async (provider) => [provider, await clients[provider].status()])));
      for (const provider of used) {
        const account = statuses[provider].account;
        if (account?.type !== accountTypes[provider] || account?.authenticated === false) throw apiError(`설정에서 ${providerNames[provider]} 계정으로 연결해 주세요.`, 401);
      }
      const models = Object.fromEntries(stages.map((stage) => [stage, settings.stages[stage].model || statuses[providers[stage]].defaultModel]));
      for (const stage of stages) {
        if (!statuses[providers[stage]].models.some((model) => modelId(model) === models[stage])) throw apiError(`${stageNames[stage]} 단계의 ${providerNames[providers[stage]]} 모델을 사용할 수 없습니다. 설정에서 다시 선택해 주세요.`, 409);
      }
      const [records, history] = await Promise.all([store.readFlashRecords(words), store.relatedHistory(units, words, 20)]);
      const controller = new AbortController();
      const job = { id: randomUUID(), format: ox ? 'ox' : 'choice', providers, status: 'running', stage: 'collect', createdAt: new Date().toISOString(), controller };
      jobs.set(job.id, job);
      for (const [id, previous] of jobs) if (jobs.size > 50 && previous.status !== 'running') jobs.delete(id);
      const frozenOptions = { ...(ox ? { format: 'ox' } : {}), ...range, count: options.count, mode: options.mode, difficulty: options.difficulty };
      void (async () => {
        try {
          const generated = await ai.generateExam({ words, units, options: frozenOptions, models, providers, records, history, signal: controller.signal,
            onProgress(progress) { if (job.status === 'running') { job.stage = typeof progress === 'string' ? progress : progress.stage; job.message = progress.message; } },
          });
          controller.signal.throwIfAborted();
          job.stage = 'saving';
          const exam = await store.createExam({ ...generated, providers, type: 'ai-test', createdAt: job.createdAt, selectedScope: selectedScope(units), options: frozenOptions, models });
          job.status = 'complete'; job.examId = exam.examId; job.stage = 'complete';
        } catch (error) {
          job.status = controller.signal.aborted ? 'cancelled' : 'failed';
          job.error = controller.signal.aborted ? '시험 만들기를 취소했습니다.' : error.message;
        }
      })();
      return job;
    } finally { reservingJob = false; }
  }

  return {
    close() {
      for (const job of jobs.values()) if (job.status === 'running') job.controller.abort();
      for (const controller of summaryControllers.values()) controller.abort();
      for (const client of Object.values(clients)) Promise.resolve().then(() => client.close()).catch(() => {});
    },
    async handle(request, url, send) {
      const method = request.method;
      const read = ['GET', 'HEAD'].includes(method);
      const json = (data, status = 200) => send(status, 'application/json', JSON.stringify(data));
      if (url.pathname === '/api/library' && read) return json(await loadLibrary(libraryRoot));
      if (url.pathname === '/api/word-mark' && method === 'PATCH') return json(await store.setWordMark(await readJSON(request)));
      if (url.pathname === '/api/flash-records' && method === 'POST') return json(await store.saveFlash((await readJSON(request)).session));
      if (url.pathname === '/api/settings') {
        if (read) return json(await store.getSettings());
        if (method === 'PUT') {
          return json(await updateSettings(await readJSON(request)));
        }
      }
      if (url.pathname === '/api/ai/status' && read) {
        const provider = providerFor(url);
        return json({ ...await clients[provider].status(), provider });
      }
      if (url.pathname === '/api/ai/login' && method === 'POST') return json(await clients[providerFor(url)].login());
      const login = url.pathname.match(/^\/api\/ai\/login\/([^/]+)$/);
      if (login && method === 'DELETE') return json(await clients[providerFor(url)].cancelLogin(login[1]));
      if (url.pathname === '/api/ai/jobs' && method === 'POST') return json(publicJob(await startJob(await readJSON(request))), 202);
      const jobMatch = url.pathname.match(/^\/api\/ai\/jobs\/([^/]+)$/);
      if (jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) throw apiError('생성 작업을 찾을 수 없습니다. 시험 목록을 확인한 후 새로 만들어 주세요.', 404);
        if (method === 'DELETE') {
          if (job.status === 'running' && job.stage !== 'saving') { job.controller.abort(); job.status = 'cancelled'; }
          return json(publicJob(job));
        }
        if (read) return json(publicJob(job));
      }
      if (url.pathname === '/api/ai/exams' && read) return json((await Promise.all((await store.listExams()).map(recoverSummary))).map(examSummary));
      const match = url.pathname.match(/^\/api\/ai\/exams\/([\d-]+)(?:\/(progress|submit|summary|export))?$/);
      if (match) {
        const [, id, action] = match;
        if (!action && read) return json(publicExam(await recoverSummary(await store.getExam(id))));
        if (!action && method === 'DELETE') {
          summaryControllers.get(id)?.abort();
          await summaries.get(id)?.catch(() => {});
          return json(await store.deleteExam(id));
        }
        if (action === 'progress' && method === 'PATCH') return json(publicExam(await store.saveProgress(id, await readJSON(request))));
        if (action === 'submit' && method === 'POST') {
          const exam = await store.submitExam(id, await readJSON(request));
          void summarize(id).catch((error) => console.error('시험 요약 저장 실패:', error.message));
          return json(publicExam(exam));
        }
        if (action === 'summary' && method === 'POST') {
          const exam = await store.getExam(id);
          if (exam.status !== 'complete') throw apiError('시험을 제출한 뒤 요약할 수 있습니다.');
          const summarized = await summarize(id);
          if (!summarized) throw apiError('시험을 찾을 수 없습니다.', 404);
          return json(publicExam(summarized));
        }
        if (action === 'export' && read) {
          const exam = await store.getExam(id);
          const format = url.searchParams.get('format');
          if (format === 'json') return send(200, 'application/json', JSON.stringify(publicExam(exam), null, 2), { 'Content-Disposition': `attachment; filename="${id}.json"` });
          if (format === 'md') {
            if (exam.status !== 'complete') throw apiError('시험을 제출한 뒤 결과를 내려받을 수 있습니다.');
            await store.repairExamMarkdown(id);
            return send(200, 'text/markdown', await readFile(path.join(recordsRoot, 'ai-test', `${id}.md`), 'utf8'), { 'Content-Disposition': `attachment; filename="${id}.md"` });
          }
          throw apiError('저장 형식을 확인해 주세요.');
        }
      }
      return json({ error: '지원하지 않는 요청입니다.' }, read ? 404 : 405);
    },
  };
}
