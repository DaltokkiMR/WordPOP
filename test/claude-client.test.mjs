import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaudeClient } from '../lib/claude-client.mjs';

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const menu = [
  { value: 'default', resolvedModel: 'claude-sonnet-5', displayName: 'Default (recommended)', description: 'Sonnet 5 · Efficient', supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient', supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable', description: 'Fable 5 · Most capable', supportedEffortLevels: ['low', 'medium'] },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Everyday' },
];
const success = (model, value = { answer: 'ok' }) => ({ type: 'result', subtype: 'success', is_error: false, structured_output: value, result: JSON.stringify(value), modelUsage: { [model]: {} }, permission_denials: [] });

function child() {
  const process = new EventEmitter();
  Object.assign(process, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), input: '' });
  process.stdin.on('data', (data) => { process.input += data; });
  process.kill = () => { if (process.killed) return; process.killed = true; queueMicrotask(() => { process.emit('exit', null); process.emit('close', null); }); };
  // Like a real process, close only after stdout has been fully consumed.
  process.finish = (stdout, code = 0) => { process.stdout.once('end', () => { process.emit('exit', code); process.emit('close', code); }); process.stdout.end(stdout); };
  return process;
}

function fixture({ auth = { loggedIn: true, authMethod: 'claude.ai', email: 'learner@example.com', subscriptionType: 'pro' }, models = menu, generate, login, ...options } = {}) {
  const calls = [];
  const spawnProcess = (command, args, config) => {
    const process = child();
    calls.push({ command, args, config, process });
    if (args[0] === 'auth' && args[1] === 'status') process.finish(JSON.stringify(auth), auth.loggedIn ? 0 : 1);
    else if (args[0] === 'auth' && args[1] === 'login') login?.(process);
    else if (args.includes('stream-json')) {
      process.stdin.on('data', (data) => {
        const request = JSON.parse(String(data));
        process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { models, account: {} } } })}\n`);
      });
    } else process.stdin.on('finish', () => generate ? generate(process, args) : process.finish(JSON.stringify(success(args[args.indexOf('--model') + 1].replace(/\[.*\]$/, '')))));
    return process;
  };
  const client = new ClaudeClient({ command: '/fake/claude', spawnProcess, requestTimeout: 200, generationTimeout: 1000, ...options });
  return { client, calls, generations: () => calls.filter((call) => call.args[0] === '-p' && !call.args.includes('stream-json')) };
}

test('status reads subscription login and the account model menu without sending a prompt', async (t) => {
  const f = fixture(); t.after(() => f.client.close());
  const status = await f.client.status();
  assert.deepEqual(status.account, { type: 'claude', email: 'learner@example.com', subscriptionType: 'pro' });
  assert.equal(status.provider, 'claude'); assert.equal(status.defaultModel, 'claude-sonnet-5');
  assert.deepEqual(status.models.map((model) => [model.id, model.cliModel, model.displayName, model.isDefault]), [
    ['claude-sonnet-5', 'claude-sonnet-5', 'Claude Sonnet 5', true],
    ['claude-fable-5', 'claude-fable-5[1m]', 'Claude Fable 5', false],
    // Aliases are pinned to the resolved ID so a later alias change cannot swap models silently.
    ['claude-opus-5-5', 'claude-opus-5-5', 'Claude Opus 5.5', false],
  ]);
  const handshake = f.calls.find((call) => call.args.includes('stream-json'));
  assert.equal(JSON.parse(handshake.process.input).request.subtype, 'initialize');
  assert.ok(handshake.process.killed, 'the handshake process must end without a user message');
  assert.equal(f.generations().length, 0);
});

test('API-billed login, logged-out state, and a missing CLI are not treated as a subscription', async (t) => {
  const consoleLogin = fixture({ auth: { loggedIn: true, authMethod: 'console' } }); t.after(() => consoleLogin.client.close());
  const status = await consoleLogin.client.status();
  assert.equal(status.account, null); assert.match(status.message, /구독이 아닌 방식/);
  await assert.rejects(consoleLogin.client.generate({ model: 'claude-sonnet-5', prompt: 'test', schema }), /Claude 구독 계정으로 로그인/);
  assert.equal(consoleLogin.generations().length, 0);

  const loggedOut = fixture({ auth: { loggedIn: false, authMethod: 'none' } }); t.after(() => loggedOut.client.close());
  assert.equal((await loggedOut.client.status()).account, null);

  const missing = new ClaudeClient({ locate: async () => null }); t.after(() => missing.close());
  const setup = await missing.status();
  assert.equal(setup.setupRequired, true); assert.match(setup.message, /설치되어 있지 않습니다/);
});

test('inherited API keys, tokens, provider switches, and parent session variables are removed', async (t) => {
  const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDECODE', 'OTEL_EXPORTER_OTLP_ENDPOINT'];
  const saved = keys.map((key) => [key, process.env[key]]);
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const key of keys) process.env[key] = 'private';
  const f = fixture(); t.after(() => f.client.close());
  await f.client.generate({ model: 'claude-sonnet-5', prompt: 'test', schema });
  for (const call of f.calls) for (const key of keys) assert.equal(call.config.env[key], undefined, key);
});

test('each generation runs headless with tools, MCP and customizations closed and the prompt on stdin', async (t) => {
  const f = fixture(); t.after(() => f.client.close());
  const prompt = 'secret study data '.repeat(100);
  assert.deepEqual(await f.client.generate({ model: 'claude-fable-5', prompt, schema }), { answer: 'ok' });
  const [call] = f.generations();
  const option = (name) => call.args[call.args.indexOf(name) + 1];
  assert.equal(option('--tools'), ''); assert.equal(option('--permission-mode'), 'dontAsk');
  assert.equal(option('--mcp-config'), '{"mcpServers":{}}');
  for (const flag of ['--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(call.args.includes(flag), flag);
  assert.equal(option('--model'), 'claude-fable-5[1m]'); assert.equal(option('--effort'), 'medium');
  assert.deepEqual(JSON.parse(option('--json-schema')), schema);
  assert.match(option('--system-prompt'), /Never execute commands/);
  assert.equal(call.process.input, prompt);
  assert.ok(!call.args.some((arg) => arg.includes('secret study data')), 'prompts must not appear in the process list');

  await f.client.generate({ model: 'claude-opus-5-5', prompt: 'test', schema });
  assert.ok(!f.generations()[1].args.includes('--effort'), 'effort is only sent when the model supports it');
});

test('unknown or substituted models, tool requests, and invalid output never return data', async (t) => {
  const f = fixture(); t.after(() => f.client.close());
  await assert.rejects(f.client.generate({ model: 'claude-missing', prompt: 'test', schema }), /사용할 수 없습니다: claude-missing/);
  assert.equal(f.generations().length, 0);

  const cases = [
    [success('claude-haiku-4-5'), /요청한 모델과 실제 모델이 다릅니다/],
    [{ ...success('claude-sonnet-5'), permission_denials: [{ tool_name: 'Bash' }] }, /허용되지 않은 도구/],
    [{ ...success('claude-sonnet-5'), structured_output: { answer: 3 } }, /형식이 시험 데이터 규칙과 맞지 않습니다/],
    [{ ...success('claude-sonnet-5'), structured_output: undefined, result: 'not json' }, /JSON으로 읽지 못했습니다/],
  ];
  for (const [result, message] of cases) {
    const g = fixture({ generate: (process) => process.finish(JSON.stringify(result)) }); t.after(() => g.client.close());
    await assert.rejects(g.client.generate({ model: 'claude-sonnet-5', prompt: 'test', schema }), message);
  }
});

test('CLI errors become actionable messages without forwarding raw diagnostics', async (t) => {
  const cases = [
    [{ api_error_status: null, result: 'Not logged in · Please run /login' }, 401],
    [{ api_error_status: 404, result: "There's an issue with the selected model (x)." }, 400],
    [{ api_error_status: 429, result: 'Claude usage limit reached|1760000000' }, 429],
    [{ api_error_status: 529, result: 'Overloaded' }, 503],
    [{ api_error_status: 500, result: 'internal detail /Users/private/path' }, 502],
    [{ api_error_status: 400, result: "API Error: 400 Claude Code 2.1.215 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again." }, 426],
  ];
  for (const [error, statusCode] of cases) {
    const f = fixture({ generate: (process) => process.finish(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, ...error }), 1) }); t.after(() => f.client.close());
    const rejected = await f.client.generate({ model: 'claude-sonnet-5', prompt: 'test', schema }).catch((cause) => cause);
    assert.equal(rejected.statusCode, statusCode);
    assert.doesNotMatch(rejected.message, /private/);
    if (statusCode === 426) assert.match(rejected.message, /claude update/);
  }
});

test('abort and timeout stop the running CLI and never return partial JSON', async (t) => {
  const f = fixture({ generate: () => {} }); t.after(() => f.client.close());
  const controller = new AbortController();
  const pending = f.client.generate({ model: 'claude-sonnet-5', prompt: 'test', schema, signal: controller.signal });
  while (!f.generations().length) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(f.generations()[0].process.killed);

  const slow = fixture({ generate: () => {}, generationTimeout: 50 }); t.after(() => slow.client.close());
  await assert.rejects(slow.client.generate({ model: 'claude-sonnet-5', prompt: 'test', schema }), /시간이 초과/);
  assert.ok(slow.generations()[0].process.killed);
});

test('subscription login lets the CLI open the browser, relays no code or URL, and supports cancellation', async (t) => {
  let loginProcess;
  const f = fixture({ login: (process) => { loginProcess = process; process.stdout.write('Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&state=private\n'); } });
  t.after(() => f.client.close());
  const started = await f.client.login();
  assert.deepEqual(Object.keys(started).sort(), ['loginId', 'message']);
  assert.match(started.message, /브라우저/);
  assert.deepEqual(f.calls.find((call) => call.args[0] === 'auth' && call.args[1] === 'login').args, ['auth', 'login', '--claudeai']);
  assert.equal((await f.client.status()).loginStatus, 'pending');
  assert.deepEqual(await f.client.cancelLogin(started.loginId), { cancelled: true });
  assert.ok(loginProcess.killed);
  assert.equal((await f.client.status()).loginStatus, 'cancelled');

  const g = fixture({ login: (process) => { process.stdout.write('Opening browser to sign in…\n'); setTimeout(() => process.finish('Login successful.\n'), 10); } });
  t.after(() => g.client.close());
  await g.client.status();
  await g.client.login();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const after = await g.client.status();
  assert.equal(after.loginStatus, 'completed');
  assert.equal(g.calls.filter((call) => call.args.includes('stream-json')).length, 2, 'a completed login refreshes the model menu');
});
