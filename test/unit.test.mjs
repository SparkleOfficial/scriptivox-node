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
  BadRequestError,
  UrlNotAccessibleError,
  LinkCheckUnavailableError,
  SourceExpiredError,
  ConflictError,
  TranscriptionFailedError,
  WaitTimeoutError,
  APITimeoutError,
  APIConnectionError,
  UploadFailedError,
  API_ERROR_CODES,
  ERROR_CLASS_BY_CODE,
  TRANSCRIPTION_ERROR_CODES,
  safeFilename,
  status,
  VERSION,
} from '../dist/esm/index.js';
import { retryDelayFor } from '../dist/esm/http.js';
import { nextPollDelay } from '../dist/esm/client.js';
import * as generatedErrors from '../dist/esm/generated/errors.js';

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

test('transcribeAgain(id, options): source_transcription_id with the call\'s own options; exactly one source', async () => {
  mock.reply(job('j9', 'created'));
  const out = await client.transcribeAgain('b2c3d4e5-f6a7-8901-bcde-f12345678901', { language: 'es', diarize: true }, { idempotencyKey: 'again-1' });
  assert.deepEqual(out, { id: 'j9', status: 'created' });
  const r = mock.requests[0];
  assert.equal(r.path, '/v1/transcribe');
  assert.deepEqual(r.json, { language: 'es', diarize: true, source_transcription_id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901' });
  assert.equal(r.headers['idempotency-key'], 'again-1');
  mock.reset();
  mock.reply(job('j10', 'created'));
  await client.transcribe({ source_transcription_id: 's1' });
  assert.deepEqual(mock.requests[0].json, { source_transcription_id: 's1' }, 'nothing added: the options are the call\'s own');
  await assert.rejects(client.transcribe({ source_transcription_id: 's1', url: 'https://x/a.mp3' }), TypeError);
  await assert.rejects(client.transcribe({ source_transcription_id: 's1', upload_id: 'u' }), TypeError);
});

test('409 SOURCE_EXPIRED: SourceExpiredError (a ConflictError) at once, not retried', async () => {
  mock.reply(apiError(409, 'SOURCE_EXPIRED', 'The audio of transcription s1 was deleted 24 hours after that job ended, so it cannot be transcribed again.', { transcription_id: 's1', expired_at: '2026-11-16T10:00:00.000Z' }));
  const err = await client.transcribeAgain('s1', { language: 'fr' }).catch((e) => e);
  assert.ok(err instanceof SourceExpiredError);
  assert.ok(err instanceof ConflictError);
  assert.equal(err.code, 'SOURCE_EXPIRED');
  assert.equal(err.status, 409);
  assert.equal(err.error.transcription_id, 's1');
  assert.equal(mock.requests.length, 1);
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

test('a social post refused at once: UrlNotAccessibleError with reason and platform, not retried', async () => {
  mock.reply(apiError(400, 'URL_NOT_ACCESSIBLE', 'This link could not be checked. It may be private, deleted or not available in your region.', { reason: 'link_not_verifiable', platform: 'instagram' }));
  const err = await client.transcribe({ url: 'https://www.instagram.com/p/C0nT3stPr1v/' }).catch((e) => e);
  assert.ok(err instanceof UrlNotAccessibleError);
  assert.ok(err instanceof BadRequestError);
  assert.equal(err.code, 'URL_NOT_ACCESSIBLE');
  assert.equal(err.error.reason, 'link_not_verifiable');
  assert.equal(err.error.platform, 'instagram');
  assert.equal(mock.requests.length, 1);
});

test('503 LINK_CHECK_UNAVAILABLE: retried after a short Retry-After with the same Idempotency-Key, thrown when it is 600 s', async () => {
  mock.reply(
    apiError(503, 'LINK_CHECK_UNAVAILABLE', 'This link could not be checked right now. Nothing was created or charged. Try again in a minute.', { reason: 'link_check_failed', platform: 'tiktok' }, { 'retry-after': '1' }),
    { status: 200, body: { id: 'j1', status: 'created' } },
  );
  const ok = await client.transcribe({ url: 'https://www.tiktok.com/@someone/video/1' });
  assert.equal(ok.id, 'j1');
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0].headers['idempotency-key'], mock.requests[1].headers['idempotency-key']);

  mock.reset();
  mock.reply(apiError(503, 'LINK_CHECK_UNAVAILABLE', 'Link checks are busy right now. Please wait a few minutes and try again.', { reason: 'verify_rate_limited', platform: 'tiktok' }, { 'retry-after': '600' }));
  const busy = await client.transcribe({ url: 'https://www.tiktok.com/@someone/video/1' }).catch((e) => e);
  assert.ok(busy instanceof LinkCheckUnavailableError);
  assert.ok(busy instanceof ServiceUnavailableError);
  assert.equal(busy.retryAfter, 600);
  assert.equal(busy.error.reason, 'verify_rate_limited');
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

test('every code in the OpenAPI document has a class; 32 sync and 14 async codes', () => {
  assert.equal(API_ERROR_CODES.length, 32);
  assert.equal(TRANSCRIPTION_ERROR_CODES.length, 14);
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

// ─── Service status (service status Phase 8) ────────────────────────────────

const STATUS_URL = 'https://api.scriptivox.com/v1/status';
const OPERATIONAL = {
  status: 'operational',
  accepting_new_jobs: true,
  maintenance: null,
  still_working: ['POST /v1/upload', 'POST /v1/transcribe', 'GET /v1/balance'],
  upcoming: [],
  checked_at: '2026-11-21T10:00:00.000Z',
  status_page: 'https://status.scriptivox.com',
};
const UNKNOWN = { ...OPERATIONAL, status: 'unknown', accepting_new_jobs: null, still_working: null, upcoming: null };
const PAUSED = {
  ...OPERATIONAL,
  status: 'maintenance',
  accepting_new_jobs: false,
  maintenance: {
    paused: [{ scope: 'upload', name: 'New uploads and transcriptions', message: 'Planned upgrade.', routes: ['POST /v1/upload', 'POST /v1/transcribe'], back_by: '2026-11-21T10:40:00.000Z' }],
    retry_after_seconds: 2400,
  },
  still_working: ['GET /v1/balance'],
};
const maintenance503 = (extra, retryAfter = '300') =>
  apiError(503, 'MAINTENANCE', 'New uploads and transcriptions are briefly paused for maintenance.', { scope: 'upload', status_url: STATUS_URL, back_by: null, ...extra }, { 'retry-after': retryAfter });

test('client.status(): GET /v1/status with no Authorization header; the body comes back as the API sent it', async () => {
  mock.reply({ status: 200, body: PAUSED });
  const s = await client.status();
  assert.deepEqual(s, PAUSED);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].method, 'GET');
  assert.equal(mock.requests[0].url, '/v1/status');
  assert.equal(mock.requests[0].headers.authorization, undefined, 'no key is sent');
  assert.match(mock.requests[0].headers['user-agent'], /^scriptivox-node\//);
});

test('status(): no client and no key needed; never sends Authorization, even from defaultHeaders; a /v1 base URL works', async () => {
  const saved = process.env.SCRIPTIVOX_API_KEY;
  delete process.env.SCRIPTIVOX_API_KEY;
  try {
    mock.reply({ status: 200, body: OPERATIONAL });
    const s = await status({ baseUrl: mock.url + '/v1/', defaultHeaders: { authorization: 'sk_live_should_not_go', 'X-Trace': 't1' } });
    assert.deepEqual(s, OPERATIONAL);
    assert.equal(mock.requests[0].url, '/v1/status');
    assert.equal(mock.requests[0].headers.authorization, undefined);
    assert.equal(mock.requests[0].headers['x-trace'], 't1');

    const savedBase = process.env.SCRIPTIVOX_BASE_URL;
    process.env.SCRIPTIVOX_BASE_URL = mock.url;
    mock.reply({ status: 200, body: UNKNOWN });
    const u = await status();
    process.env.SCRIPTIVOX_BASE_URL = savedBase ?? '';
    if (savedBase === undefined) delete process.env.SCRIPTIVOX_BASE_URL;
    assert.equal(u.status, 'unknown');
    assert.equal(u.accepting_new_jobs, null, '"could not check" stays null, never turned into true or false');
    assert.equal(u.still_working, null);
  } finally {
    if (saved !== undefined) process.env.SCRIPTIVOX_API_KEY = saved;
  }
});

test('status(): no answer at all throws APIConnectionError; it is never turned into a status', async () => {
  const dead = await startMock();
  const deadUrl = dead.url;
  await dead.close();
  const err = await status({ baseUrl: deadUrl, maxRetries: 0 }).catch((e) => e);
  assert.ok(err instanceof APIConnectionError, String(err));
  mock.reply({ status: 502, body: 'Bad gateway' }, { status: 200, body: OPERATIONAL });
  const s = await status({ baseUrl: mock.url, maxRetries: 1 });
  assert.equal(s.status, 'operational', 'a 5xx is retried like any safe GET');
  assert.equal(mock.requests.length, 2);
});

test('MaintenanceError: scope, statusUrl and backBy from the answer; thrown at once with Retry-After 300', async () => {
  mock.reply(maintenance503({}));
  const err = await client.transcribe({ url: 'https://example.com/a.mp3' }).catch((e) => e);
  assert.ok(err instanceof MaintenanceError);
  assert.ok(err instanceof ServiceUnavailableError && err instanceof APIError);
  assert.equal(err.code, 'MAINTENANCE');
  assert.equal(err.status, 503);
  assert.equal(err.scope, 'upload');
  assert.equal(err.statusUrl, STATUS_URL);
  assert.equal(err.backBy, null);
  assert.equal(err.retryAfter, 300);
  assert.equal(mock.requests.length, 1, 'a 5-minute pause is not slept on inside the call');

  mock.reset();
  mock.reply(maintenance503({ scope: 'link', back_by: '2026-11-21T10:40:00.000Z' }, '2400'));
  const timed = await client.transcribe({ url: 'https://www.tiktok.com/@a/video/1' }).catch((e) => e);
  assert.equal(timed.scope, 'link');
  assert.equal(timed.backBy, '2026-11-21T10:40:00.000Z');
  assert.equal(timed.retryAfter, 2400);
  assert.equal(mock.requests.length, 1);

  mock.reset();
  mock.reply(apiError(503, 'MAINTENANCE', 'paused', {}, { 'retry-after': '300' }));
  const older = await client.balance().catch((e) => e);
  assert.ok(older instanceof MaintenanceError);
  assert.equal(older.scope, undefined, 'an answer without the field leaves it undefined');
  assert.equal(older.statusUrl, undefined);
  assert.equal(older.backBy, null, 'no time set');
});

test('MaintenanceError is exported once, from the hand-written module, and is the class for MAINTENANCE', () => {
  assert.equal(ERROR_CLASS_BY_CODE.MAINTENANCE, MaintenanceError);
  assert.equal('MaintenanceError' in generatedErrors, false, 'the generated module maps to it and does not define its own');
  assert.ok(API_ERROR_CODES.includes('MAINTENANCE'));
});

test('retries: a maintenance Retry-After of 60 s (a back_by under a minute away) is slept on; longer ones are thrown', () => {
  const at = (retryAfter) => new MaintenanceError({ status: 503, code: 'MAINTENANCE', message: 'paused', retryAfter });
  assert.equal(retryDelayFor(at(60), false, 0), 60_000);
  assert.equal(retryDelayFor(at(61), false, 0), undefined);
  assert.equal(retryDelayFor(at(300), true, 0), undefined);
  assert.equal(retryDelayFor(at(3600), true, 0), undefined);
});

test('wait(): reads paused for maintenance (the job carries on) are waited out, then polling goes on', async () => {
  const c = make({ maxRetries: 0 });
  mock.reply(
    job('w6', 'processing'),
    apiError(503, 'MAINTENANCE', 'Paused for a planned upgrade.', { scope: 'global', status_url: STATUS_URL, back_by: null }, { 'retry-after': '1' }),
    job('w6', 'completed', { result: { full_transcript: 'ok' } }),
  );
  const done = await c.wait('w6', { pollInterval: 10 });
  assert.equal(done.result.full_transcript, 'ok');
  assert.ok(mock.requests[2].at - mock.requests[1].at >= 950, 'waited the Retry-After');

  mock.reset();
  mock.reply(job('w7', 'processing'), apiError(503, 'MAINTENANCE', 'Paused.', { scope: 'global' }, { 'retry-after': '300' }));
  const err = await c.wait('w7', { pollInterval: 10, timeout: 2_000 }).catch((e) => e);
  assert.ok(err instanceof MaintenanceError, 'a pause longer than the time left is thrown');
  assert.equal(err.scope, 'global');
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
  assert.equal(err.helpId, undefined);
  assert.equal(err.docsUrl, undefined);
});

test('help_id: an error answer and a failed job carry their help page id and address', async () => {
  mock.reply(apiError(400, 'URL_NOT_ACCESSIBLE', 'This YouTube video is age-restricted, so its audio can\'t be fetched.', {
    reason: 'link_age_restricted', help_id: 'social-post-unavailable', docs_url: 'https://www.scriptivox.com/errors/social-post-unavailable',
  }));
  const err = await client.transcribe({ url: 'https://www.youtube.com/watch?v=0000000000a' }).catch((e) => e);
  assert.ok(err instanceof UrlNotAccessibleError);
  assert.equal(err.helpId, 'social-post-unavailable');
  assert.equal(err.docsUrl, 'https://www.scriptivox.com/errors/social-post-unavailable');
  mock.reply(job('w4', 'failed', { error: { code: 'URL_NOT_ACCESSIBLE', message: 'The file is not shared.', help_id: 'drive-not-shared', docs_url: 'https://www.scriptivox.com/errors/drive-not-shared' } }));
  const failed = await client.wait('w4').catch((e) => e);
  assert.ok(failed instanceof TranscriptionFailedError);
  assert.equal(failed.helpId, 'drive-not-shared');
  assert.equal(failed.docsUrl, 'https://www.scriptivox.com/errors/drive-not-shared');
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

test('wait(): an unfinished job\'s Retry-After longer than its own interval is waited out (database efficiency Phase 24)', async () => {
  const ra = (id, status, seconds) => ({ status: 200, headers: { 'retry-after': String(seconds) }, body: { id, status } });
  mock.reply(ra('w8', 'created', 1), ra('w8', 'processing', 1), job('w8', 'completed', { result: { full_transcript: 'ok' } }));
  // pollInterval 20 ms: without the header the polls would come 20 ms and 30 ms apart.
  const done = await client.wait('w8', { pollInterval: 20 });
  assert.equal(done.result.full_transcript, 'ok');
  const gaps = mock.requests.slice(1).map((r, i) => r.at - mock.requests[i].at);
  assert.ok(gaps.every((g) => g >= 950 && g < 2_500), `gaps ${gaps}`);
});

test('wait(): never polls sooner than its own interval, whatever Retry-After says; a set maxPollInterval and 60 s cap it', async () => {
  const ra = (id, status, seconds) => ({ status: 200, headers: { 'retry-after': String(seconds) }, body: { id, status } });
  mock.reply(ra('w9', 'processing', 0), job('w9', 'completed', { result: { full_transcript: 'ok' } }));
  await client.wait('w9', { pollInterval: 300 });
  const gap = mock.requests[1].at - mock.requests[0].at;
  assert.ok(gap >= 280, `gap ${gap}: sooner than the interval`);
  mock.reset();
  mock.reply(ra('w9b', 'processing', 20), job('w9b', 'completed', { result: { full_transcript: 'ok' } }));
  await client.wait('w9b', { maxPollInterval: 100 });
  const capped = mock.requests[1].at - mock.requests[0].at;
  assert.ok(capped >= 90 && capped < 1_000, `capped ${capped}`);
  assert.equal(nextPollDelay(20, 2_000, undefined), 20_000);
  assert.equal(nextPollDelay(3, 2_000, undefined), 3_000);
  assert.equal(nextPollDelay(3, 10_000, undefined), 10_000);
  assert.equal(nextPollDelay(0, 2_000, undefined), 2_000);
  assert.equal(nextPollDelay(900, 2_000, undefined), 60_000);
  assert.equal(nextPollDelay(20, 2_000, 5_000), 5_000);
  assert.equal(nextPollDelay(undefined, 4_500, undefined), 4_500);
  assert.equal(nextPollDelay(Number.NaN, 4_500, undefined), 4_500);
});

test('wait(): a Retry-After longer than the time left ends the wait with WaitTimeoutError', async () => {
  mock.always({ status: 200, headers: { 'retry-after': '20' }, body: { id: 'w10', status: 'processing' } });
  const err = await client.wait('w10', { timeout: 1_000 }).catch((e) => e);
  assert.ok(err instanceof WaitTimeoutError);
  assert.equal(mock.requests.length, 1);
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
  assert.equal(typeof cjs.status, 'function');
  assert.equal(cjs.ERROR_CLASS_BY_CODE.MAINTENANCE, cjs.MaintenanceError);
  const e = new cjs.MaintenanceError({ status: 503, code: 'MAINTENANCE', message: 'm', error: { scope: 'global', status_url: STATUS_URL, back_by: null } });
  assert.ok(e instanceof cjs.ServiceUnavailableError && e instanceof cjs.APIError);
  assert.deepEqual([e.scope, e.statusUrl, e.backBy], ['global', STATUS_URL, null]);
  assert.equal(cjs.VERSION, VERSION);
});
