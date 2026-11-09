/**
 * Webhook signature check. The signing formula (platform.scriptivox.com/docs/webhooks):
 *   signature = hex(HMAC-SHA256(secret, `${X-Scriptivox-Timestamp}.${raw body}`))
 * where secret is the key's whole `whsec_…` string. A timestamp more than 5 minutes from now is refused.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookVerificationError } from './errors.js';
import type { WebhookEvent } from './types.js';

export const SIGNATURE_HEADER = 'x-scriptivox-signature';
export const TIMESTAMP_HEADER = 'x-scriptivox-timestamp';
export const DELIVERY_HEADER = 'x-scriptivox-delivery';
export const ATTEMPT_HEADER = 'x-scriptivox-attempt';
/** Seconds a webhook's timestamp may be away from now. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Anything headers come in: a fetch Headers object, Node's req.headers (lower-case keys, values may
 * be arrays), or a plain object in any case.
 */
export type HeadersLike =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>
  | Iterable<[string, string]>;

export function readHeader(headers: HeadersLike, name: string): string | undefined {
  const wanted = name.toLowerCase();
  if (typeof (headers as { get?: unknown }).get === 'function' && !(headers instanceof Map)) {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  if (typeof (headers as Iterable<unknown>)[Symbol.iterator] === 'function' && !Array.isArray(headers)) {
    for (const [key, value] of headers as Iterable<[string, string]>) {
      if (key.toLowerCase() === wanted) return value;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

export interface VerifyWebhookOptions {
  /** Seconds the timestamp may be away from now (default 300). */
  tolerance?: number;
  /** "Now" in Unix seconds, for tests. */
  now?: number;
}

/** The signature the API would send for this body and timestamp. */
export function computeSignature(rawBody: string | Uint8Array, timestamp: string, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(`${timestamp}.`);
  hmac.update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody);
  return hmac.digest('hex');
}

/**
 * Check that a webhook request came from Scriptivox and is fresh, then return its parsed event.
 * Pass the body exactly as received (string or Buffer), never re-serialised JSON.
 * Throws WebhookVerificationError; answer such a request with 400.
 * Deduplicate on the X-Scriptivox-Delivery header: the same event can arrive more than once.
 */
export function verifyWebhook(
  rawBody: string | Uint8Array,
  headers: HeadersLike,
  secret: string,
  options: VerifyWebhookOptions = {},
): WebhookEvent {
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    throw new TypeError(
      'verifyWebhook needs the raw request body (string or Buffer), not parsed JSON: re-serialising changes the bytes and the signature.',
    );
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError("verifyWebhook needs the key's webhook signing secret (whsec_…).");
  }
  const signature = readHeader(headers, SIGNATURE_HEADER);
  const timestamp = readHeader(headers, TIMESTAMP_HEADER);
  if (!signature || !timestamp) {
    throw new WebhookVerificationError('missing_header', 'Missing X-Scriptivox-Signature or X-Scriptivox-Timestamp header.');
  }
  if (!/^\d+$/.test(timestamp.trim())) {
    throw new WebhookVerificationError('invalid_timestamp', 'X-Scriptivox-Timestamp is not a Unix time in seconds.');
  }
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp.trim())) > tolerance) {
    throw new WebhookVerificationError(
      'timestamp_outside_tolerance',
      `The webhook's timestamp is more than ${tolerance} s from now: refused as a possible replay.`,
    );
  }
  const expected = Buffer.from(computeSignature(rawBody, timestamp.trim(), secret), 'utf8');
  const received = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new WebhookVerificationError('signature_mismatch', 'The webhook signature does not match: wrong secret, or the body was changed.');
  }
  try {
    return JSON.parse(typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8')) as WebhookEvent;
  } catch {
    throw new WebhookVerificationError('invalid_json', 'The webhook body is not JSON.');
  }
}
