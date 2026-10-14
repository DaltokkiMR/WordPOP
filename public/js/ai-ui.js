import { read, write } from './storage.js';
import { icon } from './icons.js';
import { rangeLabel, rangeTags } from './study-marks.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const difficultyNames = { easy: '쉬움', medium: '보통', hard: '어려움' };
const stageNames = { queued: '출제 준비', collect: '자료 수집', select: '단어 선별', generate: '문제 생성', verify: '독립 검수', save: '시험 저장', saving: '시험 저장', complete: '시험 생성 완료', failed: '시험 생성 실패', cancelled: '시험 생성 취소' };
const modelFields = { collect: '자료 수집', select: '단어 선별', generate: '문제 생성', verify: '독립 검수' };
const providerNames = { codex: 'ChatGPT', copilot: 'GitHub Copilot', claude: 'Claude' };
const accountTypes = { codex: ['chatgpt', 'chatgptAuthTokens'], copilot: ['copilot'], claude: ['claude'] };
const loginLabels = { codex: 'ChatGPT로 로그인', copilot: 'GitHub로 로그인', claude: 'Claude로 로그인' };
const normalizeProvider = (provider) => Object.hasOwn(providerNames, provider) ? provider : 'codex';
const accountConnected = (connection, provider) => {
  const account = connection?.account?.account || connection?.account;
  return account?.authenticated !== false && accountTypes[provider].includes(account?.type);
};
const authUrl = (value) => typeof value === 'string' && /^https?:\/\//.test(value) ? value : '';
const providerList = Object.keys(providerNames);
const modelId = (model) => model.model || model.id;
/** Names each provider an exam used once, in stage order. */
const examProvider = (exam) => [...new Set(exam.providers ? Object.values(exam.providers) : [exam.provider])].map((provider) => providerNames[normalizeProvider(provider)]).join(' · ');
const wordText = (option) => typeof option.word === 'string' ? option.word : option.word?.word || '';
const responseExam = (value) => value.exam || value;
/** O/X exams store true for O and false for X; five-option exams store the option index. */
export const isOXExam = (exam) => exam?.format === 'ox' || exam?.options?.format === 'ox';
export const aiExamTitle = (exam) => isOXExam(exam) ? 'AI 영영풀이 O/X' : 'AI 영영풀이 시험';
const validAnswer = (exam, answer) => isOXExam(exam) ? typeof answer === 'boolean' : Number.isInteger(answer) && answer >= 0 && answer < 5;
const validDraft = (draft, exam) => draft && Array.isArray(draft.answers) && draft.answers.length === exam.questions.length && draft.answers.every((answer) => answer === null || validAnswer(exam, answer));
const oxLabel = (answer) => answer === true ? 'O' : answer === false ? 'X' : '-';
/** Scope and mode chosen when an AI exam was made; older five-option exams used every word. */
const examOptionsLabel = (exam) => `${rangeLabel(exam.options)}${exam.options?.mode === 'weak' ? ' · 헷갈리는 단어 위주' : ''}`;

export async function request(path, options = {}) {
  let response;
  try { response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }); }
  catch { throw new Error('서버에 연결하지 못했어요. 서버를 켠 뒤 다시 시도해 주세요.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `요청을 완료하지 못했어요. (${response.status})`), { status: response.status });
  return data;
}

export function scopeLabel(scope = []) {
  return scope.map((book) => {
    const titles = book.units?.map((unit) => unit.unitTitle) || book.unitIds?.map((id) => `${id}과`) || [];
    return `${book.bookTitle || book.bookId} · ${titles.join(' · ')}`;
  }).join(' / ');
}

/** Unit titles only, matching how local decks and exams name their range. */
export const scopeUnitsLabel = (scope = []) => scope.flatMap((book) => book.units?.map((unit) => unit.unitTitle) || book.unitIds?.map((id) => `${id}과`) || []).join(', ');

/** Card data for the home feed; the exam's range becomes the title and its options become tags. */
export function aiExamSummary(exam) {
  const complete = exam.status === 'complete';
  const count = exam.questionCount ?? exam.options?.count ?? exam.questions?.length ?? 0;
  const answered = exam.answeredCount ?? exam.answers?.filter((answer) => answer !== null).length ?? 0;
  const correct = exam.correctCount ?? exam.results?.filter((result) => result.correct).length ?? exam.score?.correct;
  const tags = [...rangeTags(exam.options), exam.options?.mode === 'weak' ? '헷갈리는 단어 위주' : '', difficultyNames[exam.options?.difficulty] || ''].filter(Boolean);
  const units = scopeUnitsLabel(exam.selectedScope);
  return { kind: isOXExam(exam) ? 'ai-ox' : 'ai', id: exam.examId, deleteKind: 'ai', action: 'ai-open', fullTitle: `${aiExamTitle(exam)} · ${units}`,
    tooltip: `${aiExamTitle(exam)} · ${scopeLabel(exam.selectedScope)}`, title: units, tags, complete,
    statusText: complete ? (Number.isFinite(correct) ? `${correct}/${count} 정답` : '완료') : `${answered}/${count}문항`,
    progress: [complete ? count : answered, count], createdAt: exam.createdAt };
}

function optionMarkup(option, index, answer, result = false, answerIndex = null) {
  return `<${result ? 'div' : 'button'} class="ai-option ${answer === index ? 'selected' : ''} ${result && answerIndex === index ? 'correct-option' : ''}" ${result ? '' : `data-action="ai-answer" data-index="${index}" aria-pressed="${answer === index}"`}><span class="ai-option-number">${index + 1}</span><span class="ai-option-copy"><strong lang="en">${esc(wordText(option))}</strong><span lang="en">${esc(option.definition)}</span>${result ? `<small>${option.isCorrect === true ? '올바른 풀이' : option.isCorrect === false ? '틀린 풀이' : ''}${option.explanation ? ` · ${esc(option.explanation)}` : ''}</small>` : ''}</span>${result && answerIndex === index ? `<span class="pill">정답</span>` : ''}</${result ? 'div' : 'button'}>`;
}

function oxChoicesMarkup(answer) {
  return `<div class="study-actions ox-actions ai-ox-actions">${[[true, 'o', '올바른 뜻이에요'], [false, 'x', '다른 뜻이에요']].map(([value, key, label]) => `<button class="ox-button ${key}-button ${answer === value ? 'selected' : ''}" data-action="ai-answer" data-answer="${key}" aria-pressed="${answer === value}"><span class="ox-symbol">${key.toUpperCase()}</span><span>${label}</span><kbd>${key.toUpperCase()}</kbd></button>`).join('')}</div>`;
}

/** Review items carry their index so their open state can survive a re-render. */
const reviewAttributes = (index, open) => `class="review-item ai-review" data-review-index="${index}"${open ? ' open' : ''}`;

function oxReviewMarkup(question, result, index, open = false) {
  const answer = result?.answer ?? null;
  const correct = result?.correct ?? answer === question.isCorrect;
  const sense = question.word?.meanings?.[question.meaningIndex];
  return `<details ${reviewAttributes(index, open)}><summary><span class="review-badge ${correct ? 'correct' : 'incorrect'}">${correct ? '정답' : '오답'}</span><strong lang="en">${index + 1}. ${esc(wordText(question))}</strong><span class="difficulty-badge">${esc(difficultyNames[question.difficulty] || question.difficulty || '')}</span><span>${correct ? '' : `내 답 ${oxLabel(answer)} · 정답 ${oxLabel(question.isCorrect)}`}</span>${icon('chevron')}</summary><div class="review-content"><p class="review-question" lang="en">제시한 풀이: ${esc(question.definition)}</p>${question.confusionTarget ? `<p class="ai-confusion"><strong>확인한 혼동</strong>${esc(question.confusionTarget)}</p>` : ''}${sense ? `<div class="meanings"><div class="meaning"><span class="meaning-number">${String(question.meaningIndex + 1).padStart(2, '0')}</span><div class="meaning-copy"><strong>${esc(sense.ko)}</strong><p lang="en">${esc(sense.en)}</p></div></div></div>` : ''}${question.explanation ? `<p class="ai-explanation">${esc(question.explanation)}</p>` : ''}</div></details>`;
}

function oxCardMarkup(question) {
  return `<div class="quiz-card ai-ox-card"><h2 lang="en">${esc(wordText(question))}</h2><span class="definition-divider"></span><p class="quiz-definition" lang="en">${esc(question.definition)}</p></div>`;
}

/** Server-backed AI activities stay separate from the legacy local O/X session. */
export function createAIController({ onChange, onOpen, announce }) {
  let exams = [];
  let activeExam = null;
  let job = read('ai-job', null);
  if (!job || typeof job.id !== 'string') job = null;
  let pollTimer;
  let summaryTimer;
  // Results are re-rendered from HTML, so the explanations the learner opened are kept here.
  let openReviews = { examId: null, indexes: new Set() };
  const reviewOpen = (exam, index) => openReviews.examId === exam.examId && openReviews.indexes.has(index);
  // Side the last question move came from, so the next card slides in from there.
  let direction = '';
  let error = '';
  let listError = '';
  let loading = false;
  let loadSequence = 0;
  let submitting = false;
  let saving = false;
  let progressError = '';
  let jobPollError = '';
  let drafts = read('ai-drafts', {});
  if (!drafts || typeof drafts !== 'object' || Array.isArray(drafts)) drafts = {};
  let draftRevision = 0;
  let savingPromise = null;
  // True right after a progress save lands, so the status line can show and fade.
  let justSaved = false;
  let settingsDialog;
  let settingsError = '';
  let settingsBusy = false;
  let settingsNotice = '';
  let settingsSequence = 0;
  // Every provider is shown and connected independently.
  let connections = {};
  let checking = {};
  let connectionErrors = {};
  let connectionRevisions = {};
  let logins = {};
  let loginTimer;
  // stage → { provider, model }; model null means the provider's default.
  let stageDrafts = null;
  // stage → provider → model, so switching a stage's provider back restores its last choice.
  let modelMemory = {};

  const changed = () => onChange();
  const rememberJob = () => write('ai-job', job);
  const upsertExam = (exam) => { exams = [exam, ...exams.filter((item) => item.examId !== exam.examId)].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)); };
  const hasJob = () => job && job.status === 'running';

  async function refreshExams() {
    try {
      const value = await request('/api/ai/exams');
      exams = (Array.isArray(value) ? value : value.exams || []).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      listError = '';
    } catch (cause) { listError = cause.message; }
    changed();
  }

  function scheduleJobPoll(delay = 2000) {
    clearTimeout(pollTimer);
    if (hasJob()) pollTimer = setTimeout(pollJob, delay);
  }

  async function pollJob() {
    if (!hasJob()) return;
    const id = job.id;
    try {
      const latest = await request(`/api/ai/jobs/${encodeURIComponent(id)}`);
      if (job?.id !== id) return;
      const previous = JSON.stringify(job);
      job = latest;
      jobPollError = '';
      rememberJob();
      if (job.status === 'complete') {
        await refreshExams();
        if (job.examId && !activeExam) await openExam(job.examId, false);
        announce('AI 시험이 준비됐어요.');
      } else if (job.status === 'failed') {
        error = typeof job.error === 'string' ? job.error : job.error?.message || '시험을 만들지 못했어요. 설정을 확인하고 다시 시도해 주세요.';
      }
      if (previous !== JSON.stringify(job)) changed();
    } catch (cause) {
      jobPollError = cause.message;
      if (cause.status === 404 && job?.id === id) {
        job = { ...job, status: 'failed', error: cause.message };
        error = cause.message;
        rememberJob();
        void refreshExams();
      }
      changed();
    }
    scheduleJobPoll(jobPollError ? 6000 : 2000);
  }

  async function start(unitKeys, options) {
    if (hasJob() || loading) return;
    activeExam = null;
    loadSequence += 1;
    job = null;
    error = '';
    loading = true;
    direction = '';
    justSaved = false;
    onOpen();
    try {
      job = await request('/api/ai/jobs', { method: 'POST', body: JSON.stringify({ unitKeys, options }) });
      rememberJob();
      scheduleJobPoll(500);
    } catch (cause) { error = cause.message; }
    loading = false;
    changed();
  }

  async function cancelJob() {
    if (!hasJob()) return;
    const id = job.id;
    try {
      const result = await request(`/api/ai/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (job?.id !== id) return;
      job = { ...job, ...result };
      rememberJob();
      clearTimeout(pollTimer);
      jobPollError = '';
      if (job.status === 'complete' && job.examId) { await refreshExams(); if (!activeExam) await openExam(job.examId, false); }
      else if (hasJob()) scheduleJobPoll(500);
      changed();
    } catch (cause) {
      jobPollError = cause.message;
      if (cause.status === 404 && job?.id === id) {
        job = { ...job, status: 'failed', error: cause.message };
        error = cause.message;
        rememberJob();
        void refreshExams();
      }
      changed();
    }
  }

  function watchSummary() {
    clearTimeout(summaryTimer);
    if (activeExam?.status !== 'complete' || !['pending', 'running'].includes(activeExam.summaryStatus)) return;
    const id = activeExam.examId;
    summaryTimer = setTimeout(async () => {
      try {
        const exam = responseExam(await request(`/api/ai/exams/${encodeURIComponent(id)}`));
        if (activeExam?.examId !== id) return;
        // Polling only re-renders once the summary actually changes.
        const unchanged = JSON.stringify(exam) === JSON.stringify(activeExam);
        activeExam = exam;
        upsertExam(exam);
        if (!unchanged) changed();
        watchSummary();
      } catch (cause) { error = cause.message; changed(); }
    }, 3000);
  }

  async function openExam(id, navigate = true) {
    const sequence = ++loadSequence;
    error = '';
    progressError = '';
    loading = true;
    direction = '';
    justSaved = false;
    if (navigate) onOpen();
    else changed();
    try {
      const exam = responseExam(await request(`/api/ai/exams/${encodeURIComponent(id)}`));
      if (sequence !== loadSequence) return;
      if (exam.status !== 'complete' && validDraft(drafts[id], exam)) {
        exam.answers = [...drafts[id].answers];
        exam.position = Math.max(0, Math.min(exam.questions.length - 1, drafts[id].position || 0));
      } else if (drafts[id]) { delete drafts[id]; write('ai-drafts', drafts); }
      activeExam = exam;
      upsertExam(exam);
      watchSummary();
      if (drafts[id]) void saveProgress();
    } catch (cause) { if (sequence !== loadSequence) return; error = cause.message; }
    loading = false;
    changed();
  }

  function rememberProgress() {
    draftRevision += 1;
    drafts[activeExam.examId] = { answers: [...activeExam.answers], position: activeExam.position, updatedAt: new Date().toISOString() };
    write('ai-drafts', drafts);
    upsertExam(activeExam);
    void saveProgress();
  }

  async function saveProgress() {
    if (savingPromise) return savingPromise;
    const id = activeExam?.examId;
    if (!id || !drafts[id] || activeExam.status === 'complete') return;
    saving = true;
    justSaved = false;
    progressError = '';
    savingPromise = (async () => {
      while (drafts[id]) {
        const revision = draftRevision;
        const draft = drafts[id];
        try {
          await request(`/api/ai/exams/${encodeURIComponent(id)}/progress`, { method: 'PATCH', body: JSON.stringify({ answers: draft.answers, position: draft.position }) });
          if (revision === draftRevision || drafts[id] === draft) { delete drafts[id]; write('ai-drafts', drafts); }
        } catch (cause) { progressError = cause.message; break; }
      }
    })();
    await savingPromise;
    savingPromise = null;
    justSaved = !progressError;
    saving = false;
    changed();
    // A user can open another exam while the previous request is finishing.
    if (!progressError && activeExam?.examId !== id && drafts[activeExam?.examId]) void saveProgress();
  }

  function chooseAnswer(answer) {
    if (!activeExam || activeExam.status === 'complete' || submitting || !validAnswer(activeExam, answer)) return;
    activeExam.answers[activeExam.position] = answer;
    rememberProgress();
    changed();
  }

  function moveQuestion(offset) {
    if (!activeExam || activeExam.status === 'complete' || submitting) return;
    direction = offset > 0 ? 'next' : offset < 0 ? 'prev' : '';
    activeExam.position = Math.max(0, Math.min(activeExam.questions.length - 1, activeExam.position + offset));
    rememberProgress();
    changed();
    document.querySelector('#study-focus')?.focus({ preventScroll: true });
  }

  async function submit() {
    if (!activeExam || submitting || activeExam.answers.some((answer) => answer === null)) return;
    submitting = true;
    error = '';
    changed();
    const id = activeExam.examId;
    const answers = [...activeExam.answers];
    try {
      await saveProgress();
      const exam = responseExam(await request(`/api/ai/exams/${encodeURIComponent(id)}/submit`, { method: 'POST', body: JSON.stringify({ answers }) }));
      if (activeExam?.examId === id) activeExam = exam;
      delete drafts[id];
      write('ai-drafts', drafts);
      progressError = '';
      upsertExam(exam);
      watchSummary();
      announce('시험을 마쳤습니다. 결과를 확인해 주세요.');
    } catch (cause) { error = cause.message; }
    submitting = false;
    changed();
  }

  async function retrySummary() {
    if (!activeExam || activeExam.status !== 'complete') return;
    const id = activeExam.examId;
    error = '';
    activeExam.summaryStatus = 'pending';
    changed();
    try {
      const value = await request(`/api/ai/exams/${encodeURIComponent(id)}/summary`, { method: 'POST' });
      const next = responseExam(value);
      if (next.examId) upsertExam(next);
      if (activeExam?.examId === id && next.examId) activeExam = next;
      watchSummary();
    } catch (cause) { error = cause.message; if (activeExam?.examId === id) activeExam.summaryStatus = 'failed'; }
    changed();
  }

  function jobMarkup() {
    const running = hasJob();
    // The stage list names the four model stages; the line under it covers only states outside the list.
    const listed = Object.hasOwn(modelFields, job?.stage ?? '');
    const currentStage = stageNames[job?.stage] || job?.stage || '출제 준비';
    return `<section class="ai-job-panel" aria-live="polite"><span class="mode-icon lavender ${running ? 'working' : ''}">${icon('spark')}</span><h1>${loading && !job ? 'AI 시험을 준비하고 있어요' : running ? 'AI 시험을 만들고 있어요' : job?.status === 'cancelled' ? '시험 생성을 취소했어요' : 'AI 시험'}</h1>${running ? `<ol class="ai-stages">${Object.entries(modelFields).map(([key, title]) => `<li class="${key === job.stage ? 'current' : ''}">${esc(title)}</li>`).join('')}</ol>${listed ? '' : `<p class="ai-job-stage">${esc(currentStage)}</p>`}<button class="secondary-button" data-action="ai-cancel">생성 취소</button>` : ''}${jobPollError && running ? `<div class="notice error">${esc(jobPollError)} <button class="inline-link" data-action="ai-poll">연결 다시 확인</button></div>` : ''}${!running && !loading ? '<button class="primary-button" data-action="home">학습 만들기로 돌아가기</button>' : ''}</section>`;
  }

  function renderResults(exam) {
    const correct = exam.results?.filter((result) => result.correct).length || 0;
    const total = exam.questions.length;
    const summaryText = typeof exam.summary === 'string' ? exam.summary : exam.summary?.markdown || exam.summary?.text || '';
    const summary = summaryText ? `<div class="summary-text">${esc(summaryText)}</div>` : exam.summary && typeof exam.summary === 'object' ? `<div class="summary-groups">${[['strengths', '잘한 점'], ['weaknesses', '보완할 점'], ['recommendations', '다음 복습']].map(([key, title]) => Array.isArray(exam.summary[key]) && exam.summary[key].length ? `<h3>${title}</h3><ul>${exam.summary[key].map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '').join('')}</div>` : '';
    return `<main class="result-main ai-results" id="study-focus" tabindex="-1" data-enter="results:${esc(exam.examId)}"><div class="celebration-icon">${icon('spark')}</div><h1>${isOXExam(exam) ? 'AI O/X 시험 결과' : 'AI 시험 결과'}</h1><p class="ai-range">${esc(scopeLabel(exam.selectedScope))}<span class="ai-exam-scope">${esc(examOptionsLabel(exam))}</span><span class="ai-provider-label">${esc(examProvider(exam))}</span></p><div class="result-stats"><div><strong>${Math.round(correct / total * 100)}<small>%</small></strong><span>정답률</span></div><div><strong>${correct}<small> / ${total}</small></strong><span>맞힌 문항</span></div></div><div class="result-buttons"><button class="primary-button" data-action="home">돌아가기${icon('arrow')}</button></div><section class="ai-summary"><h2>학습 분석</h2>${summary ? summary : `<p>${['pending', 'running'].includes(exam.summaryStatus) ? '학습 결과를 분석하고 있어요…' : '문항별 결과는 저장되었습니다. 학습 분석을 다시 요청할 수 있어요.'}</p>`}${!['pending', 'running'].includes(exam.summaryStatus) && !summary ? '<button class="text-button" data-action="ai-summary">학습 분석 다시 시도</button>' : ''}</section><p class="ai-downloads"><a class="text-button" href="/api/ai/exams/${encodeURIComponent(exam.examId)}/export?format=md" download>Markdown 저장</a><a class="text-button" href="/api/ai/exams/${encodeURIComponent(exam.examId)}/export?format=json" download>JSON 저장</a></p><section class="answer-review"><h2>문항별 풀이 <span>${total}</span></h2>${exam.questions.map((question, index) => {
      if (isOXExam(exam)) return oxReviewMarkup(question, exam.results?.[index] || { answer: exam.answers[index] }, index, reviewOpen(exam, index));
      const result = exam.results?.[index] || { answer: exam.answers[index], answerIndex: question.answerIndex, correct: exam.answers[index] === question.answerIndex };
      return `<details ${reviewAttributes(index, reviewOpen(exam, index))}><summary><span class="review-badge ${result.correct ? 'correct' : 'incorrect'}">${result.correct ? '정답' : '오답'}</span><strong>${index + 1}번</strong><span class="difficulty-badge">${esc(difficultyNames[question.difficulty] || question.difficulty || '')}</span><span>${result.correct ? '' : `내 답 ${result.answer + 1} · 정답 ${result.answerIndex + 1}`}</span>${icon('chevron')}</summary><div class="review-content"><h3>${question.kind === 'incorrect' ? '옳지 않은' : '옳은'} 영영풀이 고르기</h3>${question.options.map((option, optionIndex) => optionMarkup(option, optionIndex, result.answer, true, result.answerIndex)).join('')}${question.explanation ? `<p class="ai-explanation">${esc(question.explanation)}</p>` : ''}</div></details>`;
    }).join('')}</section></main>`;
  }

  function renderMain() {
    const notice = error ? `<div class="notice error ai-top-notice" role="alert">${esc(error)} <button class="inline-link" data-action="ai-settings">AI 설정</button>${activeExam ? `<button class="inline-link" data-action="ai-open" data-id="${esc(activeExam.examId)}">다시 불러오기</button>` : ''}</div>` : '';
    if (loading || !activeExam) return `${notice}<main class="study-main ai-main">${jobMarkup()}</main>`;
    const exam = activeExam;
    if (exam.status === 'complete') return notice + renderResults(exam);
    const question = exam.questions[exam.position];
    const answered = exam.answers.filter((answer) => answer !== null).length;
    const ox = isOXExam(exam);
    const body = ox
      ? `<h1>${exam.position + 1}. 영영풀이가 이 단어의 뜻이면 <em>O</em>, 아니면 <em>X</em>를 고르세요.</h1>${oxCardMarkup(question)}${oxChoicesMarkup(exam.answers[exam.position])}`
      : `<h1>${exam.position + 1}. 다음 중 <em>${question.kind === 'incorrect' ? '옳지 않은' : '옳은'}</em> 영영풀이를 고르세요.</h1><div class="ai-options">${question.options.map((option, index) => optionMarkup(option, index, exam.answers[exam.position])).join('')}</div>`;
    return `${notice}<main class="study-main ai-main"><div class="study-topline"><span class="pill">${aiExamTitle(exam)} · ${esc(examOptionsLabel(exam))}</span><span>${exam.position + 1} / ${exam.questions.length}문항</span></div><progress class="progress-track" max="${exam.questions.length}" value="${answered}" aria-label="응답한 문항"></progress><section class="ai-question ${ox ? 'ai-ox-question' : ''}" id="study-focus" tabindex="-1" data-enter="question:${esc(exam.examId)}:${exam.position}"${direction ? ` data-direction="${direction}"` : ''}>${body}</section><div class="ai-navigation"><button class="secondary-button" data-action="ai-prev" ${exam.position === 0 || submitting ? 'disabled' : ''}>이전</button><span>${exam.position + 1 === exam.questions.length && answered < exam.questions.length ? `아직 ${exam.questions.length - answered}문항이 남았어요` : ''}</span>${exam.position + 1 < exam.questions.length ? `<button class="primary-button" data-action="ai-next" ${submitting ? 'disabled' : ''}>다음${icon('arrow')}</button>` : `<button class="primary-button" data-action="ai-submit" ${answered !== exam.questions.length || submitting ? 'disabled' : ''}>${submitting ? '채점 중…' : '제출하고 결과 보기'}</button>`}</div><div class="ai-question-jumps" aria-label="문항 이동">${exam.questions.map((_, index) => `<button data-action="ai-jump" data-index="${index}" class="${exam.position === index ? 'current' : ''} ${exam.answers[index] !== null ? 'answered' : ''}" aria-label="${index + 1}번 문항${exam.answers[index] !== null ? ', 응답 완료' : ''}" ${submitting ? 'disabled' : ''}>${index + 1}</button>`).join('')}</div><div class="save-state ${justSaved && !saving && !progressError ? 'saved' : ''}" role="status">${progressError ? `<span>${esc(progressError)} 응답은 이 브라우저에 보관 중입니다.</span> <button class="inline-link" data-action="ai-save">저장 다시 시도</button>` : saving ? '응답 저장 중…' : justSaved ? '응답 저장됨' : ''}</div></main>`;
  }

  function renderHomeNotice() {
    return `${listError ? `<div class="notice warning">${esc(listError)} <button class="inline-link" data-action="ai-refresh">AI 시험 다시 불러오기</button></div>` : ''}${hasJob() ? `<div class="notice ai-generation-notice"><span><span class="live-dot"></span>AI 시험 생성 중 · ${esc(stageNames[job.stage] || job.stage || '출제 준비')}</span><button class="inline-link" data-action="ai-job">진행 보기</button></div>` : job?.status === 'failed' ? `<div class="notice error">AI 시험을 만들지 못했어요. <button class="inline-link" data-action="ai-job">자세히 보기</button></div>` : ''}`;
  }

  function rateLimitMarkup(connection) {
    const data = connection?.rateLimits;
    const bucket = data?.rateLimitsByLimitId?.codex || data?.codex || data?.rateLimits || data;
    const windows = ['primary', 'secondary'].filter((key) => bucket?.[key]?.usedPercent != null);
    return windows.map((key, index) => {
      const window = bucket[key];
      const minutes = Number(window.windowDurationMins);
      const label = minutes === 10080 ? '주간 한도' : minutes === 1440 ? '일간 한도' : minutes > 0 ? `${minutes % 1440 === 0 ? `${minutes / 1440}일` : minutes % 60 === 0 ? `${minutes / 60}시간` : `${minutes}분`} 한도` : `사용 한도${windows.length > 1 ? ` ${index + 1}` : ''}`;
      const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
      return `<div class="usage-window"><span>${label}</span><strong>${remaining}% 남음</strong>${window.resetsAt ? `<small>${esc(new Date(window.resetsAt * 1000).toLocaleString('ko', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))} 초기화</small>` : ''}</div>`;
    }).join('');
  }

  const providerModels = (provider) => connections[provider]?.models || [];
  function defaultModel(provider) {
    const models = providerModels(provider);
    const fallback = models.find((item) => item.isDefault) || models[0];
    return connections[provider]?.defaultModel || (fallback ? modelId(fallback) : '');
  }
  const stageChoice = (stage) => {
    const provider = normalizeProvider(stageDrafts?.[stage]?.provider);
    return { provider, model: stageDrafts?.[stage]?.model || defaultModel(provider) };
  };

  function connectionMarkup(provider) {
    const connection = connections[provider];
    const account = connection?.account?.account || connection?.account;
    const connected = accountConnected(connection, provider);
    const login = logins[provider];
    const busy = checking[provider];
    const statusText = connected ? account.email || account.login || account.username || '로그인됨' : busy && !connection ? '연결 확인 중…' : account?.type === 'apiKey' || account?.type === 'apikey' ? 'API 키 연결 중 · ChatGPT 로그인이 필요합니다' : connection?.setupRequired ? '연결 준비가 필요합니다' : connection ? '로그인이 필요합니다' : '연결 확인 전';
    const instructions = connection?.instructions || connection?.setup?.instructions || (connection?.setupRequired || (connection && !providerModels(provider).length) ? connection?.message : '');
    const instructionText = Array.isArray(instructions) ? instructions.join('\n') : typeof instructions === 'string' ? instructions : '';
    const loginUrl = authUrl(login?.authUrl);
    return `<section class="connection-panel ${connected ? 'connected' : ''}" aria-label="${providerNames[provider]} 연결"><div><strong>${providerNames[provider]}</strong><span>${esc(statusText)}</span></div><button class="text-button" data-ai-setting-action="refresh" data-provider="${provider}" ${busy ? 'disabled' : ''}>${icon('refresh')}연결 확인</button>${!connected && !login ? `<button class="secondary-button" data-ai-setting-action="login" data-provider="${provider}" ${busy || connection?.setupRequired ? 'disabled' : ''}>${loginLabels[provider]}</button>` : ''}${instructionText ? `<p class="connection-instructions">${esc(instructionText)}</p>` : ''}${connectionErrors[provider] ? `<p class="connection-error" role="alert">${esc(connectionErrors[provider])}</p>` : ''}${login ? `<div class="ai-login-pending">${login.message ? `<p>${esc(login.message)}</p>` : ''}${login.userCode ? `<p>GitHub 로그인 화면에 아래 코드를 입력해 주세요.</p><strong class="ai-device-code" aria-label="GitHub 로그인 코드">${esc(login.userCode)}</strong>` : ''}${loginUrl ? `<a class="inline-link" href="${esc(loginUrl)}" target="_blank" rel="noopener noreferrer">로그인 창 열기</a>` : ''}<p role="status">로그인이 완료되면 자동으로 연결을 확인합니다.</p><button class="text-button" data-ai-setting-action="cancel-login" data-provider="${provider}">로그인 취소</button></div>` : ''}${provider === 'codex' ? rateLimitMarkup(connection) : ''}</section>`;
  }

  function stageMarkup(stage, label) {
    const { provider, model: selectedModel } = stageChoice(stage);
    const models = providerModels(provider);
    const connected = accountConnected(connections[provider], provider);
    const unavailable = selectedModel && models.length && !models.some((model) => modelId(model) === selectedModel);
    const providerOptions = providerList.map((name) => `<option value="${name}" ${name === provider ? 'selected' : ''}>${providerNames[name]}${connections[name] && !accountConnected(connections[name], name) ? ' (연결 안 됨)' : ''}</option>`).join('');
    const modelOptions = !models.length ? `<option value="">${checking[provider] ? '모델 불러오는 중…' : connected ? '모델을 불러오지 못했습니다' : '로그인 후 모델 선택'}</option>`
      : `${unavailable ? `<option value="${esc(selectedModel)}" selected>${esc(selectedModel)} (사용 불가)</option>` : ''}${models.map((model) => `<option value="${esc(modelId(model))}" ${modelId(model) === selectedModel ? 'selected' : ''}>${esc(model.displayName || modelId(model))}${model.isDefault ? ' · 기본' : ''}</option>`).join('')}`;
    return `<div class="model-field"><span>${label}</span><select data-stage-provider="${stage}" aria-label="${label} AI 연결" ${settingsBusy ? 'disabled' : ''}>${providerOptions}</select><select data-model-stage="${stage}" aria-label="${label} 모델" ${settingsBusy || !models.length ? 'disabled' : ''}>${modelOptions}</select></div>`;
  }

  function renderSettings() {
    if (!settingsDialog) return;
    settingsDialog.innerHTML = `<button class="dialog-close text-button" data-ai-setting-action="close" aria-label="설정 닫기">${icon('close')}</button><h2 id="ai-settings-title">AI 설정</h2><p class="ai-settings-intro">세 서비스를 모두 연결해 둘 수 있어요. 단계마다 원하는 서비스의 모델을 골라 섞어 쓸 수 있습니다.</p><div class="connection-list">${providerList.map(connectionMarkup).join('')}</div><h3 class="model-settings-title">단계별 모델</h3><div class="model-settings">${Object.entries(modelFields).map(([stage, label]) => stageMarkup(stage, label)).join('')}</div>${settingsError ? `<div class="notice error" role="alert">${esc(settingsError)}</div>` : ''}${settingsNotice ? `<p class="settings-saved" role="status">${esc(settingsNotice)}</p>` : ''}<div class="dialog-actions"><button class="secondary-button" data-ai-setting-action="close">닫기</button><button class="primary-button" data-ai-setting-action="save" ${settingsBusy || !stageDrafts ? 'disabled' : ''}>설정 저장</button></div>`;
  }

  function providerPath(path, provider) {
    return `${path}?provider=${encodeURIComponent(provider)}`;
  }

  /** Revisions let a newer check win over a slower, older one for the same provider. */
  const nextRevision = (provider) => { connectionRevisions[provider] = (connectionRevisions[provider] || 0) + 1; return connectionRevisions[provider]; };

  async function refreshConnection(provider) {
    const sequence = settingsSequence;
    const revision = nextRevision(provider);
    checking[provider] = true;
    connectionErrors[provider] = '';
    renderSettings();
    try {
      const status = await request(providerPath('/api/ai/status', provider));
      if (sequence !== settingsSequence || revision !== connectionRevisions[provider]) return;
      connections[provider] = status;
      if (logins[provider] && accountConnected(status, provider)) {
        delete logins[provider];
        settingsNotice = `${providerNames[provider]}에 연결되었습니다.`;
      }
    } catch (cause) {
      if (sequence !== settingsSequence || revision !== connectionRevisions[provider]) return;
      connectionErrors[provider] = cause.message;
    }
    checking[provider] = false;
    renderSettings();
  }

  async function pollLogin(pending) {
    const { provider } = pending;
    if (checking[provider]) return;
    const sequence = settingsSequence;
    const revision = nextRevision(provider);
    try {
      const status = await request(providerPath('/api/ai/status', provider));
      if (logins[provider] !== pending || sequence !== settingsSequence || revision !== connectionRevisions[provider]) return;
      connections[provider] = status;
      if (accountConnected(status, provider)) {
        delete logins[provider];
        connectionErrors[provider] = '';
        settingsNotice = `${providerNames[provider]}에 연결되었습니다. 단계별 모델에서 선택한 뒤 설정을 저장해 주세요.`;
      } else if (['failed', 'cancelled', 'expired'].includes(status.loginStatus?.state || status.loginStatus)) {
        delete logins[provider];
        connectionErrors[provider] = status.loginStatus?.message || status.message || '로그인을 완료하지 못했어요. 다시 로그인해 주세요.';
      }
    } catch (cause) {
      if (logins[provider] !== pending || revision !== connectionRevisions[provider]) return;
      connectionErrors[provider] = cause.message;
    }
    renderSettings();
  }

  function scheduleLoginPoll() {
    clearTimeout(loginTimer);
    if (!Object.keys(logins).length || !settingsDialog?.open) return;
    loginTimer = setTimeout(async () => {
      await Promise.all(Object.values(logins).map(pollLogin));
      scheduleLoginPoll();
    }, 3000);
  }

  async function cancelLogin(provider) {
    const pending = logins[provider];
    delete logins[provider];
    if (!Object.keys(logins).length) clearTimeout(loginTimer);
    if (!pending?.loginId) return;
    try { await request(providerPath(`/api/ai/login/${encodeURIComponent(pending.loginId)}`, provider), { method: 'DELETE' }); }
    catch { /* Closing the dialog must not block on a disconnected login service. */ }
  }

  async function startLogin(provider) {
    const sequence = settingsSequence;
    checking[provider] = true;
    connectionErrors[provider] = '';
    renderSettings();
    try {
      const result = await request(providerPath('/api/ai/login', provider), { method: 'POST' });
      if (sequence !== settingsSequence || !settingsDialog?.open) {
        if (result.loginId) void request(providerPath(`/api/ai/login/${encodeURIComponent(result.loginId)}`, provider), { method: 'DELETE' }).catch(() => {});
        return;
      }
      logins[provider] = { ...result, provider };
      const url = authUrl(result.authUrl);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      scheduleLoginPoll();
    } catch (cause) { if (sequence === settingsSequence) connectionErrors[provider] = cause.message; }
    if (sequence !== settingsSequence) return;
    checking[provider] = false;
    renderSettings();
  }

  async function loadSettings() {
    const sequence = settingsSequence;
    settingsBusy = true;
    renderSettings();
    try {
      const saved = await request('/api/settings');
      if (sequence !== settingsSequence) return;
      stageDrafts = Object.fromEntries(Object.keys(modelFields).map((stage) => {
        const provider = normalizeProvider(saved.stages?.[stage]?.provider);
        const model = typeof saved.stages?.[stage]?.model === 'string' ? saved.stages[stage].model : null;
        return [stage, { provider, model }];
      }));
      modelMemory = Object.fromEntries(Object.entries(stageDrafts).map(([stage, { provider, model }]) => [stage, model ? { [provider]: model } : {}]));
    } catch (cause) { if (sequence === settingsSequence) settingsError = cause.message; }
    if (sequence !== settingsSequence) return;
    settingsBusy = false;
    renderSettings();
  }

  async function saveSettings() {
    if (settingsBusy || !stageDrafts) return;
    const choices = Object.fromEntries(Object.keys(modelFields).map((stage) => [stage, stageChoice(stage)]));
    for (const [stage, { provider, model }] of Object.entries(choices)) {
      if (providerModels(provider).some((item) => modelId(item) === model)) continue;
      settingsError = accountConnected(connections[provider], provider)
        ? `${modelFields[stage]}: ${providerNames[provider]}의 모델 목록을 다시 확인해 주세요.`
        : `${modelFields[stage]}: ${providerNames[provider]}에 먼저 로그인하거나 다른 AI 연결을 선택해 주세요.`;
      settingsNotice = '';
      renderSettings();
      return;
    }
    // The dialog session counter also guards in-flight connection checks, so saving must not bump it.
    const sequence = settingsSequence;
    settingsBusy = true;
    settingsError = '';
    settingsNotice = '';
    renderSettings();
    try {
      await request('/api/settings', { method: 'PUT', body: JSON.stringify({ stages: choices }) });
      if (sequence !== settingsSequence || !settingsDialog?.open) return;
      stageDrafts = structuredClone(choices);
      settingsNotice = '다음에 만드는 시험부터 적용합니다.';
    } catch (cause) { if (sequence === settingsSequence) settingsError = cause.message; }
    if (sequence !== settingsSequence) return;
    settingsBusy = false;
    renderSettings();
  }

  function settingsAction(action, provider) {
    if (action === 'close') settingsDialog.close();
    else if (action === 'save') void saveSettings();
    else if (!Object.hasOwn(providerNames, provider)) return;
    else if (action === 'refresh') { settingsNotice = ''; void refreshConnection(provider); }
    else if (action === 'login') void startLogin(provider);
    else if (action === 'cancel-login') void cancelLogin(provider).then(renderSettings);
  }

  function changeStage(target) {
    const stage = target.dataset.stageProvider || target.dataset.modelStage;
    if (!stageDrafts || !Object.hasOwn(modelFields, stage)) return;
    if (target.dataset.stageProvider) {
      const provider = normalizeProvider(target.value);
      stageDrafts[stage] = { provider, model: modelMemory[stage]?.[provider] ?? null };
    } else {
      const { provider } = stageChoice(stage);
      stageDrafts[stage] = { provider, model: target.value || null };
      modelMemory[stage] = { ...modelMemory[stage], [provider]: target.value };
    }
    settingsNotice = '';
    renderSettings();
  }

  function showSettings() {
    if (!settingsDialog) {
      settingsDialog = document.createElement('dialog');
      settingsDialog.className = 'ai-settings-dialog';
      settingsDialog.setAttribute('aria-labelledby', 'ai-settings-title');
      document.body.append(settingsDialog);
      settingsDialog.addEventListener('click', (event) => {
        const target = event.target.closest('[data-ai-setting-action]');
        if (target && !target.disabled) settingsAction(target.dataset.aiSettingAction, target.dataset.provider);
      });
      settingsDialog.addEventListener('change', (event) => {
        if (event.target.dataset.stageProvider || event.target.dataset.modelStage) changeStage(event.target);
      });
      settingsDialog.addEventListener('close', () => {
        settingsSequence += 1;
        settingsBusy = false;
        for (const provider of Object.keys(logins)) void cancelLogin(provider);
      });
    }
    if (settingsDialog.open) return;
    settingsSequence += 1;
    settingsNotice = '';
    settingsError = '';
    connections = {};
    checking = {};
    connectionErrors = {};
    stageDrafts = null;
    settingsDialog.showModal();
    void loadSettings();
    for (const provider of providerList) void refreshConnection(provider);
  }

  /** An exam already missing on the server is gone either way, so it leaves the list too. */
  async function deleteExam(id) {
    try { await request(`/api/ai/exams/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    catch (cause) { if (cause.status !== 404) throw cause; }
    exams = exams.filter((exam) => exam.examId !== id);
    if (drafts[id]) { delete drafts[id]; write('ai-drafts', drafts); }
    if (activeExam?.examId === id) { activeExam = null; clearTimeout(summaryTimer); }
    changed();
  }

  /** Called for every <details> toggle; only result explanations of the open exam are remembered. */
  function toggleReview(element) {
    const index = Number(element?.dataset?.reviewIndex);
    if (activeExam?.status !== 'complete' || !Number.isInteger(index) || element.dataset.reviewIndex === '') return;
    if (openReviews.examId !== activeExam.examId) openReviews = { examId: activeExam.examId, indexes: new Set() };
    if (element.open) openReviews.indexes.add(index); else openReviews.indexes.delete(index);
  }

  function handleAction(action, target) {
    if (!action.startsWith('ai-')) return false;
    switch (action) {
      case 'ai-settings': showSettings(); break;
      case 'ai-open': void openExam(target.dataset.id); break;
      case 'ai-refresh': void refreshExams(); break;
      case 'ai-job': activeExam = null; error = job?.status === 'failed' ? (typeof job.error === 'string' ? job.error : '시험을 만들지 못했어요.') : ''; onOpen(); break;
      case 'ai-cancel': void cancelJob(); break;
      case 'ai-poll': void pollJob(); break;
      case 'ai-answer': chooseAnswer(target.dataset.answer ? target.dataset.answer === 'o' : Number(target.dataset.index)); break;
      case 'ai-prev': moveQuestion(-1); break;
      case 'ai-next': moveQuestion(1); break;
      case 'ai-jump': moveQuestion(Number(target.dataset.index) - activeExam.position); break;
      case 'ai-submit': void submit(); break;
      case 'ai-save': void saveProgress(); break;
      case 'ai-summary': void retrySummary(); break;
    }
    return true;
  }

  return {
    start, renderMain, renderHomeNotice, handleAction, deleteExam, toggleReview,
    get exams() { return exams; },
    get isGenerating() { return Boolean(hasJob()); },
    get activeExam() { return activeExam; },
    /** Screen title for the open exam, or for the one being generated. */
    get title() { return activeExam ? aiExamTitle(activeExam) : aiExamTitle({ format: job?.format }); },
    async init() { await refreshExams(); if (hasJob()) scheduleJobPoll(250); },
    keydown(event) {
      if (!activeExam || activeExam.status === 'complete' || loading) return;
      // Physical key codes keep O/X working while a Korean input source is active.
      const ox = isOXExam(activeExam);
      const oxAnswer = ox ? { KeyO: true, KeyX: false }[event.code] : undefined;
      if (oxAnswer !== undefined) { event.preventDefault(); chooseAnswer(oxAnswer); }
      else if (!ox && /^[1-5]$/.test(event.key)) { event.preventDefault(); chooseAnswer(Number(event.key) - 1); }
      else if (ox && event.key === 'Enter' && !event.target.closest?.('button, a, summary') && activeExam.answers[activeExam.position] !== null && activeExam.position + 1 < activeExam.questions.length) { event.preventDefault(); moveQuestion(1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); moveQuestion(-1); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); moveQuestion(1); }
    },
  };
}
