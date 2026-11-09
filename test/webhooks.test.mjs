// verifyWebhook against fixed vectors (computed outside the SDK) and the failure cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { verifyWebhook, computeSignature, WebhookVerificationError, Scriptivox } from '../dist/esm/index.js';

const fixtures = new URL('./fixtures/', import.meta.url);
const vectors = readdirSync(fixtures)
  .filter((f) => f.startsWith('webhook-vectors') && f.endsWith('.json'))
  .flatMap((f) => JSON.parse(readFileSync(new URL(f, fixtures), 'utf8')).vectors.map((v) => ({ ...v, file: f })));

const reason = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof WebhookVerificationError, `expected WebhookVerificationError, got ${e}`);
    return e.reason;
  }
  assert.fail('did not throw');
};

test('fixtures are present', () => {
  assert.ok(vectors.length >= 1);
});

for (const v of vectors) {
  const now = Number(v.timestamp) + 10;
  const headers = { 'X-Scriptivox-Signature': v.signature, 'X-Scriptivox-Timestamp': v.timestamp };

  test(`${v.file}: valid signature verifies and returns the event (string, Buffer, Headers, req.headers, Map)`, () => {
    const event = verifyWebhook(v.body, headers, v.secret, { now });
    assert.deepEqual(event, JSON.parse(v.body));
    assert.deepEqual(verifyWebhook(Buffer.from(v.body, 'utf8'), headers, v.secret, { now }), event);
    assert.deepEqual(verifyWebhook(v.body, new Headers(headers), v.secret, { now }), event);
    const nodeStyle = { 'x-scriptivox-signature': [v.signature], 'x-scriptivox-timestamp': v.timestamp, 'content-type': 'application/json' };
    assert.deepEqual(verifyWebhook(v.body, nodeStyle, v.secret, { now }), event);
    assert.deepEqual(verifyWebhook(v.body, new Map(Object.entries(headers)), v.secret, { now }), event);
    assert.equal(computeSignature(v.body, v.timestamp, v.secret), v.signature);
    const client = new Scriptivox({ apiKey: 'sk_live_x' });
    assert.deepEqual(client.verifyWebhook(v.body, headers, v.secret, { now }), event);
  });

  test(`${v.file}: a changed body, a wrong secret or a re-serialised body fail`, () => {
    assert.equal(reason(() => verifyWebhook(v.body.replace('completed', 'c0mpleted'), headers, v.secret, { now })), 'signature_mismatch');
    assert.equal(reason(() => verifyWebhook(v.body, headers, v.secret + 'x', { now })), 'signature_mismatch');
    assert.equal(reason(() => verifyWebhook(v.body, headers, v.secret.replace('whsec_', ''), { now })), 'signature_mismatch');
    const reserialised = JSON.stringify(JSON.parse(v.body), null, 2);
    assert.equal(reason(() => verifyWebhook(reserialised, headers, v.secret, { now })), 'signature_mismatch');
    assert.throws(() => verifyWebhook(JSON.parse(v.body), headers, v.secret, { now }), TypeError);
  });

  test(`${v.file}: the 5-minute window`, () => {
    const ts = Number(v.timestamp);
    assert.doesNotThrow(() => verifyWebhook(v.body, headers, v.secret, { now: ts + 300 }));
    assert.doesNotThrow(() => verifyWebhook(v.body, headers, v.secret, { now: ts - 300 }));
    assert.equal(reason(() => verifyWebhook(v.body, headers, v.secret, { now: ts + 301 })), 'timestamp_outside_tolerance');
    assert.equal(reason(() => verifyWebhook(v.body, headers, v.secret, { now: ts - 301 })), 'timestamp_outside_tolerance');
    assert.doesNotThrow(() => verifyWebhook(v.body, headers, v.secret, { now: ts + 900, tolerance: 1000 }));
  });
}

test('missing or malformed headers', () => {
  const secret = 'whsec_' + 'ab'.repeat(32);
  const body = '{"event":"webhook.test","test":true,"message":"hi"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  assert.equal(verifyWebhook(body, { 'x-scriptivox-signature': sig, 'x-scriptivox-timestamp': ts }, secret).event, 'webhook.test');
  assert.equal(verifyWebhook(body, { 'x-scriptivox-signature': sig.toUpperCase(), 'x-scriptivox-timestamp': ts }, secret).event, 'webhook.test');
  assert.equal(reason(() => verifyWebhook(body, { 'x-scriptivox-timestamp': ts }, secret)), 'missing_header');
  assert.equal(reason(() => verifyWebhook(body, { 'x-scriptivox-signature': sig }, secret)), 'missing_header');
  assert.equal(reason(() => verifyWebhook(body, { 'x-scriptivox-signature': sig, 'x-scriptivox-timestamp': '12a' }, secret)), 'invalid_timestamp');
  assert.equal(reason(() => verifyWebhook(body, { 'x-scriptivox-signature': 'abc', 'x-scriptivox-timestamp': ts }, secret)), 'signature_mismatch');
  assert.throws(() => verifyWebhook(body, { 'x-scriptivox-signature': sig, 'x-scriptivox-timestamp': ts }, ''), TypeError);
  const notJson = 'not json';
  const sig2 = createHmac('sha256', secret).update(`${ts}.${notJson}`).digest('hex');
  assert.equal(reason(() => verifyWebhook(notJson, { 'x-scriptivox-signature': sig2, 'x-scriptivox-timestamp': ts }, secret)), 'invalid_json');
});
