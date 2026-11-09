// Unit tests against a local mock server: no network, no API key.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { startMock, apiError } from './mock-server.mjs';
import {
  Scriptivox,
  APIError,
  ScriptivoxError,
  PaymentRequiredError,
  ZeroBalanceError,
  InvalidApiKeyError,
  AuthenticationError,
  RateLimitError,
  RateLimitExceededError,
  NotFoundError,
  TranscriptionNotFoundError,
  PayloadTooLargeError,
  InvalidRequestError,
  IdempotencyKeyLockedError,
  MaintenanceError,
  InternalError,
  ServiceUnavailableError,
  TranscriptionFailedError,
  WaitTimeoutError,
  APITimeoutError,
  APIConnectionError,
  UploadFailedError,
  API_ERROR_CODES,
  ERROR_CLASS_BY_CODE,
  TRANSCRIPTION_ERROR_CODES,
  safeFilename,
  VERSION,
} from '../dist/esm/index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let mock;
let client;
const make = (opts = {}) => new Scriptivox({ apiKey: 'sk_live_test', baseUrl: mock.url, ...opts });
const job = (id, status, extra = {}) => ({ status: 200, body: { id, status, ...extra } });

before(async () => {
  mock = await startMock();
});
after(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.reset();
  client = make();
});

test('constructor: needs a key; reads SCRIPTIVOX_API_KEY; accepts a base URL with /v1', async () => {
  const saved = process.env.SCRIPTIVOX_API_KEY;
  delete process.env.SCRIPTIVOX_API_KEY;
  assert.throws(() => new Scriptivox(), ScriptivoxError);
  process.env.SCRIPTIVOX_API_KEY = 'sk_live_env';
  const fromEnv = new Scriptivox({ baseUrl: mock.url + '/v1/' });
  assert.equal(fromEnv.baseUrl, mock.url);
  mock.reply({ status: 200, body: { balance_cents: 1 } });
  await fromEnv.balance();
  assert.equal(mock.requests[0].headers.authorization, 'sk_live_env');
  assert.equal(mock.requests[0].path, '/v1/balance');
  if (saved === undefined) delete process.env.SCRIPTIVOX_API_KEY;
  else process.env.SCRIPTIVOX_API_KEY = saved;
});

test('transcribe({url}): body, headers and an automatic UUID Idempotency-Key', async () => {
  mock.reply(job('j1', 'created'));
  const out = await client.transcribe({ url: 'https://example.com/a.mp3', language: 'en', diarize: true, speaker_count: 2 });
  assert.deepEqual(out, { id: 'j1', status: 'created' });
  const r = mock.requests[0];
  assert.equal(r.method, 'POST');
  assert.equal(r.path, '/v1/transcribe');
  assert.deepEqual(r.json, { language: 'en', diarize: true, speaker_count: 2, url: 'https://example.com/a.mp3' });
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers.authorization, 'sk_live_test');
  assert.match(r.headers['idempotency-key'], UUID_RE);
  assert.match(r.headers['user-agent'], new RegExp(`^scriptivox-node/${VERSION.replace(/\./g, '\\.')} node/v`));
});

test('transcribe: language null is sent (auto-detect); exactly one source required', async () => {
  mock.reply(job('j1', 'created'));
  await client.transcribe({ upload_id: 'u1', language: null });
  assert.deepEqual(mock.requests[0].json, { language: null, upload_id: 'u1' });
  await assert.rejects(client.transcribe({ language: 'en' }), TypeError);
  await assert.rejects(client.transcribe({ url: 'https://x/a.mp3', upload_id: 'u' }), TypeError);
});

test('a retried submit reuses the same Idempotency-Key (500 then 200)', async () => {
  mock.reply(apiError(500, 'INTERNAL_ERROR'), job('j2', 'created'));
  const out = await client.transcribe({ url: 'https://example.com/a.mp3' });
  assert.equal(out.id, 'j2');
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0].headers['idempotency-key'], mock.requests[1].headers['idempotency-key']);
});

test('a caller-supplied Idempotency-Key is sent as is', async () => {
  mock.reply(job('j3', 'created'));
  await client.transcribe({ url: 'https://example.com/a.mp3' }, { idempotencyKey: 'order-42' });
  assert.equal(mock.requests[0].headers['idempotency-key'], 'order-42');
});

test('429 with Retry-After is waited out and retried', async () => {
  mock.reply(apiError(429, 'RATE_LIMIT_EXCEEDED', 'slow down', {}, { 'retry-after': '1' }), { status: 200, body: { balance_cents: 5 } });
  const t0 = Date.now();
  const b = await client.balance();
  assert.equal(b.balance_cents, 5);
  assert.equal(mock.requests.length, 2);
  assert.ok(mock.requests[1].at - mock.requests[0].at >= 950, `waited ${mock.requests[1].at - mock.requests[0].at} ms`);
  assert.ok(Date.now() - t0 < 5000);
});

test('429 without Retry-After (jobs-in-progress cap) is thrown at once, with in_flight and limit', async () => {
  mock.reply(apiError(429, 'RATE_LIMIT_EXCEEDED', '25 jobs in progress', { in_flight: 25, limit: 25 }));
  const err = await client.transcribe({ url: 'https://example.com/a.mp3' }).catch((e) => e);
  assert.ok(err instanceof RateLimitExceededError);
  assert.ok(err instanceof RateLimitError);
  assert.equal(err.retryAfter, undefined);
  assert.equal(err.error.in_flight, 25);
  assert.equal(err.error.limit, 25);
  assert.equal(mock.requests.length, 1);
});

test('a Retry-After longer than 60 s is not waited out', async () => {
  mock.reply(apiError(429, 'RATE_LIMIT_EXCEEDED', 'blocked', {}, { 'retry-after': '600' }));
  const err = await client.balance().catch((e) => e);
  assert.ok(err instanceof RateLimitExceededError);
  assert.equal(err.retryAfter, 600);
  assert.equal(mock.requests.length, 1);
});

test('typed errors: class per code, category per status, request id, docs url', async () => {
  mock.reply(apiError(402, 'ZERO_BALANCE', 'Balance is $0 or below. Please deposit funds before transcribing.'));
  const err = await client.transcribe({ url: 'https://example.com/a.mp3' }).catch((e) => e);
  assert.ok(err instanceof ZeroBalanceError);
  assert.ok(err instanceof PaymentRequiredError);
  assert.ok(err instanceof APIError);
  assert.ok(err instanceof ScriptivoxError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ZeroBalanceError');
  assert.equal(err.status, 402);
  assert.equal(err.code, 'ZERO_BALANCE');
  assert.equal(err.requestId, 'req_0123456789abcdef');
  assert.equal(err.docsUrl, 'https://platform.scriptivox.com/docs/api-reference#error-codes');
  assert.match(err.message, /deposit funds.*\[ZERO_BALANCE, request req_0123456789abcdef\]/);
  assert.equal(mock.requests.length, 1, '402 is not retried');

  mock.reply(apiError(401, 'INVALID_API_KEY'));
  const e401 = await client.balance().catch((e) => e);
  assert.ok(e401 instanceof InvalidApiKeyError && e401 instanceof AuthenticationError);

  mock.reply(apiError(404, 'TRANSCRIPTION_NOT_FOUND'));
  const e404 = await client.get('nope').catch((e) => e);
  assert.ok(e404 instanceof TranscriptionNotFoundError && e404 instanceof NotFoundError);

  mock.reply(apiError(404, 'NOT_FOUND'));
  const eRoute = await client.get('nope').catch((e) => e);
  assert.equal(eRoute.constructor, NotFoundError);
  assert.equal(eRoute.code, 'NOT_FOUND');
});

test('every code in the OpenAPI document has a class; 26 sync and 13 async codes', () => {
  assert.equal(API_ERROR_CODES.length, 26);
  assert.equal(TRANSCRIPTION_ERROR_CODES.length, 13);
  for (const code of API_ERROR_CODES) assert.equal(typeof ERROR_CLASS_BY_CODE[code], 'function', code);
});

test('an unknown code maps by status; a non-JSON error body is handled', async () => {
  mock.reply(apiError(503, 'SOMETHING_NEW', 'new'), apiError(503, 'SOMETHING_NEW', 'new'), apiError(503, 'SOMETHING_NEW', 'new'));
  const e = await client.balance().catch((x) => x);
  assert.ok(e instanceof ServiceUnavailableError);
  assert.equal(e.code, 'SOMETHING_NEW');
  assert.equal(mock.requests.length, 3, 'GET retried twice on 503');

  mock.reset();
  mock.reply({ status: 413, headers: { 'content-type': 'text/html', 'x-request-id': 'req_feedfeedfeedfeed' }, body: '<html><body>413 Request Entity Too Large</body></html>' });
  const e413 = await client.transcribe({ url: 'https://example.com/a.mp3' }).catch((x) => x);
  assert.ok(e413 instanceof PayloadTooLargeError);
  assert.equal(e413.code, 'UNKNOWN_ERROR');
  assert.equal(e413.requestId, 'req_feedfeedfeedfeed');
  assert.match(e413.message, /HTTP 413: <html>/);
});

test('400 is never retried; a non-idempotent POST is not retried on 500', async () => {
  mock.reply(apiError(400, 'INVALID_REQUEST', 'speaker_count needs diarize'));
  const e = await client.transcribe({ url: 'https://example.com/a.mp3', speaker_count: 2 }).catch((x) => x);
  assert.ok(e instanceof InvalidRequestError);
  assert.equal(mock.requests.length, 1);

  mock.reset();
  mock.reply(apiError(500, 'INTERNAL_ERROR'));
  const e2 = await client.feedback('j1', { rating: 5 }).catch((x) => x);
  assert.ok(e2 instanceof InternalError);
  assert.equal(mock.requests.length, 1);
});

test('409 IDEMPOTENCY_KEY_LOCKED and 503 MAINTENANCE with Retry-After are retried', async () => {
  mock.reply(apiError(409, 'IDEMPOTENCY_KEY_LOCKED', 'in flight', {}, { 'retry-after': '0' }), job('j4', 'created'));
  const out = await client.transcribe({ url: 'https://example.com/a.mp3' });
  assert.equal(out.id, 'j4');
  assert.equal(mock.requests.length, 2);

  mock.reset();
  mock.reply(apiError(503, 'MAINTENANCE', 'paused', {}, { 'retry-after': '0' }), { status: 200, body: { delivered: true } });
  const sent = await client.testWebhook('https://example.com/hook');
  assert.equal(sent.delivered, true);
  assert.deepEqual(mock.requests[0].json, { url: 'https://example.com/hook' });
  assert.equal(mock.requests.length, 2, 'maintenance is retried even for a non-idempotent POST');

  mock.reset();
  mock.reply(apiError(503, 'MAINTENANCE', 'paused', {}, { 'retry-after': '0' }));
  const noRetry = make({ maxRetries: 0 });
  const e = await noRetry.balance().catch((x) => x);
  assert.ok(e instanceof MaintenanceError && e instanceof ServiceUnavailableError);
});

test('wait(): polls until completed, growing the interval, with onPoll', async () => {
  mock.reply(job('w1', 'created'), job('w1', 'processing'), job('w1', 'processing'), job('w1', 'completed', { result: { full_transcript: 'hi' } }));
  const seen = [];
  const done = await client.wait('w1', { pollInterval: 20, maxPollInterval: 40, onPoll: (t) => seen.push(t.status) });
  assert.equal(done.result.full_transcript, 'hi');
  assert.deepEqual(seen, ['created', 'processing', 'processing', 'completed']);
  assert.ok(mock.requests.every((r) => r.method === 'GET' && r.path === '/v1/transcribe/w1' && r.url === '/v1/transcribe/w1'));
  const gaps = mock.requests.slice(1).map((r, i) => r.at - mock.requests[i].at);
  assert.ok(gaps[0] >= 15 && gaps[2] >= 35, `gaps ${gaps}`);
});

test('wait(): a failed job throws TranscriptionFailedError with the job error code', async () => {
  mock.reply(job('w2', 'failed', { error: { code: 'URL_NOT_ACCESSIBLE', message: 'The URL could not be fetched (HTTP 403).' } }));
  const err = await client.wait('w2').catch((e) => e);
  assert.ok(err instanceof TranscriptionFailedError);
  assert.equal(err.code, 'URL_NOT_ACCESSIBLE');
  assert.equal(err.transcriptionId, 'w2');
  assert.equal(err.transcription.status, 'failed');
  assert.match(err.message, /HTTP 403/);
});

test('wait(): timeout throws WaitTimeoutError with the last status', async () => {
  mock.always(job('w3', 'processing'));
  const err = await client.wait('w3', { timeout: 120, pollInterval: 50 }).catch((e) => e);
  assert.ok(err instanceof WaitTimeoutError);
  assert.equal(err.transcription.status, 'processing');
});

test('wait(): a 429 honours Retry-After and keeps polling', async () => {
  const c = make({ maxRetries: 0 });
  mock.reply(job('w4', 'processing'), apiError(429, 'RATE_LIMIT_EXCEEDED', 'slow', {}, { 'retry-after': '1' }), job('w4', 'completed', { result: { full_transcript: 'ok' } }));
  const done = await c.wait('w4', { pollInterval: 10 });
  assert.equal(done.result.full_transcript, 'ok');
  assert.ok(mock.requests[2].at - mock.requests[1].at >= 950);
});

test('wait(): an AbortSignal stops it', async () => {
  mock.always(job('w5', 'processing'));
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error('stop')), 60);
  const err = await client.wait('w5', { pollInterval: 20, signal: ac.signal }).catch((e) => e);
  assert.equal(err.message, 'stop');
});

test('get(): json by default; srt/vtt/text with caption options as a string', async () => {
  mock.reply(job('g1', 'completed', { result: { full_transcript: 'x' } }));
  const t = await client.get('g1');
  assert.equal(t.result.full_transcript, 'x');
  assert.deepEqual(mock.requests[0].query, {});

  mock.reply({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '1\n00:00:00,000 --> 00:00:01,000\nHi\n' });
  const srt = await client.get('g1', { format: 'srt', max_words: 3, sentence_aware: false, include_speakers: true, strip_chars: ',.' });
  assert.match(srt, /-->/);
  assert.deepEqual(mock.requests[1].query, { format: 'srt', max_words: '3', sentence_aware: 'false', include_speakers: 'true', strip_chars: ',.' });

  mock.reply({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '[00:00] Hi' });
  await client.get('g1', { format: 'text', include_timestamps: true });
  assert.deepEqual(mock.requests[2].query, { format: 'text', include_timestamps: 'true' });
});

test('list(): an async iterator that follows next_cursor', async () => {
  mock.reply(
    { status: 200, body: { items: [{ id: 'a', status: 'completed' }, { id: 'b', status: 'completed' }], next_cursor: 'c1' } },
    { status: 200, body: { items: [{ id: 'c', status: 'failed' }], next_cursor: 'c2' } },
    { status: 200, body: { items: [{ id: 'd', status: 'completed' }], next_cursor: null } },
  );
  const ids = [];
  for await (const t of client.list({ limit: 2, from: new Date('2026-11-01T00:00:00Z'), order: 'desc' })) ids.push(t.id);
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
  assert.deepEqual(mock.requests.map((r) => r.query.cursor), [undefined, 'c1', 'c2']);
  assert.equal(mock.requests[0].query.from, '2026-11-01T00:00:00.000Z');
  assert.equal(mock.requests[0].query.limit, '2');
});

test('cancel, delete (204), balance, resendWebhook, feedback: method and path', async () => {
  mock.reply(
    { status: 200, body: { id: 'x', status: 'failed', error: { code: 'CANCELLED', message: 'Cancelled' }, released_cents: 0 } },
    { status: 204 },
    { status: 200, body: { balance_cents: 100, reserved_cents: 0, available_cents: 100, price_per_hour_cents: 15, auto_topup: { enabled: false, threshold_cents: 500, amount_cents: 2000 } } },
    { status: 200, body: { delivered: true, delivery_id: 'd1' } },
    { status: 200, body: { transcription_id: 'x', rating_saved: true, problem_report: null } },
  );
  const c = await client.cancel('x');
  assert.equal(c.error.code, 'CANCELLED');
  assert.equal(await client.delete('x'), undefined);
  const b = await client.balance();
  assert.equal(b.auto_topup.enabled, false);
  await client.resendWebhook('x');
  await client.feedback('x', { rating: 5 });
  assert.deepEqual(
    mock.requests.map((r) => `${r.method} ${r.path}`),
    ['POST /v1/transcribe/x/cancel', 'DELETE /v1/transcribe/x', 'GET /v1/balance', 'POST /v1/transcribe/x/webhook/resend', 'POST /v1/transcribe/x/feedback'],
  );
  assert.equal(mock.requests[0].headers['idempotency-key'], undefined, 'only upload and transcribe get a key');
  assert.deepEqual(mock.requests[4].json, { rating: 5 });
});

test('request timeout: APITimeoutError after retries of a GET', async () => {
  const c = make({ timeout: 80, maxRetries: 1 });
  mock.always('hang');
  const err = await c.balance().catch((e) => e);
  assert.ok(err instanceof APITimeoutError && err instanceof APIConnectionError);
  assert.equal(mock.requests.length, 2);
});

// ─── Upload ──────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'svx-sdk-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function uploadFlow(putHandler) {
  return [
    (req, m) => ({ status: 200, body: { upload_id: 'up-1', upload_url: `${m.url}/storage/put?sig=abc`, expires_in: 3600, method: 'PUT', headers: { 'Content-Type': 'audio/mpeg' } } }),
    putHandler ?? { status: 200, body: '' },
  ];
}

test('upload(path): presign then a streamed PUT with Content-Length, progress to 100 %, no API key sent to storage', async () => {
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 123, 7);
  const file = join(dir, 'Réunion d’équipe.mp3');
  writeFileSync(file, bytes);
  mock.reply(...uploadFlow());
  const progress = [];
  const out = await client.upload(file, { onProgress: (p) => progress.push(p) });
  assert.equal(out.upload_id, 'up-1');
  assert.equal(out.filename, 'Reunion d_equipe.mp3');
  assert.equal(out.size, bytes.length);
  const [presign, put] = mock.requests;
  assert.deepEqual(presign.json, { filename: 'Reunion d_equipe.mp3' });
  assert.match(presign.headers['idempotency-key'], UUID_RE);
  assert.equal(put.method, 'PUT');
  assert.equal(put.url, '/storage/put?sig=abc');
  assert.equal(put.headers['content-type'], 'audio/mpeg');
  assert.equal(put.headers['content-length'], String(bytes.length));
  assert.equal(put.headers['transfer-encoding'], undefined);
  assert.equal(put.headers.authorization, undefined);
  assert.ok(put.body.equals(bytes));
  assert.ok(progress.length >= 4);
  assert.deepEqual(progress.at(-1), { loaded: bytes.length, total: bytes.length, percent: 100 });
  assert.ok(progress.every((p, i) => i === 0 || p.loaded > progress[i - 1].loaded));
});

test('upload(bytes) needs a filename; Blob and stream inputs work; a stream needs size', async () => {
  await assert.rejects(client.upload(Buffer.from('abc')), /filename/);
  await assert.rejects(client.upload(Buffer.from('abc'), { filename: 'noext' }), /extension/);

  mock.reply(...uploadFlow());
  await client.upload(new Blob([Buffer.from('blobdata')]), { filename: 'clip.wav' });
  assert.equal(mock.requests[1].text, 'blobdata');

  mock.reset();
  mock.reply(...uploadFlow());
  await client.upload(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), { filename: 'clip.ogg', size: 4 });
  assert.equal(mock.requests[1].text, 'abcd');

  await assert.rejects(client.upload(Readable.from([Buffer.from('ab')]), { filename: 'clip.ogg' }), /size/);
});

test('upload: a 403 from storage is not retried; a 500 is retried for a path', async () => {
  const file = join(dir, 'a.mp3');
  writeFileSync(file, Buffer.from('hello'));
  mock.reply(...uploadFlow({ status: 403, headers: { 'content-type': 'application/xml' }, body: '<Error><Code>AccessDenied</Code></Error>' }));
  const err = await client.upload(file).catch((e) => e);
  assert.ok(err instanceof UploadFailedError);
  assert.equal(err.status, 403);
  assert.match(err.body, /AccessDenied/);
  assert.equal(mock.requests.length, 2);

  mock.reset();
  mock.reply(...uploadFlow({ status: 500, body: 'oops' }), { status: 200, body: '' });
  const out = await client.upload(file);
  assert.equal(out.upload_id, 'up-1');
  assert.equal(mock.requests.length, 3);
  assert.equal(mock.requests[2].text, 'hello');
});

test('transcribe({file}): uploads, then submits the upload_id, with upload progress', async () => {
  const file = join(dir, 'b.m4a');
  writeFileSync(file, Buffer.alloc(2048, 1));
  mock.reply(...uploadFlow(), job('t9', 'created'));
  const seen = [];
  const out = await client.transcribe({ file, language: 'en' }, { onUploadProgress: (p) => seen.push(p.percent) });
  assert.equal(out.id, 't9');
  assert.deepEqual(mock.requests[2].json, { language: 'en', upload_id: 'up-1' });
  assert.notEqual(mock.requests[0].headers['idempotency-key'], mock.requests[2].headers['idempotency-key']);
  assert.equal(seen.at(-1), 100);
});

test('safeFilename', () => {
  assert.equal(safeFilename('C:\\Users\\me\\Café “Mix”.mp3'), 'Cafe _Mix_.mp3');
  assert.equal(safeFilename('a<b>"c\'`.wav'), 'a_b__c__.wav');
  assert.equal(safeFilename('x'.repeat(300) + '.flac').length, 255);
  assert.ok(safeFilename('x'.repeat(300) + '.flac').endsWith('.flac'));
  assert.throws(() => safeFilename('README'), TypeError);
});

test('CommonJS build loads and exposes the same API', () => {
  const require = createRequire(import.meta.url);
  const cjs = require('../dist/cjs/index.js');
  assert.equal(typeof cjs.Scriptivox, 'function');
  assert.equal(cjs.default, cjs.Scriptivox);
  assert.equal(typeof cjs.verifyWebhook, 'function');
  assert.equal(typeof cjs.ZeroBalanceError, 'function');
  assert.equal(cjs.VERSION, VERSION);
});
