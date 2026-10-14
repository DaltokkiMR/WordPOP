import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateUnit, loadLibrary } from '../lib/library.mjs';
import { meaningKey } from '../public/js/study-marks.js';

const fixture = (unitId = '1', overrides = {}) => ({
  schemaVersion: 1, bookId: 'book', bookTitle: '시험용 책', unitId, unitTitle: `${unitId}과`,
  words: [{ id: 'word', word: 'word', meanings: [{ ko: '단어', en: 'A unit of language.', wrongEn: 'A measure of temperature.' }, { ko: '약속', en: 'A promise.' }] }],
  ...overrides,
});
const clone = (value) => JSON.parse(JSON.stringify(value));

test('unit validation preserves multiple sense pairs and rejects unsafe or incomplete definitions', () => {
  const unit = fixture();
  assert.equal(validateUnit(unit), unit);
  const duplicate = clone(unit);
  duplicate.words.push(duplicate.words[0]);
  assert.throws(() => validateUnit(duplicate), /중복/);
  for (const field of ['ko', 'en']) {
    const missing = clone(unit);
    missing.words[0].meanings[0][field] = ' ';
    assert.throws(() => validateUnit(missing), /한글 뜻과 영영풀이/);
  }
  const colliding = clone(unit);
  colliding.words[0].meanings[0].wrongEn = '  A PROMISE.  ';
  assert.throws(() => validateUnit(colliding), /오답풀이가 정답풀이와 같습니다/);
  const emptyDistractor = clone(unit);
  emptyDistractor.words[0].meanings[0].wrongEn = '';
  assert.throws(() => validateUnit(emptyDistractor), /wrongEn/);
});

test('unit validation accepts study levels, sense marks and legacy data with strict values', () => {
  for (const fields of [{ studyMark: 'unsure' }, { studyMarks: [] }, ...['priority', 'unknown', 'review', 'off'].map((studyLevel) => ({ studyLevel })),
    { studyMarks: ['unknown', 'review'], unknownMeaningKeys: [meaningKey(fixture().words[0].meanings[1])] }]) {
    const value = fixture();
    Object.assign(value.words[0], fields);
    assert.equal(validateUnit(value), value);
  }
  for (const fields of [
    { studyMarks: 'review' }, { studyMarks: null }, { studyMarks: ['unsure'] }, { studyMarks: ['unknown', 'unknown'] },
    { studyLevel: 'unsure' }, { studyLevel: null }, { studyLevel: ['review'] },
    { unknownMeaningKeys: 'missing' }, { unknownMeaningKeys: null }, { unknownMeaningKeys: [0] }, { unknownMeaningKeys: ['missing'] },
    { unknownMeaningKeys: Array(2).fill(meaningKey(fixture().words[0].meanings[0])) },
  ]) {
    const value = fixture();
    Object.assign(value.words[0], fields);
    assert.throws(() => validateUnit(value), /studyMarks|studyLevel|unknownMeaningKeys/);
  }
});

test('library quarantines broken files while loading and numerically sorting valid units', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'wordpop-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'book'));
  const files = {
    'a-unit-10.json': JSON.stringify(fixture('10')),
    'b-unit-2.json': JSON.stringify(fixture('2')),
    'c-broken.json': '{ invalid JSON',
    'd-empty.json': JSON.stringify(fixture('3', { words: [] })),
    'e-mismatch.json': JSON.stringify(fixture('4', { bookId: 'elsewhere' })),
    'f-duplicate.json': JSON.stringify(fixture('2')),
    'g-title.json': JSON.stringify(fixture('5', { bookTitle: '다른 제목' })),
    'notes.md': 'This file is not a unit.',
  };
  await Promise.all(Object.entries(files).map(([filename, content]) => writeFile(path.join(root, 'book', filename), content)));
  const library = await loadLibrary(root);
  assert.equal(library.books.length, 1);
  assert.deepEqual(library.books[0].units.map((unit) => unit.unitId), ['2', '10']);
  assert.equal(library.books[0].units[0].key, 'book/b-unit-2.json');
  assert.equal(library.warnings.length, 5);
  for (const filename of ['c-broken.json', 'd-empty.json', 'e-mismatch.json', 'f-duplicate.json', 'g-title.json']) {
    assert.ok(library.warnings.some((warning) => warning.startsWith(`book/${filename}:`)));
  }
});

test('library sorts books, ignores empty book folders, and explains a missing library', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'wordpop-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const id of ['z-book', 'a-book', 'empty']) await mkdir(path.join(root, id));
  await Promise.all(['z-book', 'a-book'].map((id) => writeFile(path.join(root, id, '1.json'), JSON.stringify(fixture('1', { bookId: id, bookTitle: id })))));
  const library = await loadLibrary(root);
  assert.deepEqual(library.books.map((book) => book.id), ['a-book', 'z-book']);
  assert.deepEqual(library.warnings, []);
  const missing = await loadLibrary(path.join(root, 'missing'));
  assert.deepEqual(missing.books, []);
  assert.equal(missing.warnings.length, 1);
});
