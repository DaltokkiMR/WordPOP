import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CopilotClient } from '../lib/copilot-client.mjs';

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };

function fixture({ auth, models, send, current, create, spawnProcess, ...options } = {}) {
  const sessions = []; const calls = []; let configured; let serial = 0;
  const catalog = models || [{ id: 'real-model', name: 'Test Model', supportedReasoningEfforts: ['low', 'medium'] }, { id: 'auto', name: 'Auto' }, { id: 'blocked', name: 'Blocked', policy: { state: 'disabled' } }];
  const sdk = {
    start: async () => { calls.push('start'); }, stop: async () => { calls.push('stop'); }, forceStop: async () => { calls.push('forceStop'); },
    getAuthStatus: async () => auth || { isAuthenticated: true, authType: 'user', login: 'test-user' },
    rpc: { models: { list: async () => ({ models: catalog }) }, account: { getQuota: async () => ({ quotaSnapshots: { premium_interactions: { remainingPercentage: 70 } } }) } },
    createSession: async (config) => {
      if (create) await create(config);
      const session = {
        sessionId: `test-${++serial}`, config, messages: [],
        rpc: { model: { getCurrent: async () => ({ modelId: current?.(config) || config.model || 'real-model' }) } },
        sendAndWait: async (message) => { session.messages.push(message); return send ? send(session, message) : { data: { content: '{"answer":"ok"}' } }; },
        abort: async () => { session.aborted = true; }, disconnect: async () => { session.disconnected = true; },
      };
      sessions.push(session); return session;
    },
    deleteSession: async (id) => { calls.push(`delete:${id}`); },
  };
  const client = new CopilotClient({ sdkFactory: (config) => { configured = config; return sdk; }, requestTimeout: 200, generationTimeout: 1000, ...(spawnProcess ? { spawnProcess } : {}), ...options });
  return { client, sdk, sessions, calls, config: () => configured, generations: () => sessions.filter((session) => session.config.model) };
}

test('status reads official authentication and model catalog, excludes auto/disabled, and never sends prompts', async (t) => {
  const f = fixture(); t.after(() => f.client.close());
  const status = await f.client.status();
  assert.deepEqual(status.account, { type: 'copilot', login: 'test-user' });
  assert.equal(status.provider, 'copilot'); assert.equal(status.defaultModel, 'real-model');
  assert.deepEqual(status.models.map((model) => model.id), ['real-model']);
  assert.equal(status.rateLimits.quotaSnapshots.premium_interactions.remainingPercentage, 70);
  // SDK empty mode forces COPILOT_DISABLE_KEYTAR=1 and cannot read saved OAuth.
  assert.equal(f.config().mode, 'copilot-cli'); assert.equal(f.config().useLoggedInUser, true);
  assert.equal(f.config().baseDirectory, undefined);
  assert.equal(f.config().env.COPILOT_DISABLE_KEYTAR, undefined);
  assert.equal(f.config().env.CI, undefined);
  assert.ok(f.sessions.every((session) => !session.messages.length && session.disconnected));
});

test('API-token or custom-provider authentication is not treated as managed GitHub login', async (t) => {
  for (const authType of ['token', 'api-key', 'env']) {
    const f = fixture({ auth: { isAuthenticated: true, authType } }); t.after(() => f.client.close());
    assert.equal((await f.client.status()).account, null);
    await assert.rejects(f.client.generate({ model: 'real-model', prompt: 'test', schema }), /Copilot에 로그인/);
    assert.equal(f.sessions.length, 0);
  }
});

test('inherited API tokens, custom provider commands, and tracing destinations are removed', async (t) => {
  const keys = ['COPILOT_PROVIDER_API_KEY_COMMAND', 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'OTEL_EXPORTER_OTLP_ENDPOINT'];
  const saved = keys.map((key) => [key, process.env[key]]);
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const key of keys) process.env[key] = 'private';
  const f = fixture(); t.after(() => f.client.close()); await f.client.status();
  for (const key of keys) assert.equal(f.config().env[key], undefined);
});

test('each generation uses a new restricted session and validates native structured output', async (t) => {
  const f = fixture(); t.after(() => f.client.close());
  for (let index = 0; index < 2; index++) assert.deepEqual(await f.client.generate({ model: 'real-model', prompt: 'test', schema }), { answer: 'ok' });
  assert.equal(f.generations().length, 2);
  assert.notEqual(f.generations()[0].sessionId, f.generations()[1].sessionId);
  for (const session of f.generations()) {
    assert.deepEqual(session.config.availableTools, []);
    for (const key of ['enableConfigDiscovery', 'enableSkills', 'enableFileHooks', 'enableSessionStore', 'enableHostGitOperations']) assert.equal(session.config[key], false);
    assert.equal(session.config.skipCustomInstructions, true);
    assert.equal(session.config.customAgentsLocalOnly, true);
    assert.equal(session.config.enableSessionTelemetry, false);
    assert.equal(session.config.coauthorEnabled, false);
    assert.equal(session.config.manageScheduleEnabled, false);
    assert.deepEqual(session.config.includedBuiltinSkills, []);
    assert.deepEqual(session.config.pluginDirectories, []);
    assert.equal(session.config.reasoningEffort, 'medium');
    assert.deepEqual(session.messages[0].responseSchema, schema);
    assert.equal(session.disconnected, true);
    assert.ok(f.calls.includes(`delete:${session.sessionId}`));
  }
});

test('unavailable or substituted models fail without silently choosing another model', async (t) => {
  const missing = fixture(); t.after(() => missing.client.close());
  await assert.rejects(missing.client.generate({ model: 'absent', prompt: '', schema }), /모델을 사용할 수 없습니다/);
  assert.equal(missing.generations().length, 0);
  const replaced = fixture({ current: (config) => config.model ? 'other-model' : 'real-model' }); t.after(() => replaced.client.close());
  await assert.rejects(replaced.client.generate({ model: 'real-model', prompt: '', schema }), /실제 모델이 다릅니다/);
  assert.equal(replaced.generations()[0].messages.length, 0);
});

test('JSON parsing and schema errors get at most one format retry', async (t) => {
  const repaired = fixture({ send: (session) => ({ data: { content: session.messages.length === 1 ? '{"answer":2}' : '{"answer":"repaired"}' } }) });
  t.after(() => repaired.client.close());
  assert.deepEqual(await repaired.client.generate({ model: 'real-model', prompt: '', schema }), { answer: 'repaired' });
  assert.equal(repaired.generations()[0].messages.length, 2);
  const bad = fixture({ send: () => ({ data: { content: 'not json' } }) }); t.after(() => bad.client.close());
  await assert.rejects(bad.client.generate({ model: 'real-model', prompt: '', schema }), /JSON/);
  assert.equal(bad.generations()[0].messages.length, 2);
});

test('unsupported native schema falls back once to local JSON validation, without model replacement', async (t) => {
  const f = fixture({ send: (session) => { if (session.messages.length === 1) throw new Error('responseFormat is not supported by this model'); return { data: { content: '{"answer":"valid"}' } }; } });
  t.after(() => f.client.close());
  assert.deepEqual(await f.client.generate({ model: 'real-model', prompt: '', schema }), { answer: 'valid' });
  assert.equal(f.generations()[0].messages[1].responseSchema, undefined);
  assert.equal(f.generations().length, 1);
});

test('tool requests and model change events stop inference', async (t) => {
  for (const behavior of ['permission', 'tool', 'model']) {
    const f = fixture({ send: async (session) => {
      if (behavior === 'permission') assert.equal(session.config.onPermissionRequest({}).kind, 'reject');
      if (behavior === 'tool') session.config.onEvent({ type: 'tool.execution_start', data: {} });
      if (behavior === 'model') session.config.onEvent({ type: 'session.model_change', data: { newModel: 'other' } });
      return new Promise(() => {});
    } }); t.after(() => f.client.close());
    await assert.rejects(f.client.generate({ model: 'real-model', prompt: '', schema }), /도구|실제 모델/);
    assert.equal(f.generations()[0].aborted, true);
  }
});

test('abort and timeout stop the actual session and never return partial JSON', async (t) => {
  const controller = new AbortController();
  const f = fixture({ send: () => { setTimeout(() => controller.abort(), 5); return new Promise(() => {}); } }); t.after(() => f.client.close());
  await assert.rejects(f.client.generate({ model: 'real-model', prompt: '', schema, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.generations()[0].aborted, true);
  const timeout = fixture({ send: () => new Promise(() => {}), generationTimeout: 20 }); t.after(() => timeout.client.close());
  await assert.rejects(timeout.client.generate({ model: 'real-model', prompt: '', schema }), /시간이 초과/);
  assert.equal(timeout.generations()[0].aborted, true);
});

function loginSpawn(onSpawn) {
  return (command, args, config) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', null)); };
    queueMicrotask(() => onSpawn({ child, command, args, config })); return child;
  };
}

test('official CLI login exposes only device URL and code and supports cancellation', async (t) => {
  let spawned;
  const f = fixture({ spawnProcess: loginSpawn((value) => {
    spawned = value; value.child.stdout.write('To authenticate, visit https://github.com/login/device and enter code ABCD-');
    value.child.stdout.write('1234\nWaiting for authorization...');
  }) }); t.after(() => f.client.close());
  const login = await f.client.login();
  assert.deepEqual(Object.keys(login).sort(), ['authUrl', 'loginId', 'userCode']);
  assert.equal(login.authUrl, 'https://github.com/login/device'); assert.equal(login.userCode, 'ABCD-1234');
  assert.ok(spawned.args.includes('--device-code')); assert.ok(spawned.args.includes('https://github.com'));
  assert.equal(spawned.config.stdio[0], 'ignore');
  assert.deepEqual(await f.client.login(), login);
  assert.deepEqual(await f.client.cancelLogin(login.loginId), { cancelled: true });
  assert.equal(spawned.child.killed, true); assert.equal((await f.client.status()).loginStatus, 'cancelled');
});

test('login failure is actionable and never forwards raw credentials or diagnostics', async (t) => {
  const f = fixture({ spawnProcess: loginSpawn(({ child }) => { child.stderr.write('secret-token, connection failed'); child.emit('exit', 1); }) }); t.after(() => f.client.close());
  await assert.rejects(f.client.login(), (error) => /GitHub 로그인/.test(error.message) && !error.message.includes('secret-token'));
});
