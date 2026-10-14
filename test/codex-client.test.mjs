import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexClient } from '../lib/codex-client.mjs';

function fixture(overrides = {}) {
  const calls = []; let serial = 0; let commandArgs;
  const spawnProcess = (command, args) => {
    commandArgs = args;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.stdin.end(); child.stdout.end(); child.stderr.end(); child.emit('exit', 0); };
    const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.stdin.on('data', (buffer) => {
      for (const line of String(buffer).trim().split('\n')) {
        const request = JSON.parse(line); calls.push(request);
        if (!request.method || request.id === undefined) continue;
        if (overrides[request.method]) { overrides[request.method]({ request, send, child }); continue; }
        let result = {};
        if (request.method === 'config/read') result = { config: { mcp_servers: { test: { enabled: true } } } };
        if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: 'test@example.com' } };
        if (request.method === 'model/list') result = { data: [{ id: 'catalog-model', model: 'test-model', displayName: 'Test', isDefault: true }], nextCursor: null };
        if (request.method === 'account/rateLimits/read') result = { rateLimits: { primary: { usedPercent: 10 } } };
        if (request.method === 'account/login/start') result = { type: 'chatgpt', authUrl: 'https://auth.openai.com/test', loginId: 'login1' };
        if (request.method === 'thread/start') result = { thread: { id: `thread${++serial}` }, model: request.params.model };
        if (request.method === 'turn/start') {
          result = { turn: { id: `turn${serial}` } };
          send({ method: 'item/completed', params: { threadId: request.params.threadId, item: { type: 'agentMessage', text: '{"answer":"ok"}', phase: 'final_answer' } } });
          send({ method: 'turn/completed', params: { threadId: request.params.threadId, turn: { id: result.turn.id, status: 'completed', items: [] } } });
        }
        send({ id: request.id, result });
      }
    });
    return child;
  };
  const client = new CodexClient({ command: 'fake-codex', spawnProcess, requestTimeout: 200, generationTimeout: 1000 });
  return { client, calls, args: () => commandArgs };
}

test('status returns ChatGPT account, dynamic default/model IDs, and rate limits', async (t) => {
  const { client, args } = fixture(); t.after(() => client.close());
  const status = await client.status();
  assert.equal(status.account.type, 'chatgpt');
  assert.equal(status.defaultModel, 'test-model');
  assert.equal(status.models[0].catalogId, 'catalog-model');
  assert.equal(status.rateLimits.rateLimits.primary.usedPercent, 10);
  assert.ok(args().includes('features.shell_tool=false'));
  assert.ok(args().includes('features.plugins=false'));
  assert.ok(args().includes('forced_login_method="chatgpt"'));
});

test('managed ChatGPT login starts and cancels using Codex, without exposing tokens', async (t) => {
  const { client, calls } = fixture(); t.after(() => client.close());
  assert.deepEqual(await client.login(), { authUrl: 'https://auth.openai.com/test', loginId: 'login1' });
  await client.cancelLogin('login1');
  assert.deepEqual(calls.find((call) => call.method === 'account/login/start').params, { type: 'chatgpt' });
  assert.deepEqual(calls.find((call) => call.method === 'account/login/cancel').params, { loginId: 'login1' });
});

test('each generation uses a fresh ephemeral restricted thread and handles early completion', async (t) => {
  const { client, calls } = fixture(); t.after(() => client.close());
  const schema = { type: 'object' };
  for (let i = 0; i < 2; i++) assert.deepEqual(await client.generate({ model: 'test-model', prompt: 'test', schema }), { answer: 'ok' });
  const starts = calls.filter((call) => call.method === 'thread/start');
  assert.equal(starts.length, 2);
  assert.ok(starts.every((call) => call.params.ephemeral && call.params.sandbox === 'read-only' && call.params.allowProviderModelFallback === false));
  assert.equal(starts[0].params.config['mcp_servers.test.enabled'], false);
  const turns = calls.filter((call) => call.method === 'turn/start');
  assert.notEqual(turns[0].params.threadId, turns[1].params.threadId);
  assert.deepEqual(turns[0].params.outputSchema, schema);
  assert.deepEqual(turns[0].params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
});

test('missing models and non-ChatGPT authentication never fall back', async (t) => {
  const first = fixture(); t.after(() => first.client.close());
  await assert.rejects(first.client.generate({ model: 'missing', prompt: '', schema: {} }), /모델을 사용할 수 없습니다/);
  assert.ok(!first.calls.some((call) => call.method === 'thread/start'));
  const second = fixture({ 'account/read': ({ request, send }) => send({ id: request.id, result: { account: { type: 'apiKey' } } }) });
  t.after(() => second.client.close());
  await assert.rejects(second.client.generate({ model: 'test-model', prompt: '', schema: {} }), /ChatGPT로 로그인/);
});

test('actual model substitution is rejected before generating', async (t) => {
  const { client, calls } = fixture({ 'thread/start': ({ request, send }) => send({ id: request.id, result: { thread: { id: 'thread' }, model: 'other' } }) });
  t.after(() => client.close());
  await assert.rejects(client.generate({ model: 'test-model', prompt: '', schema: {} }), /실제 모델이 다릅니다/);
  assert.ok(!calls.some((call) => call.method === 'turn/start'));
});

test('tool/approval requests are denied and generation is stopped', async (t) => {
  const { client, calls } = fixture({ 'turn/start': ({ request, send }) => {
    send({ id: request.id, result: { turn: { id: 'turn' } } });
    send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: request.params.threadId } });
  } });
  t.after(() => client.close());
  await assert.rejects(client.generate({ model: 'test-model', prompt: '', schema: {} }), /도구 사용/);
  assert.ok(calls.some((call) => call.id === 'approval' && call.error));
});

test('abort interrupts the active turn and never returns partial JSON', async (t) => {
  const control = new AbortController();
  const { client, calls } = fixture({ 'turn/start': ({ request, send }) => {
    send({ id: request.id, result: { turn: { id: 'turn' } } });
    setTimeout(() => control.abort(), 10);
  } });
  t.after(() => client.close());
  await assert.rejects(client.generate({ model: 'test-model', prompt: '', schema: {}, signal: control.signal }), { name: 'AbortError' });
  assert.ok(calls.some((call) => call.method === 'turn/interrupt'));
});

test('JSON parse failures and generation timeout surface actionable errors', async (t) => {
  const bad = fixture({ 'turn/start': ({ request, send }) => {
    send({ id: request.id, result: { turn: { id: 'turn' } } });
    send({ method: 'turn/completed', params: { threadId: request.params.threadId, turn: { status: 'completed', items: [{ type: 'agentMessage', text: 'not json' }] } } });
  } });
  t.after(() => bad.client.close());
  await assert.rejects(bad.client.generate({ model: 'test-model', prompt: '', schema: {} }), /JSON/);
  const slow = fixture({ 'turn/start': ({ request, send }) => send({ id: request.id, result: { turn: { id: 'turn' } } }) });
  slow.client.generationTimeout = 20; t.after(() => slow.client.close());
  await assert.rejects(slow.client.generate({ model: 'test-model', prompt: '', schema: {} }), /시간이 초과/);
});
