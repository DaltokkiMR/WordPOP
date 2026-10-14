import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary } from '../lib/library.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const sourcePath = 'material/wordmaster_25_30_46_50.md';
const expectedUnits = ['25', '26', '27', '28', '29', '30', '46', '47', '48', '49', '50'];
const expectedWordCount = 440;
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const errors = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

/** Read the original rows without changing their spelling, order, or meanings. */
function parseOriginal(text) {
  const units = new Map();
  const headings = [...text.matchAll(/^## (\d+)과 \((\d+)개\)\s*$/gm)];
  for (const [index, heading] of headings.entries()) {
    const [, unitId, declaredCount] = heading;
    const section = text.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? text.length);
    const rows = [...section.matchAll(/^\| ([^|]+) \| ([^|]+) \|\s*$/gm)]
      .filter(([, word]) => word !== '단어' && word !== '---')
      .map(([, word, sourceMeaning]) => ({ word, sourceMeaning }));
    check(!units.has(unitId), `원문에서 ${unitId}과 제목이 중복됩니다.`);
    check(Number(declaredCount) === rows.length, `원문 ${unitId}과: 제목의 ${declaredCount}개와 실제 ${rows.length}개가 다릅니다.`);
    check(rows.length === 40, `원문 ${unitId}과는 40단어여야 합니다: 현재 ${rows.length}개`);
    units.set(unitId, rows);
  }
  check(units.size === expectedUnits.length, `원문은 11과여야 합니다: 현재 ${units.size}과`);
  check(expectedUnits.every((id) => units.has(id)), '원문에 25~30과 및 46~50과가 모두 있어야 합니다.');
  const count = [...units.values()].reduce((sum, words) => sum + words.length, 0);
  check(count === expectedWordCount, `원문은 440단어여야 합니다: 현재 ${count}개`);
  return units;
}

async function validate() {
  const [library, source] = await Promise.all([
    loadLibrary(path.join(projectRoot, 'word_list')),
    readFile(path.join(projectRoot, sourcePath), 'utf8'),
  ]);
  errors.push(...library.warnings);
  const original = parseOriginal(source);
  const wordmaster = library.books.find((book) => book.id === 'wordmaster');
  check(Boolean(wordmaster), '초기 wordmaster 책이 없습니다.');

  const globalIds = new Map();
  let unitCount = 0;
  let wordCount = 0;
  let meaningCount = 0;
  for (const book of library.books) {
    for (const unit of book.units) {
      unitCount += 1;
      for (const word of unit.words) {
        wordCount += 1;
        meaningCount += word.meanings.length;
        const location = `${book.id}/${unit.filename}: ${word.word}`;
        check(!globalIds.has(word.id), `전체 단어 id 중복: ${word.id} (${globalIds.get(word.id)} / ${location})`);
        globalIds.set(word.id, location);
        if (word.sourceNote !== undefined) {
          check(nonempty(word.sourceNote), `${location}: sourceNote는 빈 문자열일 수 없습니다.`);
        }
      }
    }
  }

  let checkedInitialWords = 0;
  for (const unitId of expectedUnits) {
    const unit = wordmaster?.units.find((candidate) => candidate.unitId === unitId);
    const originalWords = original.get(unitId);
    check(Boolean(unit), `초기 Wordmaster ${unitId}과가 없습니다.`);
    if (!unit || !originalWords) continue;
    check(unit.bookTitle === '2026 워드마스터 수능 2000', `${unitId}과의 bookTitle이 초기 책 이름과 다릅니다.`);
    check(unit.unitTitle === `${unitId}과`, `${unitId}과의 unitTitle이 과 번호와 다릅니다.`);
    check(unit.source === sourcePath, `${unitId}과의 source가 원문 경로와 다릅니다.`);
    check(unit.words.length === originalWords.length, `${unitId}과 단어 수 불일치: 원문 ${originalWords.length}개, JSON ${unit.words.length}개`);
    for (const [index, word] of unit.words.entries()) {
      const expected = originalWords[index];
      checkedInitialWords += 1;
      if (!expected) continue;
      const location = `${unitId}과 ${index + 1}번째 단어(${word.word})`;
      check(word.word === expected.word, `${location}: 원문 철자 또는 순서 불일치, 원문은 '${expected.word}'입니다.`);
      check(word.sourceMeaning === expected.sourceMeaning, `${location}: sourceMeaning이 원문과 다릅니다.`);
      for (const [meaningIndex, meaning] of word.meanings.entries()) {
        for (const field of ['ko', 'en', 'wrongEn']) {
          check(nonempty(meaning[field]), `${location}의 ${meaningIndex + 1}번째 뜻: ${field}가 필요합니다.`);
        }
      }
    }
  }
  check(checkedInitialWords === expectedWordCount, `초기 Wordmaster 11과의 단어 합계는 440이어야 합니다: 현재 ${checkedInitialWords}개`);

  if (errors.length) {
    console.error(`단어 데이터 검증 실패: ${errors.length}건`);
    for (const message of errors) console.error(`- ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`단어 데이터 검증 통과: ${library.books.length}권 / ${unitCount}과 / ${wordCount}단어 / ${meaningCount}뜻쌍`);
  console.log('초기 Wordmaster 11과·440단어: 원문 철자·순서·뜻 보존, 필수 정의, 전체 id 고유성 확인');
  console.log('영어 정의의 정확성과 오답의 의미상 불일치는 별도 내용 검토가 필요합니다.');
}

validate().catch((error) => {
  console.error(`단어 데이터 검증을 실행하지 못했습니다: ${error.message}`);
  process.exitCode = 1;
});
