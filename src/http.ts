/**
 * The transport: one place that sends an API request, retries what is safe to retry, honours
 * Retry-After, and turns an error answer into the right typed error.
 */
import { APIConnectionError, APIError, APITimeoutError, ScriptivoxError, categoryForStatus } from './errors.js';
import { ERROR_CLASS_BY_CODE } from './generated/errors.js';
import { VERSION } from './version.js';

/** A Retry-After longer than this is not waited out automatically; the error is thrown instead. */
export const MAX_RETRY_AFTER_SECONDS = 60;

export interface TransportConfig {
  apiKey: string;
  baseUrl: string;
  maxRetries: number;
  timeout: number;
  fetch: typeof globalThis.fetch;
  defaultHeaders: Record<string, string>;
}

export interface SendOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  idempotencyKey?: string;
  /** Safe to repeat after a lost answer or a 5xx (GET, DELETE, a submit with an Idempotency-Key, cancel). */
  idempotent: boolean;
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
  /** Return the body as text instead of parsing JSON. */
  text?: boolean;
}

export interface SendResult<T> {
  data: T;
  status: number;
  headers: Record<string, string>;
  requestId: string | undefined;
}

export function userAgent(): string {
  const node = typeof process !== 'undefined' ? process.version : 'unknown';
  return `scriptivox-node/${VERSION} node/${node}`;
}

export function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Retry-After as seconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, (date - Date.now()) / 1000);
}

/** Exponential backoff with jitter: 0.5 s, 1 s, 2 s, … up to 8 s, ±25 %. */
export function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 8000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new ScriptivoxError('The request was aborted.');
}

/** Build the typed error for an error answer. Handles a non-JSON body (e.g. an HTML 413 from the network layer). */
export function errorFromResponse(status: number, bodyText: string, headers: Record<string, string>): APIError {
  let parsed: unknown;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    parsed = undefined;
  }
  const errorObject =
    parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'object'
      ? ((parsed as { error: Record<string, unknown> }).error ?? undefined)
      : undefined;
  const code = typeof errorObject?.code === 'string' ? errorObject.code : 'UNKNOWN_ERROR';
  const snippet = bodyText.replace(/\s+/g, ' ').trim().slice(0, 200);
  const message =
    typeof errorObject?.message === 'string'
      ? errorObject.message
      : `HTTP ${status}${snippet ? `: ${snippet}` : ''}`;
  const requestId =
    (typeof errorObject?.request_id === 'string' ? errorObject.request_id : undefined) ?? headers['x-request-id'];
  const bodyRetryAfter =
    parsed && typeof parsed === 'object' && typeof (parsed as { retry_after?: unknown }).retry_after === 'number'
      ? (parsed as { retry_after: number }).retry_after
      : undefined;
  const retryAfter = parseRetryAfter(headers['retry-after']) ?? bodyRetryAfter;
  const Cls =
    (ERROR_CLASS_BY_CODE as Record<string, (new (init: ConstructorParameters<typeof APIError>[0]) => APIError) | undefined>)[code] ??
    categoryForStatus(status);
  return new Cls({
    status,
    code,
    message,
    requestId,
    docsUrl: typeof errorObject?.docs_url === 'string' ? errorObject.docs_url : undefined,
    retryAfter,
    error: errorObject,
    headers,
  });
}

/**
 * Whether an error answer is worth another try, and after how long.
 * - 429 or 503 with Retry-After (rate limit, maintenance): the request was refused before any work,
 *   so it is retried whatever the method, after Retry-After (up to MAX_RETRY_AFTER_SECONDS).
 *   A 429 without Retry-After is the jobs-in-progress cap: retrying at once cannot help.
 * - 409 IDEMPOTENCY_KEY_LOCKED: the first request with this key is still running; retry shortly.
 * - 408 and other 5xx: only when the request is safe to repeat.
 */
export function retryDelayFor(err: APIError, idempotent: boolean, attempt: number): number | undefined {
  if (err.status === 429 || err.status === 503) {
    if (err.retryAfter !== undefined) {
      return err.retryAfter <= MAX_RETRY_AFTER_SECONDS ? err.retryAfter * 1000 : undefined;
    }
    if (err.status === 429) return undefined;
  }
  if (err.code === 'IDEMPOTENCY_KEY_LOCKED') {
    return err.retryAfter !== undefined && err.retryAfter <= MAX_RETRY_AFTER_SECONDS ? err.retryAfter * 1000 : backoffMs(attempt);
  }
  if (idempotent && (err.status === 408 || err.status >= 500)) {
    return err.retryAfter !== undefined && err.retryAfter <= MAX_RETRY_AFTER_SECONDS ? err.retryAfter * 1000 : backoffMs(attempt);
  }
  return undefined;
}

export class Transport {
  constructor(readonly config: TransportConfig) {}

  url(path: string, query?: SendOptions['query']): string {
    const url = new URL(this.config.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async send<T>(method: string, path: string, opts: SendOptions): Promise<SendResult<T>> {
    const maxRetries = opts.maxRetries ?? this.config.maxRetries;
    const timeout = opts.timeout ?? this.config.timeout;
    const url = this.url(path, opts.query);
    const headers: Record<string, string> = {
      ...this.config.defaultHeaders,
      Authorization: this.config.apiKey,
      Accept: opts.text ? 'text/plain, text/vtt, application/json' : 'application/json',
      'User-Agent': userAgent(),
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);

    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw abortReason(opts.signal);
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeout);
      const onAbort = () => controller.abort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      let response: Response;
      let text: string;
      try {
        response = await this.config.fetch(url, { method, headers, body, signal: controller.signal });
        text = await response.text();
      } catch (cause) {
        if (opts.signal?.aborted) throw abortReason(opts.signal);
        const err = timedOut
          ? new APITimeoutError(`No answer from ${method} ${path} within ${timeout} ms.`, { cause })
          : new APIConnectionError(`Could not reach the Scriptivox API (${method} ${path}): ${(cause as Error)?.message ?? cause}`, { cause });
        if (opts.idempotent && attempt < maxRetries) {
          await sleep(backoffMs(attempt), opts.signal);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      }

      const responseHeaders = headersToObject(response.headers);
      if (response.ok) {
        let data: unknown = undefined;
        if (opts.text) data = text;
        else if (text) {
          try {
            data = JSON.parse(text);
          } catch (cause) {
            throw new APIError({
              status: response.status,
              code: 'INVALID_RESPONSE',
              message: `The API answered ${method} ${path} with a body that is not JSON.`,
              requestId: responseHeaders['x-request-id'],
              headers: responseHeaders,
              error: { cause: String(cause) },
            });
          }
        }
        return { data: data as T, status: response.status, headers: responseHeaders, requestId: responseHeaders['x-request-id'] };
      }

      const err = errorFromResponse(response.status, text, responseHeaders);
      const delay = attempt < maxRetries ? retryDelayFor(err, opts.idempotent, attempt) : undefined;
      if (delay === undefined) throw err;
      await sleep(delay, opts.signal);
    }
  }
}
