// Integration tests against a real Scriptivox API (TEST: https://api-test.scriptivox.com).
//
//   SCRIPTIVOX_API_KEY        a key with a little balance (required; every test skips without it)
//   SCRIPTIVOX_BASE_URL       default https://api-test.scriptivox.com (refuses the production URL)
//   SCRIPTIVOX_EMPTY_API_KEY  optional: a key on an account with no balance (real 402 check)
//   SCRIPTIVOX_TEST_GPU=1     optional: also run one real transcription of test/fixtures/speech-en.mp3
//
// Without SCRIPTIVOX_TEST_GPU the jobs used here all fail at the file check (a link to a JSON
// document), which costs $0 and never reaches a GPU.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Scriptivox,
  InvalidApiKeyError,
  AuthenticationError,
  TranscriptionNotFoundError,
  InvalidRequestError,
  InvalidMediaFormatError,
  ZeroBalanceError,
  ConflictError,
  TranscriptionFailedError,
  TRANSCRIPTION_ERROR_CODES,
} from '../dist/esm/index.js';

const KEY = process.env.SCRIPTIVOX_API_KEY;
const BASE = process.env.SCRIPTIVOX_BASE_URL || 'https://api-test.scriptivox.com';
const EMPTY_KEY = process.env.SCRIPTIVOX_EMPTY_API_KEY;
const GPU = process.env.SCRIPTIVOX_TEST_GPU === '1';
const skip = !KEY && 'SCRIPTIVOX_API_KEY not set';
if (/\/\/api\.scriptivox\.com/.test(BASE)) throw new Error('Integration tests refuse the production API; point SCRIPTIVOX_BASE_URL at TEST.');

const REQ_ID = /^req_[0-9a-f]{16}$/;
const NOT_MEDIA = 'https://httpbin.org/json';
const SLOW = 'https://httpbin.org/delay/10';
const HOOK = 'https://httpbin.org/post';
const client = KEY ? new Scriptivox({ apiKey: KEY, baseUrl: BASE }) : null;
const made = [];
const log = (...a) => console.log('   ·', ...a);
const tmp = mkdtempSync(join(tmpdir(), 'svx-int-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('balance(): amounts, price and auto top-up', { skip }, async () => {
  const b = await client.balance();
  log('balance', JSON.stringify(b));
  for (const k of ['balance_cents', 'reserved_cents', 'available_cents', 'price_per_hour_cents']) assert.equal(typeof b[k], 'number', k);
  assert.equal(typeof b.auto_topup?.enabled, 'boolean');
  assert.ok(b.available_cents > 0, 'the test key needs a little balance');
});

test('a wrong key: InvalidApiKeyError (401) with a request id', { skip }, async () => {
  const bad = new Scriptivox({ apiKey: 'sk_live_' + '0'.repeat(48), baseUrl: BASE });
  const err = await bad.balance().catch((e) => e);
  log(err.name, err.status, err.code, err.requestId);
  assert.ok(err instanceof InvalidApiKeyError && err instanceof AuthenticationError);
  assert.equal(err.status, 401);
  assert.match(err.requestId, REQ_ID);
  assert.equal(err.headers['x-request-id'], err.requestId);
});

test('an unknown job: TranscriptionNotFoundError (404) with a request id', { skip }, async () => {
  const err = await client.get(randomUUID()).catch((e) => e);
  log(err.name, err.status, err.code, err.requestId);
  assert.ok(err instanceof TranscriptionNotFoundError);
  assert.match(err.requestId, REQ_ID);
});

test('a bad submit: InvalidRequestError (400), nothing created', { skip }, async () => {
  const err = await client.transcribe({ url: NOT_MEDIA, speaker_count: 2 }).catch((e) => e);
  log(err.name, err.status, err.code, err.requestId, '-', err.message);
  assert.ok(err instanceof InvalidRequestError);
  assert.match(err.requestId, REQ_ID);
});

test('no balance: ZeroBalanceError (402)', { skip: skip || (!EMPTY_KEY && 'SCRIPTIVOX_EMPTY_API_KEY not set') }, async () => {
  const empty = new Scriptivox({ apiKey: EMPTY_KEY, baseUrl: BASE });
  const err = await empty.transcribe({ url: NOT_MEDIA }).catch((e) => e);
  log(err.name, err.status, err.code, err.requestId);
  assert.ok(err instanceof ZeroBalanceError);
  assert.equal(err.status, 402);
});

test('upload(): an unsupported extension is refused before any bytes move', { skip }, async () => {
  const f = join(tmp, 'notes.txt');
  writeFileSync(f, 'not audio');
  const err = await client.upload(f).catch((e) => e);
  log(err.name, err.status, err.code, err.requestId);
  assert.ok(err instanceof InvalidMediaFormatError);
});

test('upload(): streams the file to storage with progress (no job is started)', { skip }, async () => {
  const progress = [];
  const file = fileURLToPath(new URL('./fixtures/speech-en.mp3', import.meta.url));
  const up = await client.upload(file, { onProgress: (p) => progress.push(p.percent) });
  log('upload', up.upload_id, up.filename, up.size, 'bytes; progress calls', progress.length, 'last', progress.at(-1));
  assert.match(up.upload_id, /^[0-9a-f-]{36}$/);
  assert.equal(progress.at(-1), 100);
});

let failedJobId;
test('URL flow: a link to a non-media file ends failed; wait() throws TranscriptionFailedError ($0, no GPU)', { skip }, async () => {
  const job = await client.transcribe({ url: NOT_MEDIA, language: 'en', webhook_url: HOOK });
  made.push(job.id);
  log('created', job.id, job.status);
  assert.equal(job.status, 'created');
  const statuses = [];
  const err = await client.wait(job.id, { pollInterval: 1000, timeout: 180_000, onPoll: (t) => statuses.push(t.status) }).catch((e) => e);
  log('polled', statuses.join(' → '), '|', err.name, err.code, '-', err.transcription?.error?.message);
  assert.ok(err instanceof TranscriptionFailedError);
  assert.ok(TRANSCRIPTION_ERROR_CODES.includes(err.code));
  assert.ok(['INVALID_MEDIA_FORMAT', 'URL_NOT_ACCESSIBLE'].includes(err.code), err.code);
  assert.equal(err.transcription.cost_cents ?? 0, 0);
  failedJobId = job.id;
});

test('the same Idempotency-Key twice returns the same job', { skip }, async () => {
  const key = `p9-sdk-${randomUUID()}`;
  const a = await client.transcribe({ url: NOT_MEDIA }, { idempotencyKey: key });
  const b = await client.transcribe({ url: NOT_MEDIA }, { idempotencyKey: key });
  made.push(a.id);
  log('first', a.id, 'second', b.id);
  assert.equal(a.id, b.id);
});

test('cancel(): a job still downloading is cancelled, and cancelling again answers the same', { skip }, async () => {
  const job = await client.transcribe({ url: SLOW });
  made.push(job.id);
  const c1 = await client.cancel(job.id);
  log('cancel', JSON.stringify(c1));
  assert.equal(c1.status, 'failed');
  assert.equal(c1.error?.code, 'CANCELLED');
  const c2 = await client.cancel(job.id);
  assert.equal(c2.error?.code, 'CANCELLED');
  const err = await client.wait(job.id, { pollInterval: 500 }).catch((e) => e);
  assert.ok(err instanceof TranscriptionFailedError);
  assert.equal(err.code, 'CANCELLED');
});

test('resendWebhook() and testWebhook(): signed deliveries reach an https endpoint', { skip }, async () => {
  assert.ok(failedJobId, 'needs the URL-flow job');
  const resent = await client.resendWebhook(failedJobId);
  log('resend', JSON.stringify({ event: resent.event, delivered: resent.delivered, response_code: resent.response_code, attempt: resent.attempt, status: resent.status }));
  assert.equal(resent.event, 'transcription.failed');
  assert.equal(resent.delivered, true);
  const tested = await client.testWebhook(HOOK);
  log('test', JSON.stringify({ event: tested.event, delivered: tested.delivered, response_code: tested.response_code }));
  assert.equal(tested.event, 'webhook.test');
  assert.equal(tested.delivered, true);
});

test('list(): an async iterator over the cursor, no repeats', { skip }, async () => {
  const ids = [];
  for await (const t of client.list({ limit: 2, status: 'failed' })) {
    assert.equal(t.status, 'failed');
    assert.equal(t.result, undefined, 'list items omit result');
    ids.push(t.id);
    if (ids.length >= 7) break;
  }
  log('listed', ids.length, 'failed jobs over', Math.ceil(ids.length / 2), 'pages');
  assert.ok(ids.length >= 3, 'needs at least two pages');
  assert.equal(new Set(ids).size, ids.length);
});

test('delete(): a finished job is deleted (twice is fine) and then not found', { skip }, async () => {
  assert.ok(failedJobId);
  await client.delete(failedJobId);
  await client.delete(failedJobId);
  const err = await client.get(failedJobId).catch((e) => e);
  log('after delete:', err.name, err.code);
  assert.ok(err instanceof TranscriptionNotFoundError);
});

test('delete(): a job still running answers ConflictError (409)', { skip }, async () => {
  const job = await client.transcribe({ url: SLOW });
  made.push(job.id);
  const err = await client.delete(job.id).catch((e) => e);
  log(err.name, err.status, err.code, '-', err.message);
  assert.ok(err instanceof ConflictError);
  await client.cancel(job.id).catch(() => {});
});

test('GPU: transcribe a local file, wait, export SRT/VTT/text', { skip: skip || (!GPU && 'SCRIPTIVOX_TEST_GPU is not 1') }, async () => {
  const file = fileURLToPath(new URL('./fixtures/speech-en.mp3', import.meta.url));
  let last = -1;
  const job = await client.transcribe({ file, language: 'en' }, { onUploadProgress: (p) => (last = p.percent) });
  made.push(job.id);
  log('created', job.id, 'upload progress', last);
  const statuses = [];
  const done = await client.wait(job.id, { onPoll: (t) => statuses.push(t.status) });
  log('polled', statuses.join(' → '));
  log('transcript:', JSON.stringify(done.result.full_transcript));
  log('duration', done.audio_duration_seconds, 's, cost', done.cost_cents, 'cents');
  assert.match(done.result.full_transcript.toLowerCase(), /scriptivox|software|development|upload|caption/);
  const srt = await client.get(job.id, { format: 'srt', max_words: 3 });
  const vtt = await client.get(job.id, { format: 'vtt' });
  const text = await client.get(job.id, { format: 'text', include_timestamps: true });
  log('srt first cue:', JSON.stringify(srt.split('\n\n')[0]));
  log('vtt head:', JSON.stringify(vtt.slice(0, 40)));
  log('text:', JSON.stringify(text.slice(0, 80)));
  assert.match(srt, /^1\r?\n\d\d:\d\d:\d\d,\d{3} --> /);
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.match(text, /^\[\d\d:\d\d\]/);
});

after(() => {
  if (made.length) console.log(`   · TEST jobs made by this run: ${made.join(', ')}`);
});
