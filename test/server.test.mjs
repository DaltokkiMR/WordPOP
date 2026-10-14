import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

async function start(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'wordpop-server-'));
  await mkdir(path.join(root, 'book'));
  await writeFile(path.join(root, 'book', 'unit-1.json'), JSON.stringify({
    schemaVersion: 1, bookId: 'book', bookTitle: '시험용 책', unitId: '1', unitTitle: '1과',
    words: [{ id: 'apple', word: 'apple', meanings: [{ ko: '사과', en: 'A round fruit.' }] }],
  }));
  const server = createApp({ libraryRoot: root });
  t.after(async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    root,
    get(url, method = 'GET') {
      return new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: server.address().port, path: url, method }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
      });
    },
  };
}

test('local library API returns current data and reports a newly added broken file', async (t) => {
  const app = await start(t);
  const response = await app.get('/api/library');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.equal(response.headers['cache-control'], 'no-store');
  const body = JSON.parse(response.body);
  assert.equal(body.books[0].units[0].words[0].word, 'apple');
  assert.deepEqual(body.warnings, []);
  await writeFile(path.join(app.root, 'book', 'broken.json'), '{');
  const updated = JSON.parse((await app.get('/api/library')).body);
  assert.equal(updated.books[0].units.length, 1);
  assert.equal(updated.warnings.length, 1);
});

test('static app assets have correct types, restrictive headers, and working HEAD responses', async (t) => {
  const app = await start(t);
  const home = await app.get('/');
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'], /^text\/html/);
  assert.match(home.body, /WordPOP/);
  assert.equal(home.headers['x-content-type-options'], 'nosniff');
  assert.match(home.headers['content-security-policy'], /default-src 'self'/);
  const script = await app.get('/js/model.js');
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /^text\/javascript/);
  const head = await app.get('/', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.match(head.headers['content-type'], /^text\/html/);
});

test('server refuses traversal, invalid URLs, unsupported methods, and non-public files', async (t) => {
  const app = await start(t);
  for (const url of ['/%2e%2e%2fserver.mjs', '/%2e%2e%2fmaterial%2fwordmaster_25_30_46_50.md', '/%2e%2e%2fpublic-secret%2findex.html']) {
    const response = await app.get(url);
    assert.equal(response.status, 403, url);
    assert.doesNotMatch(response.body, /createServer|wordmaster_25_30/);
  }
  assert.equal((await app.get('/%ZZ')).status, 400);
  assert.equal((await app.get('/api/library', 'POST')).status, 405);
  assert.equal((await app.get('/server.mjs')).status, 404);
  assert.equal((await app.get('/word_list/book/unit-1.json')).status, 404);
  assert.equal((await app.get('/missing.html')).status, 404);
});
