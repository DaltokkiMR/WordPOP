import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isStudyLevel, isStudyMarks, isUnknownMeaningKeys, isStudyNote, STUDY_NOTE_LIMIT } from '../public/js/study-marks.js';

const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

/** Validate data at the boundary so a broken file cannot break the whole library. */
export function validateUnit(unit) {
  if (!unit || unit.schemaVersion !== 1) throw new Error('schemaVersion은 1이어야 합니다.');
  for (const field of ['bookId', 'bookTitle', 'unitId', 'unitTitle']) {
    if (!nonempty(unit[field])) throw new Error(`${field}가 비어 있습니다.`);
  }
  if (!Array.isArray(unit.words) || !unit.words.length) throw new Error('words에 단어가 필요합니다.');
  const ids = new Set();
  for (const word of unit.words) {
    if (!nonempty(word.id) || !nonempty(word.word)) throw new Error('단어의 id와 word가 필요합니다.');
    if (ids.has(word.id)) throw new Error(`단어 id가 중복됩니다: ${word.id}`);
    ids.add(word.id);
    if (word.studyMark !== undefined && ![null, 'unknown', 'unsure', 'review'].includes(word.studyMark)) {
      throw new Error(`${word.word}: studyMark는 null, unknown, unsure, review 중 하나여야 합니다.`);
    }
    if (word.studyMarks !== undefined && !isStudyMarks(word.studyMarks)) {
      throw new Error(`${word.word}: studyMarks는 unknown, review를 중복 없이 담은 배열이어야 합니다.`);
    }
    if (word.studyLevel !== undefined && !isStudyLevel(word.studyLevel)) {
      throw new Error(`${word.word}: studyLevel은 priority, unknown, review, off 중 하나여야 합니다.`);
    }
    if (word.studyNote !== undefined && !isStudyNote(word.studyNote)) {
      throw new Error(`${word.word}: studyNote는 ${STUDY_NOTE_LIMIT}자 이하의 문자열이어야 합니다.`);
    }
    if (!Array.isArray(word.meanings) || !word.meanings.length) throw new Error(`${word.word}: 뜻이 비어 있습니다.`);
    for (const meaning of word.meanings) {
      if (!nonempty(meaning.ko) || !nonempty(meaning.en)) throw new Error(`${word.word}: 한글 뜻과 영영풀이를 함께 넣어 주세요.`);
      if (meaning.wrongEn !== undefined && !nonempty(meaning.wrongEn)) throw new Error(`${word.word}: wrongEn은 빈 문자열일 수 없습니다.`);
      if (meaning.wrongEn && word.meanings.some((m) => m.en.trim().toLowerCase() === meaning.wrongEn.trim().toLowerCase())) {
        throw new Error(`${word.word}: 오답풀이가 정답풀이와 같습니다.`);
      }
    }
    if (word.unknownMeaningKeys !== undefined && !isUnknownMeaningKeys(word.unknownMeaningKeys, word.meanings)) {
      throw new Error(`${word.word}: unknownMeaningKeys는 이 단어에 있는 뜻의 키를 중복 없이 담은 배열이어야 합니다.`);
    }
  }
  return unit;
}

export async function loadLibrary(root) {
  const books = [];
  const warnings = [];
  let directories;
  try { directories = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return { books, warnings: ['word_list 폴더를 찾을 수 없습니다.'] };
    throw error;
  }
  for (const directory of directories.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'ko'))) {
    const book = { id: directory.name, title: directory.name, units: [] };
    const files = await readdir(path.join(root, directory.name), { withFileTypes: true });
    for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))) {
      try {
        const data = validateUnit(JSON.parse(await readFile(path.join(root, directory.name, file.name), 'utf8')));
        if (data.bookId !== directory.name) throw new Error('bookId와 책 폴더 이름이 다릅니다.');
        if (book.units.some((unit) => unit.unitId === data.unitId)) throw new Error(`과 번호가 중복됩니다: ${data.unitId}`);
        if (book.units.length && data.bookTitle !== book.title) throw new Error('같은 책 안에서 bookTitle이 다릅니다.');
        book.title = data.bookTitle;
        book.units.push({ ...data, key: `${directory.name}/${file.name}`, filename: file.name });
      } catch (error) { warnings.push(`${directory.name}/${file.name}: ${error.message}`); }
    }
    book.units.sort((a, b) => a.unitId.localeCompare(b.unitId, 'ko', { numeric: true }));
    if (book.units.length) books.push(book);
  }
  return { books, warnings };
}
