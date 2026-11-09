import { randomUUID } from 'node:crypto';
import { RateLimitError, ScriptivoxError, TranscriptionFailedError, WaitTimeoutError } from './errors.js';
import { Transport, sleep } from './http.js';
import { putFile, resolveSource, safeFilename } from './upload.js';
import { verifyWebhook, type HeadersLike, type VerifyWebhookOptions } from './webhooks.js';
import type {
  Balance,
  ClientOptions,
  CompletedTranscription,
  ExportFormat,
  ExportOptions,
  FeedbackRequest,
  FeedbackResult,
  FileInput,
  IdempotentRequestOptions,
  ListParams,
  RequestOptions,
  TranscribeOptions,
  TranscribeParams,
  Transcription,
  TranscriptionCancelled,
  TranscriptionCreated,
  TranscriptionPage,
  TranscriptionSummary,
  Upload,
  UploadOptions,
  UploadResult,
  WaitOptions,
  WebhookEvent,
  WebhookSendResult,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://api.scriptivox.com';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_WAIT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_POLL_MS = 10_000;

const env = (name: string): string | undefined =>
  typeof process !== 'undefined' && process.env ? process.env[name] || undefined : undefined;

const TRANSCRIPTION_OPTION_KEYS = ['language', 'diarize', 'speaker_count', 'align', 'webhook_url'] as const;

function pathId(id: string): string {
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('A transcription id is required.');
  return encodeURIComponent(id);
}

function isoOrUndefined(value: string | Date | undefined): string | undefined {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * The Scriptivox API client.
 *
 *   const client = new Scriptivox(); // reads SCRIPTIVOX_API_KEY
 *   const job = await client.transcribe({ file: './meeting.mp3', language: 'en' });
 *   const done = await client.wait(job.id);
 *   console.log(done.result.full_transcript);
 */
export class Scriptivox {
  private readonly transport: Transport;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? env('SCRIPTIVOX_API_KEY');
    if (!apiKey) {
      throw new ScriptivoxError('No API key: pass { apiKey } or set the SCRIPTIVOX_API_KEY environment variable.');
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new ScriptivoxError('No fetch available: use Node 18 or newer, or pass { fetch }.');
    }
    const baseUrl = (options.baseUrl ?? env('SCRIPTIVOX_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '');
    this.transport = new Transport({
      apiKey,
      baseUrl,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      fetch: fetchImpl.bind(globalThis),
      defaultHeaders: options.defaultHeaders ?? {},
    });
  }

  /** The API base URL this client talks to (without /v1). */
  get baseUrl(): string {
    return this.transport.config.baseUrl;
  }

  // ─── Upload ────────────────────────────────────────────────────────────────

  /**
   * Upload a local file (POST /v1/upload, then a streamed PUT to the presigned URL) and return its
   * upload_id for transcribe({ upload_id }). Large files are streamed, never read into memory.
   */
  async upload(file: FileInput, options: UploadOptions = {}): Promise<UploadResult> {
    const source = await resolveSource(file, options.size);
    const rawName = options.filename ?? source.name;
    if (!rawName) {
      throw new TypeError('Uploading bytes or a stream needs a filename with an extension: pass { filename: "audio.mp3" }.');
    }
    const filename = safeFilename(rawName);
    const { data: upload } = await this.transport.send<Upload>('POST', '/v1/upload', {
      body: { filename },
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      idempotent: true,
      signal: options.signal,
      timeout: options.timeout,
      maxRetries: options.maxRetries,
    });
    if (upload.method && upload.method.toUpperCase() !== 'PUT') {
      throw new ScriptivoxError(`The API asked for an upload method this SDK does not know: ${upload.method}.`);
    }
    await putFile(upload.upload_url, upload.headers ?? {}, source, {
      maxRetries: options.maxRetries ?? this.transport.config.maxRetries,
      onProgress: options.onProgress,
      signal: options.signal,
    });
    return { upload_id: upload.upload_id, filename, size: source.size };
  }

  // ─── Transcribe ────────────────────────────────────────────────────────────

  /**
   * Start a transcription from a public `url`, a local `file` (uploaded first), or an earlier
   * `upload_id`. Resolves as soon as the job is accepted (`status: "created"`); call wait(id) next.
   * Every call sends an Idempotency-Key, so the SDK's own retries never create a second job.
   */
  async transcribe(params: TranscribeParams, options: TranscribeOptions = {}): Promise<TranscriptionCreated> {
    const sources = (['url', 'file', 'upload_id'] as const).filter((k) => (params as unknown as Record<string, unknown>)[k] !== undefined);
    if (sources.length !== 1) {
      throw new TypeError('transcribe() needs exactly one of url, file or upload_id.');
    }
    const body: Record<string, unknown> = {};
    for (const key of TRANSCRIPTION_OPTION_KEYS) {
      if (params[key] !== undefined) body[key] = params[key];
    }
    if (params.url !== undefined) {
      body.url = params.url;
    } else if (params.upload_id !== undefined) {
      body.upload_id = params.upload_id;
    } else {
      const uploaded = await this.upload(params.file as FileInput, {
        filename: params.filename,
        size: params.size,
        onProgress: options.onUploadProgress,
        signal: options.signal,
        timeout: options.timeout,
        maxRetries: options.maxRetries,
      });
      body.upload_id = uploaded.upload_id;
    }
    const { data } = await this.transport.send<TranscriptionCreated>('POST', '/v1/transcribe', {
      body,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      idempotent: true,
      signal: options.signal,
      timeout: options.timeout,
      maxRetries: options.maxRetries,
    });
    return data;
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  /**
   * GET /v1/transcribe/{id}. Without a format (or format "json") the job object; with
   * format "srt" | "vtt" | "text" the caption or text file as a string (the job must be completed).
   */
  get(id: string, options?: { format?: 'json' } & RequestOptions): Promise<Transcription>;
  get(id: string, options: { format: ExportFormat } & ExportOptions & RequestOptions): Promise<string>;
  async get(
    id: string,
    options: ({ format?: 'json' | ExportFormat } & ExportOptions & RequestOptions) = {},
  ): Promise<Transcription | string> {
    const { signal, timeout, maxRetries, format, include_speakers, ...rest } = options;
    const exporting = format !== undefined && format !== 'json';
    const query: Record<string, string | number | boolean | undefined> = exporting ? { format, ...rest } : {};
    if (exporting && include_speakers !== undefined) query.include_speakers = String(include_speakers);
    const { data } = await this.transport.send<Transcription | string>('GET', `/v1/transcribe/${pathId(id)}`, {
      query,
      idempotent: true,
      text: exporting,
      signal,
      timeout,
      maxRetries,
    });
    return data;
  }

  /**
   * Poll until the job ends. Resolves with the completed job; a failed job throws
   * TranscriptionFailedError (its `code` is the job's error.code, e.g. URL_NOT_ACCESSIBLE).
   * The wait between polls starts at 2 s and grows to 10 s; a 429 waits out its Retry-After.
   */
  async wait(id: string, options: WaitOptions = {}): Promise<CompletedTranscription> {
    const timeoutMs = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const maxInterval = options.maxPollInterval ?? DEFAULT_MAX_POLL_MS;
    let interval = Math.min(options.pollInterval ?? DEFAULT_POLL_MS, maxInterval);
    const deadline = Date.now() + timeoutMs;
    let last: Transcription | undefined;

    for (;;) {
      let job: Transcription;
      try {
        job = await this.get(id, { signal: options.signal });
      } catch (err) {
        if (err instanceof RateLimitError && err.retryAfter !== undefined && Date.now() + err.retryAfter * 1000 < deadline) {
          await sleep(err.retryAfter * 1000, options.signal);
          continue;
        }
        throw err;
      }
      last = job;
      options.onPoll?.(job);
      if (job.status === 'completed') return job as CompletedTranscription;
      if (job.status === 'failed') throw new TranscriptionFailedError(job);
      if (Date.now() + interval > deadline) throw new WaitTimeoutError(last, timeoutMs);
      await sleep(interval, options.signal);
      interval = Math.min(Math.round(interval * 1.5), maxInterval);
    }
  }

  /** One page of GET /v1/transcriptions. Most callers want list(), which follows the cursor for you. */
  async listPage(params: ListParams = {}, options: RequestOptions = {}): Promise<TranscriptionPage> {
    const { from, to, ...rest } = params;
    const { data } = await this.transport.send<TranscriptionPage>('GET', '/v1/transcriptions', {
      query: { ...rest, from: isoOrUndefined(from), to: isoOrUndefined(to) },
      idempotent: true,
      ...options,
    });
    return data;
  }

  /**
   * Every transcription matching the filters, newest first, fetched page by page as you iterate:
   *   for await (const t of client.list({ status: 'completed' })) console.log(t.id);
   * Items omit the heavy `result`; get(id) has it.
   */
  async *list(params: ListParams = {}, options: RequestOptions = {}): AsyncGenerator<TranscriptionSummary, void, undefined> {
    let cursor = params.cursor;
    do {
      const page = await this.listPage({ ...params, cursor }, options);
      for (const item of page.items) yield item;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  // ─── Change ────────────────────────────────────────────────────────────────

  /** Stop a job before it starts transcribing (created, downloading or pending). You are not charged. */
  async cancel(id: string, options: RequestOptions = {}): Promise<TranscriptionCancelled> {
    const { data } = await this.transport.send<TranscriptionCancelled>('POST', `/v1/transcribe/${pathId(id)}/cancel`, {
      idempotent: true,
      ...options,
    });
    return data;
  }

  /** Delete a finished job and its transcript. Deleting twice is fine; a job still running answers 409 (cancel it first). */
  async delete(id: string, options: RequestOptions = {}): Promise<void> {
    await this.transport.send<void>('DELETE', `/v1/transcribe/${pathId(id)}`, { idempotent: true, ...options });
  }

  /** Balance, reserved and available amounts in cents, the price per hour and the auto top-up settings. */
  async balance(options: RequestOptions = {}): Promise<Balance> {
    const { data } = await this.transport.send<Balance>('GET', '/v1/balance', { idempotent: true, ...options });
    return data;
  }

  // ─── Webhooks and feedback ─────────────────────────────────────────────────

  /** Send a finished job's final webhook again now, with the same X-Scriptivox-Delivery id. */
  async resendWebhook(id: string, options: RequestOptions = {}): Promise<WebhookSendResult> {
    const { data } = await this.transport.send<WebhookSendResult>('POST', `/v1/transcribe/${pathId(id)}/webhook/resend`, {
      idempotent: false,
      ...options,
    });
    return data;
  }

  /** Send a signed `webhook.test` event to `url` (or your account's default webhook URL) and report what your server answered. */
  async testWebhook(url?: string, options: RequestOptions = {}): Promise<WebhookSendResult> {
    const { data } = await this.transport.send<WebhookSendResult>('POST', '/v1/webhooks/test', {
      body: url === undefined ? {} : { url },
      idempotent: false,
      ...options,
    });
    return data;
  }

  /** Rate a completed job (1–5) and/or report a problem with any job. */
  async feedback(id: string, feedback: FeedbackRequest, options: RequestOptions = {}): Promise<FeedbackResult> {
    const { data } = await this.transport.send<FeedbackResult>('POST', `/v1/transcribe/${pathId(id)}/feedback`, {
      body: feedback,
      idempotent: false,
      ...options,
    });
    return data;
  }

  /** Same as the exported verifyWebhook(): check a webhook's signature and freshness and return its event. */
  verifyWebhook(rawBody: string | Uint8Array, headers: HeadersLike, secret: string, options?: VerifyWebhookOptions): WebhookEvent {
    return verifyWebhook(rawBody, headers, secret, options);
  }
}

export type { IdempotentRequestOptions };
