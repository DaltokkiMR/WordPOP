import { mkdir, readFile, readdir, lstat, realpath, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { loadLibrary } from './library.mjs';
import { wordKey, validSession } from '../public/js/model.js';
import { meaningKey, getStudyLevel, getUnknownMeaningKeys, isStudyLevel, withMeaningFloor, isUnknownMeaningKeys, isStudyNote, STUDY_NOTE_LIMIT, rangeLabel } from '../public/js/study-marks.js';

const MODEL_STAGES = ['collect', 'select', 'generate', 'verify'];
const AI_PROVIDERS = ['codex', 'copilot', 'claude'];
const PROVIDER_LABELS = { codex: 'ChatGPT (Codex)', copilot: 'GitHub Copilot', claude: 'Claude (Claude Code)' };
const EXAM_ID = /^\d{4}-\d{2}-\d{2}-\d{3,}$/;
const clone = (value) => structuredClone(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const issue = (message, status = 400) => Object.assign(new Error(message), { status, statusCode: status });
const segment = (value) => typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !/[\\/\0]/.test(value);
const text = (value) => String(value ?? '').replaceAll('\r', '').replaceAll('\n', ' ').replaceAll('|', '\\|');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const validModel = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
/** Exams without a format are the original five-option tests. */
export const examFormat = (exam) => exam?.options?.format === 'ox' ? 'ox' : 'choice';
/** Every word a question asks about: five options, or the single O/X word. */
export const questionWords = (question) => Array.isArray(question.options) ? question.options.map((option) => option.word) : [question.word];

/** Each stage names its own provider and model; a null model means that provider's default. */
function normalizeSettings(value) {
  const settings = object(value) ? value : {};
  // Older settings chose one provider for every stage and kept models per provider.
  const legacyProvider = AI_PROVIDERS.includes(settings.provider) ? settings.provider : 'codex';
  const legacyModels = object(settings.providerModels?.[legacyProvider]) ? settings.providerModels[legacyProvider] : {};
  const stages = Object.fromEntries(MODEL_STAGES.map((stage) => {
    const saved = settings.stages?.[stage];
    if (object(saved) && AI_PROVIDERS.includes(saved.provider)) return [stage, { provider: saved.provider, model: validModel(saved.model) ? saved.model : null }];
    const model = Object.hasOwn(legacyModels, stage) ? legacyModels[stage] : settings.models?.[stage];
    return [stage, { provider: legacyProvider, model: validModel(model) ? model : null }];
  }));
  return { stages };
}

const validStageSetting = (value) => object(value) && Object.keys(value).every((key) => ['provider', 'model'].includes(key)) &&
  AI_PROVIDERS.includes(value.provider) && (value.model === null || value.model === undefined || validModel(value.model));

/** Exams from before per-stage providers recorded one provider for all four stages. */
function examProviders(exam) {
  if (exam.providers === undefined) {
    const provider = exam.provider === undefined ? 'codex' : exam.provider;
    return AI_PROVIDERS.includes(provider) ? Object.fromEntries(MODEL_STAGES.map((stage) => [stage, provider])) : null;
  }
  if (!object(exam.providers) || Object.keys(exam.providers).length !== MODEL_STAGES.length || !MODEL_STAGES.every((stage) => AI_PROVIDERS.includes(exam.providers[stage]))) return null;
  return Object.fromEntries(MODEL_STAGES.map((stage) => [stage, exam.providers[stage]]));
}

/** Writes are serialized per store; same-directory rename keeps each file complete. */
export class RecordStore {
  constructor({ libraryRoot, recordsRoot, settingsPath = path.join(recordsRoot, 'settings.json') }) {
    this.libraryRoot = path.resolve(libraryRoot);
    this.recordsRoot = path.resolve(recordsRoot);
    this.settingsPath = path.resolve(settingsPath);
    this.pending = Promise.resolve();
  }

  write(operation) {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }

  async safeFile(filename, createParent = false) {
    const absolute = path.resolve(filename);
    // Configured roots are trusted, but nested directories and files must not be symlinks.
    const root = [this.libraryRoot, this.recordsRoot].find((candidate) => absolute.startsWith(`${candidate}${path.sep}`));
    if (!root && absolute !== this.settingsPath) throw issue('허용되지 않은 저장 경로입니다.');
    const base = root ?? path.dirname(this.settingsPath);
    if (createParent) await mkdir(base, { recursive: true });
    const baseInfo = await lstat(base);
    if (baseInfo.isSymbolicLink() || !baseInfo.isDirectory()) throw issue('저장 폴더는 실제 폴더여야 합니다.');
    const canonicalBase = await realpath(base);
    const parts = path.relative(base, absolute).split(path.sep);
    let current = canonicalBase;
    for (const [index, part] of parts.entries()) {
      if (!segment(part)) throw issue('올바르지 않은 저장 경로입니다.');
      current = path.join(current, part);
      const last = index === parts.length - 1;
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!last && createParent) { await mkdir(current); info = await lstat(current); }
        else if (!last) throw error;
      }
      if (info?.isSymbolicLink() || (info && (last ? !info.isFile() : !info.isDirectory()))) throw issue('연결 파일이나 올바르지 않은 저장 경로는 사용할 수 없습니다.');
    }
    return current;
  }

  async read(filename, fallback) {
    try { return JSON.parse(await readFile(await this.safeFile(filename), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' && arguments.length > 1) return clone(fallback); throw error; }
  }

  async atomic(filename, content) {
    const target = await this.safeFile(filename, true);
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await rename(temporary, target);
    } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async units() { return (await loadLibrary(this.libraryRoot)).books.flatMap((book) => book.units); }

  resolveSources(refs, units, key) {
    if (!Array.isArray(refs) || !refs.length) throw issue('단어의 원본 출처를 확인할 수 없습니다.');
    const found = new Map();
    for (const ref of refs) {
      const unit = units.find((item) => item.key === ref?.unitKey);
      const word = unit?.words.find((item) => item.id === ref.wordId);
      if (!word || ref.bookId !== unit.bookId || ref.unitId !== unit.unitId || (key && wordKey(word.word) !== key)) throw issue('선택한 단어의 원본이 변경되었거나 출처가 올바르지 않습니다.');
      if (!segment(unit.bookId) || !segment(unit.unitId)) throw issue('교재와 과의 저장 경로가 올바르지 않습니다.');
      found.set(`${unit.key}\0${word.id}`, { unit, word });
    }
    return [...found.values()];
  }

  setWordMark(input) {
    return this.write(async () => {
      if (!object(input)) throw issue('단어 표시가 올바르지 않습니다.');
      const { sourceRefs, mark } = input;
      const canonical = Object.hasOwn(input, 'studyLevel') || Object.hasOwn(input, 'unknownMeaningKeys');
      // studyNote is optional so older queued saves leave an existing note untouched.
      const allowed = canonical ? ['sourceRefs', 'studyLevel', 'unknownMeaningKeys', 'studyNote'] : ['sourceRefs', 'mark'];
      const hasNote = canonical && Object.hasOwn(input, 'studyNote');
      if (Object.keys(input).some((key) => !allowed.includes(key)) ||
        (canonical ? !isStudyLevel(input.studyLevel) || !Array.isArray(input.unknownMeaningKeys) : mark !== null && !['unknown', 'unsure', 'review'].includes(mark))) {
        throw issue('단어 표시가 올바르지 않습니다.');
      }
      if (hasNote && !isStudyNote(input.studyNote)) throw issue(`노트는 ${STUDY_NOTE_LIMIT}자 이하로 작성해 주세요.`);
      const note = hasNote ? input.studyNote.trim() : '';
      const sources = this.resolveSources(sourceRefs, await this.units());
      if (new Set(sources.map(({ word }) => wordKey(word.word))).size !== 1) throw issue('동일한 단어의 출처만 함께 수정할 수 있습니다.');
      const meanings = sources.flatMap(({ word }) => word.meanings);
      if (canonical && !isUnknownMeaningKeys(input.unknownMeaningKeys, meanings)) throw issue('선택한 모르는 뜻이 원본 단어의 뜻과 일치하지 않습니다.');
      const selectedKeys = canonical ? getUnknownMeaningKeys({ ...input, meanings }) :
        [...new Set(sources.flatMap(({ word }) => getUnknownMeaningKeys(word)))];
      // A word with an unknown meaning stays at 복습 필요 or above.
      const level = withMeaningFloor(canonical ? input.studyLevel : getStudyLevel({ studyMark: mark }), selectedKeys.length);
      const changed = new Map();
      for (const { unit, word } of sources) {
        let raw = changed.get(unit.key);
        if (!raw) { raw = await this.read(path.join(this.libraryRoot, unit.key)); changed.set(unit.key, raw); }
        const original = raw.words.find((item) => item.id === word.id);
        original.studyLevel = level;
        original.unknownMeaningKeys = canonical ? selectedKeys.filter((key) => word.meanings.some((meaning) => meaningKey(meaning) === key)) : getUnknownMeaningKeys(word);
        delete original.studyMark;
        delete original.studyMarks;
        if (hasNote) { if (note) original.studyNote = note; else delete original.studyNote; }
      }
      for (const [key, raw] of changed) await this.atomic(path.join(this.libraryRoot, key), json(raw));
      return { studyLevel: level, unknownMeaningKeys: selectedKeys, ...(hasNote ? { studyNote: note } : {}), ...(!canonical ? { mark: level === 'off' ? null : level } : {}) };
    });
  }

  flashPath(unit) {
    if (!segment(unit.bookId) || !segment(unit.unitId)) throw issue('교재와 과의 저장 경로가 올바르지 않습니다.');
    return path.join(this.recordsRoot, 'flashcard', unit.bookId, `unit-${unit.unitId}.json`);
  }

  saveFlash(session) {
    return this.write(async () => {
      if (!validSession(session) || session.type !== 'flash' || session.phase !== 'complete') throw issue('완료한 플래시카드만 기록할 수 있습니다.');
      const units = await this.units();
      const words = session.chunks.flat();
      const sessionId = typeof session.sessionId === 'string' && session.sessionId ? session.sessionId : `legacy-${createHash('sha256').update(JSON.stringify(session)).digest('hex')}`;
      const completedAt = validDate(session.completedAt) ? new Date(session.completedAt).toISOString() : new Date().toISOString();
      const startedAt = validDate(session.startedAt) ? new Date(session.startedAt).toISOString() : null;
      const files = new Map();
      for (const word of words) {
        // Legacy snapshots retain exact human-readable origins but lack sourceRefs.
        const refs = word.sourceRefs?.length ? word.sourceRefs : units.filter((unit) => word.origins?.includes(`${unit.bookTitle} · ${unit.unitTitle}`)).flatMap((unit) =>
          unit.words.filter((item) => wordKey(item.word) === word.key).map((item) => ({ unitKey: unit.key, bookId: unit.bookId, unitId: unit.unitId, wordId: item.id })));
        for (const source of this.resolveSources(refs, units, word.key)) {
          const { unit, word: original } = source;
          const filename = this.flashPath(unit);
          let record = files.get(filename);
          if (!record) {
            record = await this.read(filename, { schemaVersion: 1, bookId: unit.bookId, bookTitle: unit.bookTitle, unitId: unit.unitId, unitTitle: unit.unitTitle, words: [] });
            if (!Array.isArray(record.words)) throw issue('기존 플래시카드 기록의 형식이 올바르지 않습니다.', 500);
            files.set(filename, record);
          }
          const previous = record.words.find((entry) => entry.wordId === original.id);
          if (previous?.sessionId === sessionId || (validDate(previous?.completedAt) && Date.parse(previous.completedAt) > Date.parse(completedAt))) continue;
          const retryCount = Number.isSafeInteger(session.retryCounts?.[word.key]) && session.retryCounts[word.key] >= 0 ? session.retryCounts[word.key] : null;
          const entry = { wordId: original.id, key: word.key, word: original.word, retryCount, sessionId, startedAt, completedAt };
          if (previous) record.words[record.words.indexOf(previous)] = entry;
          else record.words.push(entry);
          record.updatedAt = record.updatedAt && Date.parse(record.updatedAt) > Date.parse(completedAt) ? record.updatedAt : completedAt;
        }
      }
      for (const [filename, record] of files) await this.atomic(filename, json(record));
      return { saved: true };
    });
  }

  async readFlashRecords(words) {
    await this.pending;
    const units = await this.units();
    const files = new Map();
    const output = {};
    for (const word of words) {
      const sources = [];
      for (const { unit, word: original } of this.resolveSources(word.sourceRefs, units, word.key)) {
        const filename = this.flashPath(unit);
        if (!files.has(filename)) files.set(filename, await this.read(filename, { words: [] }));
        const entry = files.get(filename).words?.find((item) => item.wordId === original.id);
        if (entry) sources.push({ ...entry, bookId: unit.bookId, unitId: unit.unitId });
      }
      const counts = sources.map((item) => item.retryCount).filter((value) => Number.isSafeInteger(value) && value >= 0);
      Object.defineProperty(output, word.key, { enumerable: true, configurable: true, writable: true,
        value: { retryCount: counts.length ? Math.max(...counts) : null,
          completedAt: sources.map((item) => item.completedAt).filter(validDate).sort().at(-1) ?? null, sources } });
    }
    return output;
  }

  async getSettings() {
    await this.pending;
    return this.readSettings();
  }

  async readSettings() {
    return normalizeSettings(await this.read(this.settingsPath, {}));
  }

  saveSettings(input) {
    return this.write(async () => {
      const stages = input?.stages;
      if (!object(input) || Object.keys(input).some((key) => key !== 'stages') || !object(stages) || !Object.keys(stages).length ||
        Object.entries(stages).some(([stage, value]) => !MODEL_STAGES.includes(stage) || !validStageSetting(value))) throw issue('단계별 AI 연결과 모델 설정이 올바르지 않습니다.');
      const settings = await this.readSettings();
      for (const [stage, { provider, model }] of Object.entries(stages)) settings.stages[stage] = { provider, model: model ?? null };
      await this.atomic(this.settingsPath, json(settings));
      return settings;
    });
  }

  examPath(id, extension = 'json') {
    if (typeof id !== 'string' || !EXAM_ID.test(id)) throw issue('시험 번호가 올바르지 않습니다.');
    return path.join(this.recordsRoot, 'ai-test', `${id}.${extension}`);
  }

  async examFiles() {
    try { return (await readdir(path.join(this.recordsRoot, 'ai-test'), { withFileTypes: true })).filter((file) => file.isFile() && file.name.endsWith('.json') && EXAM_ID.test(file.name.slice(0, -5))).map((file) => file.name.slice(0, -5)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  createExam(data) {
    return this.write(async () => {
      const providers = examProviders(data);
      if (!providers) throw issue('시험의 AI 연결 서비스가 올바르지 않습니다.');
      validateQuestions(data.questions, examFormat(data));
      const units = await this.units();
      if (!Array.isArray(data.selectedScope) || !data.selectedScope.length) throw issue('시험의 교재와 과가 필요합니다.');
      const selectedScope = data.selectedScope.map((book) => {
        if (!Array.isArray(book.unitIds) || !book.unitIds.length) throw issue('시험 범위의 과를 확인할 수 없습니다.');
        const selected = book.unitIds.map((id) => units.find((unit) => unit.bookId === book.bookId && unit.unitId === String(id)));
        if (selected.some((unit) => !unit)) throw issue('시험 범위의 원본을 확인할 수 없습니다.');
        return { bookId: book.bookId, bookTitle: selected[0].bookTitle, unitIds: [...new Set(selected.map((unit) => unit.unitId))],
          units: selected.map((unit) => ({ unitId: unit.unitId, unitTitle: unit.unitTitle, unitKey: unit.key })) };
      });
      const selectedKeys = new Set(selectedScope.flatMap((book) => book.units.map((unit) => unit.unitKey)));
      for (const question of data.questions) for (const word of questionWords(question)) {
        const sources = this.resolveSources(word.sourceRefs, units, word.key);
        if (sources.some(({ unit }) => !selectedKeys.has(unit.key))) throw issue('선택 범위 밖의 단어가 시험에 포함되어 있습니다.');
      }
      const createdAt = new Date().toISOString();
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(createdAt));
      const date = ['year', 'month', 'day'].map((name) => parts.find((part) => part.type === name).value).join('-');
      const numbers = (await this.examFiles()).filter((id) => id.startsWith(`${date}-`)).map((id) => Number(id.slice(11)));
      const examId = `${date}-${String(Math.max(0, ...numbers) + 1).padStart(3, '0')}`;
      const exam = { ...clone(data), schemaVersion: 1, type: 'ai-test', providers, examId, selectedScope, createdAt, updatedAt: createdAt,
        status: 'studying', answers: data.questions.map(() => null), position: 0, summary: null, summaryStatus: 'pending' };
      delete exam.provider;
      delete exam.results;
      delete exam.score;
      delete exam.completedAt;
      await this.atomic(this.examPath(examId), json(exam));
      return clone(exam);
    });
  }

  async readExam(id) {
    const exam = await this.read(this.examPath(id), null);
    if (!exam) throw issue('시험을 찾을 수 없습니다.', 404);
    if (exam.examId !== id || !Array.isArray(exam.questions)) throw issue('시험 파일의 형식이 올바르지 않습니다.', 500);
    const providers = examProviders(exam);
    if (!providers) throw issue('시험의 AI 연결 서비스 기록이 올바르지 않습니다.', 500);
    // Reads never rewrite the file; the next save stores the per-stage form.
    exam.providers = providers;
    delete exam.provider;
    return exam;
  }

  async getExam(id) { await this.pending; return this.readExam(id); }

  async listExams() {
    await this.pending;
    const exams = [];
    for (const id of await this.examFiles()) exams.push(await this.readExam(id));
    return exams.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.examId.localeCompare(a.examId, undefined, { numeric: true }));
  }

  saveProgress(id, { answers, position }) {
    return this.write(async () => {
      const exam = await this.readExam(id);
      if (exam.status === 'complete') return exam;
      validateAnswers(answers, exam.questions.length, true, examFormat(exam));
      if (!Number.isSafeInteger(position) || position < 0 || position >= exam.questions.length) throw issue('현재 문항 위치가 올바르지 않습니다.');
      exam.answers = [...answers];
      exam.position = position;
      exam.updatedAt = new Date().toISOString();
      await this.atomic(this.examPath(id), json(exam));
      return exam;
    });
  }

  submitExam(id, { answers }) {
    return this.write(async () => {
      const exam = await this.readExam(id);
      if (exam.status === 'complete') { await this.writeMarkdown(exam); return exam; }
      const format = examFormat(exam);
      validateAnswers(answers, exam.questions.length, false, format);
      exam.answers = [...answers];
      exam.results = exam.questions.map((question, index) => format === 'ox'
        ? { questionId: question.id, answer: answers[index], expected: question.isCorrect, correct: answers[index] === question.isCorrect, difficulty: question.difficulty, wordKeys: [question.word.key] }
        : { questionId: question.id, answer: answers[index], answerIndex: question.answerIndex, correct: answers[index] === question.answerIndex, difficulty: question.difficulty, wordKeys: question.options.map((option) => option.word.key) });
      exam.score = { correct: exam.results.filter((result) => result.correct).length, total: exam.questions.length };
      exam.status = 'complete';
      exam.completedAt = new Date().toISOString();
      exam.updatedAt = exam.completedAt;
      exam.summaryStatus = 'pending';
      await this.atomic(this.examPath(id), json(exam));
      await this.writeMarkdown(exam);
      return exam;
    });
  }

  saveSummary(id, summary) {
    return this.write(async () => {
      const exam = await this.readExam(id);
      if (exam.status !== 'complete') throw issue('완료한 시험만 요약할 수 있습니다.');
      if (!(typeof summary === 'string' && summary.trim()) && !object(summary)) throw issue('시험 요약이 비어 있습니다.');
      exam.summary = clone(summary);
      exam.summaryStatus = 'complete';
      delete exam.summaryError;
      exam.updatedAt = new Date().toISOString();
      await this.atomic(this.examPath(id), json(exam));
      await this.writeMarkdown(exam);
      return exam;
    });
  }

  markSummaryFailed(id, error) {
    return this.write(async () => {
      const exam = await this.readExam(id);
      if (exam.status !== 'complete') throw issue('완료한 시험만 요약할 수 있습니다.');
      // The JSON may have committed just before a failed Markdown write.
      if (exam.summaryStatus === 'complete') { await this.writeMarkdown(exam); return exam; }
      exam.summaryStatus = 'failed';
      exam.summaryError = typeof error === 'string' ? error.slice(0, 500) : 'AI 요약을 완료하지 못했습니다. 다시 시도해 주세요.';
      exam.updatedAt = new Date().toISOString();
      await this.atomic(this.examPath(id), json(exam));
      await this.writeMarkdown(exam);
      return exam;
    });
  }

  /** Remove the JSON last so an interrupted delete can be retried from the listed exam. */
  deleteExam(id) {
    return this.write(async () => {
      await this.readExam(id);
      try { await unlink(await this.safeFile(this.examPath(id, 'md'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await unlink(await this.safeFile(this.examPath(id)));
      return { examId: id, deleted: true };
    });
  }

  async writeMarkdown(exam) { await this.atomic(this.examPath(exam.examId, 'md'), examMarkdown(exam)); }

  /** JSON is canonical; repair an interrupted pair without another AI request. */
  repairExamMarkdown(id) {
    return this.write(async () => {
      const exam = await this.readExam(id);
      if (exam.status !== 'complete') return exam;
      const expected = examMarkdown(exam);
      let existing = null;
      try { existing = await readFile(await this.safeFile(this.examPath(id, 'md')), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing !== expected) await this.atomic(this.examPath(id, 'md'), expected);
      return exam;
    });
  }

  async relatedHistory(units, words, limit = 20) {
    const unitKeys = new Set(units.map((unit) => unit.key ?? unit.unitKey));
    const wordKeys = new Set(words.map((word) => word.key ?? wordKey(word.word)));
    const exams = (await this.listExams()).filter((exam) => exam.status === 'complete' &&
      (exam.selectedScope.some((book) => book.units?.some((unit) => unitKeys.has(unit.unitKey)) || units.some((unit) => unit.bookId === book.bookId && book.unitIds.includes(unit.unitId))) ||
       exam.questions.some((question) => questionWords(question).some((word) => wordKeys.has(word.key))))).sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, Math.min(20, Math.max(0, limit)));
    const history = [];
    for (const saved of exams) {
      const exam = await this.repairExamMarkdown(saved.examId);
      const markdown = examMarkdown(exam);
      const format = examFormat(exam);
      history.push({ examId: exam.examId, format, providers: exam.providers, selectedScope: exam.selectedScope,
        results: exam.results.map((result, index) => {
          const question = exam.questions[index];
          return format === 'ox'
            ? { ...result, format, word: question.word.word, key: question.word.key, meaningIndex: question.meaningIndex, definition: question.definition, isCorrect: question.isCorrect,
              confusionTarget: question.confusionTarget ?? null, intent: question.intent, explanation: question.explanation, sourceRefs: question.word.sourceRefs }
            : { ...result, format,
              options: question.options.map((option) => ({ word: option.word.word, key: option.word.key, meaningIndex: option.meaningIndex, definition: option.definition, isCorrect: option.isCorrect, explanation: option.explanation, sourceRefs: option.word.sourceRefs })),
              kind: question.kind, intent: question.intent, explanation: question.explanation };
        }),
        summary: exam.summary, markdown });
    }
    return history;
  }
}

/** Five-option answers are option indexes; O/X answers are true for O and false for X. */
function validateAnswers(answers, count, allowEmpty, format = 'choice') {
  const valid = format === 'ox' ? (answer) => typeof answer === 'boolean' : (answer) => Number.isSafeInteger(answer) && answer >= 0 && answer < 5;
  if (!Array.isArray(answers) || answers.length !== count || !answers.every((answer) => (allowEmpty && answer === null) || valid(answer))) throw issue(allowEmpty ? '답안 형식이 올바르지 않습니다.' : '모든 문항에 답한 뒤 제출해 주세요.');
}

function validateQuestions(questions, format = 'choice') {
  if (!Array.isArray(questions) || !questions.length) throw issue('시험 문항이 비어 있습니다.');
  const seen = new Set();
  const ids = new Set();
  const checkWord = (word, meaningIndex) => {
    if (!word || typeof word.word !== 'string' || word.key !== wordKey(word.word) || !Array.isArray(word.meanings) || !Number.isSafeInteger(meaningIndex) || !word.meanings[meaningIndex] || seen.has(word.key)) throw issue('중복되거나 올바르지 않은 출제 단어입니다.');
    seen.add(word.key);
  };
  if (format === 'ox') {
    for (const question of questions) {
      if (!question || typeof question.id !== 'string' || !question.id || ids.has(question.id) || !['easy', 'medium', 'hard'].includes(question.difficulty) || typeof question.isCorrect !== 'boolean' || typeof question.definition !== 'string' || !question.definition.trim() || Object.hasOwn(question, 'options')) throw issue('시험 문항 형식이 올바르지 않습니다.');
      ids.add(question.id);
      checkWord(question.word, question.meaningIndex);
    }
    return;
  }
  for (const question of questions) {
    if (!question || typeof question.id !== 'string' || !question.id || ids.has(question.id) || !['correct', 'incorrect'].includes(question.kind) || !['easy', 'medium', 'hard'].includes(question.difficulty) || !Number.isSafeInteger(question.answerIndex) || question.answerIndex < 0 || question.answerIndex >= 5 || !Array.isArray(question.options) || question.options.length !== 5) throw issue('시험 문항 형식이 올바르지 않습니다.');
    ids.add(question.id);
    const targets = question.options.filter((option) => option.isCorrect === (question.kind === 'correct'));
    if (targets.length !== 1 || question.options[question.answerIndex] !== targets[0]) throw issue('정답이 하나인 문항만 저장할 수 있습니다.');
    for (const option of question.options) {
      if (typeof option.definition !== 'string' || !option.definition.trim() || typeof option.isCorrect !== 'boolean') throw issue('중복되거나 올바르지 않은 출제 단어입니다.');
      checkWord(option.word, option.meaningIndex);
    }
  }
}

export function examMarkdown(exam) {
  const difficulty = { easy: '쉬움', medium: '보통', hard: '어려움' };
  const ox = examFormat(exam) === 'ox';
  const scope = exam.selectedScope.map((book) => `${text(book.bookTitle)} · ${book.units?.map((unit) => text(unit.unitTitle)).join(' · ') || book.unitIds.map((id) => `${text(id)}과`).join(' · ')}`).join('; ');
  const mode = exam.options?.mode === 'weak' ? '헷갈리는 단어 위주' : '일반';
  const lines = [`# ${ox ? 'AI 영영풀이 O/X 시험' : 'AI 영영풀이 시험'} ${exam.examId}`, '', `- 시험 범위: ${scope}`,
    // Five-option exams made before scopes existed used every selected word.
    `- 출제 범위: ${rangeLabel(exam.options)}`, `- 생성: ${exam.createdAt}`, `- 완료: ${exam.completedAt ?? '미완료'}`,
    `- 점수: ${exam.score?.correct ?? 0}/${exam.questions.length}`, `- 출제 모드: ${mode}`, `- 선택 난이도: ${difficulty[exam.options?.difficulty] ?? ''}`,
    `- 기록 JSON: ${exam.examId}.json`, '', '## 문항별 결과', ''];
  const sources = (word) => word.sourceRefs.map((ref) => `${text(ref.bookTitle)} ${text(ref.unitTitle)}`).join(', ');
  const oxLabel = (value) => typeof value === 'boolean' ? (value ? 'O' : 'X') : '미응답';
  for (const [index, question] of exam.questions.entries()) {
    const result = exam.results?.[index];
    lines.push(`### ${index + 1}번 — ${result?.correct ? '정답' : '오답'} · ${difficulty[question.difficulty]}`, '');
    if (ox) {
      const sense = question.word.meanings[question.meaningIndex];
      lines.push(`**${text(question.word.word)}** — ${text(question.definition)}`, '', `- 내 답: ${oxLabel(result?.answer)} / 정답: ${oxLabel(question.isCorrect)}`,
        `- 출제 의도: ${text(question.intent)}`, ...(question.confusionTarget ? [`- 확인한 혼동: ${text(question.confusionTarget)}`] : []),
        `- 원래 뜻: ${text(sense.ko)} / ${text(sense.en)}`, `- 출처: ${sources(question.word)}`, '', `해설: ${text(question.explanation)}`, '');
      continue;
    }
    lines.push(question.kind === 'correct' ? '옳은 것을 고르세요.' : '옳지 않은 것을 고르세요.', '',
      `- 내 답: ${result ? result.answer + 1 : '미응답'}번 / 정답: ${question.answerIndex + 1}번`, `- 출제 의도: ${text(question.intent)}`, '');
    question.options.forEach((option, optionIndex) => {
      const sense = option.word.meanings[option.meaningIndex];
      lines.push(`${optionIndex + 1}. **${text(option.word.word)}** — ${text(option.definition)}`, `   - 풀이 판정: ${option.isCorrect ? '옳음' : '옳지 않음'}. ${text(option.explanation)}`,
        `   - 원래 뜻: ${text(sense.ko)} / ${text(sense.en)}`, `   - 출처: ${sources(option.word)}`);
    });
    lines.push('', `해설: ${text(question.explanation)}`, '');
  }
  lines.push('## 학습 요약', '');
  if (exam.summaryStatus === 'complete') {
    if (typeof exam.summary === 'string') lines.push(exam.summary);
    else for (const [key, value] of Object.entries(exam.summary ?? {})) {
      const labels = { strengths: '강점', weaknesses: '부족한 점', recommendations: '복습 권고', summary: '종합', reviewWords: '복습 단어' };
      lines.push(`### ${labels[key] ?? text(key)}`, '', ...(Array.isArray(value) ? value.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`) : [typeof value === 'string' ? value : JSON.stringify(value)]), '');
    }
  } else lines.push(exam.summaryStatus === 'failed' ? 'AI 요약을 완료하지 못했습니다. 정오답은 저장되었으며 요약만 재시도할 수 있습니다.' : '정오답 저장 완료. AI 약점 요약을 기다리고 있습니다.');
  const providers = examProviders(exam) ?? {};
  lines.push('', ox ? 'O/X 문항의 오답은 출제한 뜻에 대한 근거이며, 그 단어의 다른 뜻까지 모른다고 판단하지 않습니다.' : '한 문항의 오답만으로 해당 보기의 모든 단어를 모른다고 판단하지 않습니다.', '', '## 사용 모델', '',
    ...MODEL_STAGES.map((stage) => `- ${stage}: ${text(exam.models?.[stage])} (${PROVIDER_LABELS[providers[stage]] ?? PROVIDER_LABELS.codex})`), '');
  return lines.join('\n');
}
