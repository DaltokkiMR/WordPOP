import { collectWords } from './model.js';
import { rangeLevels, rangeLevelLabels, inStudyRange, rangeLabel } from './study-marks.js';
import { renderSlider } from './slider.js';
import { icon } from './icons.js';
import { aiExamSummary } from './ai-ui.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = (value) => Number(value).toLocaleString('ko');

const formatDate = (value) => new Date(value).toLocaleString('ko', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** Every saved activity kind, with the color the feed cards and the mode cards share. */
export const feedKinds = {
  flash: { label: '플래시카드', icon: 'cards', tone: 'peach' },
  quiz: { label: '영영풀이 O/X', icon: 'quiz', tone: 'sage' },
  ai: { label: 'AI 영영풀이 시험', icon: 'spark', tone: 'lavender' },
  'ai-ox': { label: 'AI 영영풀이 O/X', icon: 'quiz', tone: 'sky' },
};

/** Local titles carry their kind ("플래시카드 (모름) · 25과"); the card shows the kind and the mark on their own. */
function splitTitle(title) {
  const match = title.match(/^(?:플래시카드|영영풀이 O\/X)(?:\s*\(([^)]*)\))?\s*·\s*(.+)$/);
  return match ? { title: match[2], tags: match[1] ? [match[1]] : [] } : { title, tags: [] };
}

function flashSummary(record) {
  const { session } = record;
  return { kind: 'flash', id: record.id, deleteKind: 'flash', action: 'open-flash', fullTitle: record.title, ...splitTitle(record.title),
    complete: session.phase === 'complete', statusText: `${session.mastered}/${session.total}개 암기 · 구간 ${session.chunkIndex + 1}/${session.chunks.length}`,
    progress: [session.mastered, session.total], createdAt: record.createdAt };
}

function quizSummary(record) {
  const { session } = record;
  const complete = session.phase === 'complete';
  const correct = session.answers.filter((answer) => answer.correct).length;
  return { kind: 'quiz', id: record.id, deleteKind: 'quiz', action: 'open-exam', fullTitle: record.title, ...splitTitle(record.title), complete,
    statusText: complete ? `${correct}/${session.total} 정답` : `${session.answers.length}/${session.total}문항`,
    progress: [session.answers.length, session.total], createdAt: record.createdAt };
}

/** Unfinished decks, local exams and AI exams in one list, newest first. */
export function feedItems(learning, aiExams = []) {
  return [...learning.flashcards.map(flashSummary), ...learning.exams.map(quizSummary), ...aiExams.map(aiExamSummary)]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function feedCard(item, index) {
  const kind = feedKinds[item.kind];
  const [value, max] = item.progress;
  const date = formatDate(item.createdAt);
  return `<article class="feed-card" data-tone="${kind.tone}" data-enter="feed:${esc(item.id)}" style="--i: ${index}">
    <button class="feed-card-open" data-action="${item.action}" data-id="${esc(item.id)}" title="${esc(item.tooltip || item.fullTitle)} · ${esc(date)}"><span class="feed-card-head"><span class="mode-icon">${icon(kind.icon)}</span><span class="feed-kind">${kind.label}</span><span class="feed-state ${item.complete ? 'complete' : ''}">${item.complete ? '완료' : '진행 중'}</span></span><strong class="feed-title">${esc(item.title)}</strong>${item.tags.length ? `<span class="feed-tags">${item.tags.map((tag) => `<span>${esc(tag)}</span>`).join('')}</span>` : ''}<span class="feed-foot">${item.complete ? '' : `<progress class="feed-progress" max="${max}" value="${value}" aria-label="진행"></progress>`}<span class="feed-meta"><span>${esc(item.statusText)}</span><time datetime="${esc(item.createdAt)}">${esc(date)}</time></span></span></button>
    <button class="feed-delete" data-action="confirm-delete-exam" data-kind="${item.deleteKind}" data-id="${esc(item.id)}" data-title="${esc(item.fullTitle)}" aria-label="${esc(item.fullTitle)} 삭제" title="${item.kind === 'flash' ? '플래시카드' : '시험'} 삭제">${icon('trash')}</button>
  </article>`;
}

function feedView({ learning, aiExams = [], feed }) {
  const items = feedItems(learning, aiExams);
  const counts = Object.fromEntries(Object.keys(feedKinds).map((kind) => [kind, items.filter((item) => item.kind === kind).length]));
  // A kind that has nothing left falls back to the whole feed instead of an empty page.
  const filter = counts[feed.filter] ? feed.filter : 'all';
  const shown = items.filter((item) => (filter === 'all' || item.kind === filter) && (!feed.activeOnly || !item.complete));
  const chip = (active, action, data, tone, label, count) => `<button class="chip ${active ? 'active' : ''}" data-action="${action}"${data}${tone ? ` data-tone="${tone}"` : ''} aria-pressed="${active}">${label}${count === undefined ? '' : `<span>${count}</span>`}</button>`;
  return `<section class="feed-panel" aria-label="만든 학습물">
    ${items.length ? `<div class="feed-filters">${chip(filter === 'all', 'feed-filter', ' data-filter="all"', '', '전체', items.length)}${Object.entries(feedKinds).filter(([kind]) => counts[kind]).map(([kind, meta]) => chip(filter === kind, 'feed-filter', ` data-filter="${kind}"`, meta.tone, meta.label, counts[kind])).join('')}<span class="feed-filters-gap"></span>${chip(feed.activeOnly, 'feed-active', '', '', '진행 중만')}</div>` : ''}
    ${shown.length ? `<div class="feed">${shown.map(feedCard).join('')}</div>` : items.length ? '<div class="feed-empty">이 조건에 맞는 학습물이 없어요.</div>' : `<div class="feed-empty">아직 만든 학습물이 없어요.<p>교재에서 과를 고르고 학습을 만들면 여기에 카드로 모여요.</p><button class="primary-button" data-action="setup">학습 만들기${icon('arrow')}</button></div>`}
  </section>`;
}

function sidebar({ library, selected, expandedBooks, activeBook, learning, brand, aiExams = [], feed }) {
  const count = learning.flashcards.length + learning.exams.length + aiExams.length;
  return `<aside class="sidebar"><a class="brand-link" href="/" aria-label="WordPOP 홈">${brand}</a>
    <button class="feed-pill ${feed.open ? 'active' : ''}" data-action="feed" aria-pressed="${feed.open}">${icon('feed')}<span>학습물 보기</span>${count ? `<span class="feed-pill-count">${count}</span>` : ''}</button>
    <div class="shelf-label books-label"><h2>교재</h2></div>
    <nav class="book-nav" aria-label="교재와 과">${library.books.map((book) => {
      const allSelected = book.units.every((unit) => selected.has(unit.key));
      return `<div class="book-group"><button class="book-button ${book.id === activeBook ? 'active' : ''}" data-action="book" data-id="${esc(book.id)}" aria-expanded="${expandedBooks.has(book.id)}">${icon('folder')}<span>${esc(book.title)}</span>${icon('chevron', expandedBooks.has(book.id) ? 'rotated' : '')}</button>
      ${expandedBooks.has(book.id) ? `<div class="unit-tree" data-enter="units:${esc(book.id)}"><button class="select-book" data-action="select-book" data-id="${esc(book.id)}">${allSelected ? '전체 해제' : '전체 선택'}</button><div class="unit-checkboxes">${book.units.map((unit) => `<label class="tree-unit ${selected.has(unit.key) ? 'selected' : ''}"><input type="checkbox" data-unit="${esc(unit.key)}" aria-label="${esc(book.title)} ${esc(unit.unitTitle)} 선택" ${selected.has(unit.key) ? 'checked' : ''}><span>${esc(unit.unitTitle)}</span><span class="tree-count">${unit.words.length}</span></label>`).join('')}</div></div>` : ''}</div>`;
    }).join('')}</nav>
  </aside>`;
}

export const difficultyStops = Object.freeze([{ value: 'easy', label: '쉬움', tone: 'green' }, { value: 'medium', label: '보통', tone: 'orange' }, { value: 'hard', label: '어려움', tone: 'red' }]);
/** Like the study-level slider, the fill grows toward 우선 학습 and takes the color of the narrowest level in range. */
const scopeTones = { all: 'sage', review: 'green', unknown: 'orange', priority: 'red' };

/** The range slider every study mode shares; each stop counts the words it would include. */
const scopeField = ({ label, mode, value, counts }) => `<div class="slider-field"><span class="slider-field-label">${label}</span>${renderSlider({ name: 'scope', key: mode, label, value, fill: 'start', stops: rangeLevels.map((level) => ({ value: level, label: rangeLevelLabels[level], tone: scopeTones[level], note: number(counts[level]) })) })}</div>`;

/** Range, 모르는 의미만, question count, weak-word focus and difficulty for either AI exam. */
function aiFields({ ox, settings, counts, maxQuestions }) {
  const prefix = ox ? 'ai-ox' : 'ai';
  const [scope, unknownOnly, weak, difficulty, count] = ox
    ? [settings.aiOxScope, settings.aiOxUnknownOnly, settings.aiOxWeak, settings.aiOxDifficulty, settings.aiOxCount || 10]
    : [settings.aiScope, settings.aiUnknownOnly, settings.aiMode === 'weak', settings.aiDifficulty, settings.aiCount || 5];
  return `${scopeField({ label: '출제 범위', mode: settings.mode, value: scope, counts })}
    <div class="field-row"><label class="toggle-label"><span>모르는 의미만</span><input id="${prefix}-unknown-only" type="checkbox" ${unknownOnly ? 'checked' : ''}><span class="toggle-track"></span></label><label class="toggle-label"><span>헷갈리는 단어 위주</span><input id="${ox ? 'ai-ox-weak' : 'ai-weak'}" type="checkbox" ${weak ? 'checked' : ''}><span class="toggle-track"></span></label><label class="number-label" for="${prefix}-count"><span>시험 문항 수</span><span><input id="${prefix}-count" type="number" min="1" max="${Math.max(1, maxQuestions)}" value="${Math.min(count, Math.max(1, maxQuestions))}" inputmode="numeric" ${!maxQuestions ? 'disabled' : ''}>개 · 최대 ${maxQuestions}</span></label></div>
    <div class="slider-field difficulty-field"><span class="slider-field-label">난이도</span>${renderSlider({ name: 'ai-difficulty', key: settings.mode, label: '난이도', value: difficulty, fill: 'start', stops: difficultyStops })}</div>`;
}

function setup({ settings, selected, library, fetching, aiGenerating = false, words: selectedWords = null }) {
  const units = library.books.flatMap((book) => book.units).filter((unit) => selected.has(unit.key));
  // The app passes words with unsaved marks applied, so the counts match what a new deck contains.
  const words = selectedWords ?? collectWords(units);
  // Every mode draws from a range of the selected units: a minimum level, which the AI exams can narrow to 모르는 의미만.
  const aiMode = settings.mode === 'ai' || settings.mode === 'ai-ox';
  const range = {
    flash: { level: settings.flashScope }, quiz: { level: settings.quizScope },
    ai: { level: settings.aiScope, unknownOnly: settings.aiUnknownOnly }, 'ai-ox': { level: settings.aiOxScope, unknownOnly: settings.aiOxUnknownOnly },
  }[settings.mode];
  const counts = Object.fromEntries(rangeLevels.map((level) => [level, words.filter((word) => inStudyRange(word, { ...range, level })).length]));
  const scopedCount = counts[range.level];
  const narrowed = range.level !== 'all' || range.unknownOnly === true;
  const scopedEmpty = words.length > 0 && !scopedCount;
  const noun = settings.mode === 'flash' ? '카드' : '단어';
  const filterHint = [
    narrowed && scopedEmpty ? `선택한 과에 ‘${rangeLabel(range)}’에 해당하는 ${noun}가 없습니다.` : '',
    settings.mode === 'ai-ox' && settings.aiOxWeak ? '모르는 뜻과 노트에 적은 혼동을 먼저 확인하는 문제를 내요.' : '',
    settings.mode === 'ai' && settings.aiMode === 'weak' ? '표시·노트·학습 기록을 참고해 헷갈리는 단어를 먼저 출제해요.' : '',
  ].filter(Boolean).join(' ');
  const maxAIQuestions = settings.mode === 'ai' ? Math.floor(scopedCount / 5) : 0;
  const maxOXQuestions = settings.mode === 'ai-ox' ? scopedCount : 0;
  return `<section class="setup-panel" aria-label="학습 설정">
    <h2>학습 방법</h2>
    <div class="mode-options" role="group" aria-label="학습 방법">
      <button data-action="mode" data-mode="flash" class="mode-card ${settings.mode === 'flash' ? 'active' : ''}" aria-pressed="${settings.mode === 'flash'}"><span class="mode-icon peach">${icon('cards')}</span><strong>플래시카드</strong><span class="radio-dot"></span></button>
      <button data-action="mode" data-mode="quiz" class="mode-card ${settings.mode === 'quiz' ? 'active' : ''}" aria-pressed="${settings.mode === 'quiz'}"><span class="mode-icon sage">${icon('quiz')}</span><strong>영영풀이 O / X</strong><span class="radio-dot"></span></button>
      <button data-action="mode" data-mode="ai" class="mode-card ${settings.mode === 'ai' ? 'active' : ''}" aria-pressed="${settings.mode === 'ai'}"><span class="mode-icon lavender">${icon('spark')}</span><strong>AI 영영풀이 시험</strong><span class="radio-dot"></span></button>
      <button data-action="mode" data-mode="ai-ox" class="mode-card ${settings.mode === 'ai-ox' ? 'active' : ''}" aria-pressed="${settings.mode === 'ai-ox'}"><span class="mode-icon sky">${icon('quiz')}</span><strong>AI 영영풀이 O / X</strong><span class="radio-dot"></span></button>
    </div>
    <div class="setting-fields" data-enter="fields:${settings.mode}">${settings.mode === 'flash' ? `${scopeField({ label: '카드 범위', mode: 'flash', value: range.level, counts })}<div class="field-row"><label class="number-label" for="chunk-size"><span>한 구간의 단어 수</span><span><input id="chunk-size" type="number" min="1" max="${Math.max(scopedCount, settings.chunkSize, 1)}" value="${settings.chunkSize}" inputmode="numeric">개</span></label><label class="toggle-label"><span>단어 순서 섞기</span><input id="shuffle" type="checkbox" ${settings.shuffle ? 'checked' : ''}><span class="toggle-track"></span></label></div>` : aiMode ? aiFields({ ox: settings.mode === 'ai-ox', settings, counts, maxQuestions: settings.mode === 'ai' ? maxAIQuestions : maxOXQuestions }) : `${scopeField({ label: '출제 범위', mode: 'quiz', value: range.level, counts })}<div class="field-row"><label class="number-label" for="question-count"><span>시험 문항 수</span><span><input id="question-count" type="number" min="1" max="${Math.max(scopedCount, settings.questionCount, 1)}" value="${settings.questionCount}" inputmode="numeric">개</span></label><button class="inline-link" data-action="all-questions" ${!scopedCount ? 'disabled' : ''}>${narrowed ? '범위의' : '선택한'} 단어 모두 출제</button></div>`}</div>
    <div class="selection-summary"><div><span>선택한 범위</span><strong>${units.length}개 과 · ${number(words.length)}개 단어${narrowed ? ` 중 ${esc(rangeLabel(range))} ${number(scopedCount)}개` : ''}</strong></div>${units.length ? `<div class="selection-tags">${units.map((unit) => `<span title="${esc(unit.bookTitle)}">${esc(unit.unitTitle)}</span>`).join('')}</div>` : '<p>교재에서 과를 선택해 주세요.</p>'}</div>
    ${settings.mode === 'ai' && scopedCount > 0 && !maxAIQuestions ? `<p class="ai-minimum">5지선다 AI 시험에는 ${narrowed ? '출제 범위에 ' : ''}단어가 5개 이상 필요합니다.</p>` : ''}${filterHint ? `<p class="filter-hint">${filterHint}</p>` : ''}<button class="primary-button start-button" data-action="start" ${!words.length || fetching || scopedEmpty || aiMode && aiGenerating || settings.mode === 'ai' && !maxAIQuestions ? 'disabled' : ''}>${settings.mode === 'flash' ? '플래시카드 시작' : aiMode && aiGenerating ? 'AI 시험 생성 중' : settings.mode === 'ai' ? 'AI 시험 만들기' : settings.mode === 'ai-ox' ? 'AI O/X 시험 만들기' : '시험 만들기'}${icon('arrow')}</button>
  </section>`;
}

export function renderHomeView(state) {
  const { library, fetching, loadError, storageWarning, feed } = state;
  return `<div class="app-shell">${sidebar(state)}<div class="workspace"><header class="topbar"><h1>${feed.open ? '만든 학습물' : '학습 만들기'}</h1><div class="topbar-actions">${feed.open ? `<button class="text-button" data-action="setup">${icon('back')}<span>학습 만들기</span></button>` : ''}<button class="text-button" data-action="ai-settings">${icon('spark')}<span>AI 설정</span></button><button class="text-button" data-action="help" aria-label="사용 방법">${icon('help')}<span>사용 방법</span></button><button class="text-button" data-action="reload" aria-label="자료 새로고침" ${fetching ? 'disabled' : ''}>${icon('refresh', fetching ? 'spinning' : '')}<span>${fetching ? '불러오는 중' : '자료 새로고침'}</span></button></div></header><main class="home-main">
    ${loadError ? `<div class="notice error" role="alert">${esc(loadError)} <button data-action="reload" class="inline-link">다시 시도</button></div>` : ''}
    ${library.warnings.length ? `<details class="notice warning"><summary>${library.warnings.length}개 자료를 확인해 주세요</summary><ul>${library.warnings.map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul></details>` : ''}
    ${storageWarning ? '<div class="notice warning">브라우저 저장 공간을 사용할 수 없어 진행 내용을 저장하지 못했습니다.</div>' : ''}
    ${state.extraNotice || ''}${state.aiNotice || ''}
    ${feed.open ? feedView(state) : library.books.length ? setup(state) : '<div class="empty-state">단어장이 없습니다.<p>word_list 폴더에 교재별 JSON 파일을 넣고 자료 새로고침을 눌러 주세요.</p></div>'}
  </main></div></div>`;
}
