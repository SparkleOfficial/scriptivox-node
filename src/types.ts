/**
 * Friendly names for the generated OpenAPI types (src/generated/openapi.ts), plus the
 * option types of the hand-written helpers.
 */
import type { Readable } from 'node:stream';
import type { components, operations } from './generated/openapi.js';

type Schemas = components['schemas'];

export type { components, operations, paths, webhooks } from './generated/openapi.js';

export type Transcription = Schemas['Transcription'];
export type TranscriptionSummary = Schemas['TranscriptionSummary'];
export type TranscriptionStatus = Schemas['TranscriptionStatus'];
export type TranscriptionResult = Schemas['TranscriptionResult'];
export type TranscriptionJobError = Schemas['TranscriptionError'];
export type Utterance = Schemas['Utterance'];
export type Word = Schemas['Word'];
export type TranscriptionCreated = Schemas['TranscriptionCreated'];
export type TranscriptionCancelled = Schemas['TranscriptionCancelled'];
export type TranscriptionPage = Schemas['TranscriptionPage'];
export type Upload = Schemas['Upload'];
export type Balance = Schemas['Balance'];
export type FeedbackRequest = Schemas['FeedbackRequest'];
export type FeedbackResult = Schemas['FeedbackResult'];
export type WebhookSendResult = Schemas['WebhookSendResult'];
export type ApiErrorBody = Schemas['Error'];

/** A finished job: `status` is "completed" and `result` is filled in. What wait() resolves with. */
export type CompletedTranscription = Transcription & {
  status: 'completed';
  result: TranscriptionResult;
};

// ─── Webhook events ─────────────────────────────────────────────────────────

export type TranscriptionProcessingEvent = Schemas['WebhookTranscriptionProcessing'];
export type TranscriptionCompletedEvent = Schemas['WebhookTranscriptionCompleted'];
export type TranscriptionFailedEvent = Schemas['WebhookTranscriptionFailed'];
export type TranscriptionDownloadingEvent = Schemas['WebhookTranscriptionDownloading'];
export type WebhookTestEvent = Schemas['WebhookTest'];

/** Every event body a webhook can carry; switch on `event`. New event types may be added: answer 2xx to unknown ones. */
export type WebhookEvent =
  | TranscriptionProcessingEvent
  | TranscriptionCompletedEvent
  | TranscriptionFailedEvent
  | TranscriptionDownloadingEvent
  | WebhookTestEvent;

// ─── Request options ────────────────────────────────────────────────────────

export interface ClientOptions {
  /** Your `sk_live_…` key. Default: the SCRIPTIVOX_API_KEY environment variable. */
  apiKey?: string;
  /** Default: SCRIPTIVOX_BASE_URL, else https://api.scriptivox.com. A trailing /v1 is accepted. */
  baseUrl?: string;
  /** Retries for a failed request that is safe to repeat (default 2). See README "Retries". */
  maxRetries?: number;
  /** Per-request timeout in milliseconds (default 60 000). Does not apply to the file upload itself. */
  timeout?: number;
  /** A fetch implementation (default: the global fetch of Node 18+). */
  fetch?: typeof globalThis.fetch;
  /** Extra headers on every API request. */
  defaultHeaders?: Record<string, string>;
}

export interface RequestOptions {
  /** Abort the call. */
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds, overriding the client's. */
  timeout?: number;
  /** Retries for this call, overriding the client's. */
  maxRetries?: number;
}

export interface IdempotentRequestOptions extends RequestOptions {
  /**
   * Sent as `Idempotency-Key`. Default: a new random UUID per call, reused on the SDK's own
   * retries of that call, so a retried submit never makes a second billable job. Pass your own
   * (e.g. your database row id) to make a retry across process restarts safe as well.
   */
  idempotencyKey?: string;
}

export interface UploadProgress {
  /** Bytes sent so far. */
  loaded: number;
  /** Total bytes. */
  total: number;
  /** 0–100. */
  percent: number;
}

/**
 * What upload() and transcribe({ file }) accept: a file path (string or file: URL), bytes,
 * a Blob/File, or a stream (a stream needs `size` and `filename`, and cannot be retried).
 */
export type FileInput = string | URL | Uint8Array | ArrayBuffer | Blob | Readable | AsyncIterable<Uint8Array>;

export interface UploadOptions extends IdempotentRequestOptions {
  /** Name sent to the API, with its extension (.mp3, .mp4, …). Default: the path's or File's name. Made ASCII-safe automatically. */
  filename?: string;
  /** Byte length. Required for a stream; worked out for every other input. */
  size?: number;
  /** Called as bytes are sent. */
  onProgress?: (progress: UploadProgress) => void;
}

export interface UploadResult {
  upload_id: string;
  /** The filename the API stored (after making it ASCII-safe). */
  filename: string;
  /** Bytes uploaded. */
  size: number;
}

/** Options of a transcription, as the API names them. */
export interface TranscriptionOptions {
  /** ISO code such as "en". Omit (or null) to auto-detect; passing it is faster and more accurate. */
  language?: string | null;
  /** Speaker labels. */
  diarize?: boolean;
  /** Expected number of speakers (1–50), with diarize: true. */
  speaker_count?: number;
  /** Word-level timestamps (default true; always on with diarize). */
  align?: boolean;
  /** https URL that receives signed webhook events for this job. */
  webhook_url?: string;
}

export type TranscribeParams = TranscriptionOptions &
  (
    | { url: string; file?: never; upload_id?: never }
    | { file: FileInput; filename?: string; size?: number; url?: never; upload_id?: never }
    | { upload_id: string; url?: never; file?: never }
  );

export interface TranscribeOptions extends IdempotentRequestOptions {
  /** With `file`: called as the upload's bytes are sent. */
  onUploadProgress?: (progress: UploadProgress) => void;
}

export interface WaitOptions {
  /** Give up after this many milliseconds (default 2 hours; every job ends on the server well within that). */
  timeout?: number;
  /** First wait between polls in milliseconds (default 2 000). */
  pollInterval?: number;
  /** Longest wait between polls in milliseconds (default 10 000); the wait grows 1.5× per poll up to this. */
  maxPollInterval?: number;
  /** Called with each poll's answer. */
  onPoll?: (transcription: Transcription) => void;
  signal?: AbortSignal;
}

/** Caption and text export options of GET /v1/transcribe/{id} (everything except format). */
type ExportQuery = Omit<NonNullable<operations['getTranscription']['parameters']['query']>, 'format' | 'include_speakers'>;

export interface ExportOptions extends ExportQuery {
  /** Prefix cues with the speaker label. "auto" (default): only when the job has more than one speaker. */
  include_speakers?: boolean | 'auto' | 'true' | 'false';
}

export type ExportFormat = 'srt' | 'vtt' | 'text';

export type GetOptions = ({ format?: 'json' } | ({ format: ExportFormat } & ExportOptions)) & RequestOptions;

type ListQuery = NonNullable<operations['listTranscriptions']['parameters']['query']>;

export interface ListParams extends Omit<ListQuery, 'from' | 'to'> {
  /** Inclusive lower bound on created_at. */
  from?: string | Date;
  /** Exclusive upper bound on created_at. */
  to?: string | Date;
}
