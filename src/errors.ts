/**
 * Error classes. Every error the SDK throws extends ScriptivoxError.
 *
 *   ScriptivoxError
 *   ├── APIError                       the API answered with an error (has status, code, requestId)
 *   │   ├── BadRequestError (400)      ├── InvalidRequestError, InvalidFilenameError, ... (one per error.code,
 *   │   ├── AuthenticationError (401)  │   generated in generated/errors.ts from the OpenAPI document)
 *   │   ├── PaymentRequiredError (402) ├── InsufficientBalanceError, ZeroBalanceError
 *   │   ├── ... one class per HTTP status the API uses
 *   │   ├── RateLimitError (429)       ├── RateLimitExceededError
 *   │   └── ServiceUnavailableError    └── MaintenanceError (503, written here: scope, statusUrl, backBy)
 *   ├── APIConnectionError             no answer: DNS, refused, reset (APITimeoutError: no answer in time)
 *   ├── UploadFailedError              the file PUT to the presigned upload URL failed
 *   ├── TranscriptionFailedError       wait(): the job ended with status "failed" (code = the job's error.code)
 *   ├── WaitTimeoutError               wait(): the job was still running when the timeout passed
 *   └── WebhookVerificationError       verifyWebhook(): bad signature, old timestamp, missing header
 */
import type { Transcription } from './types.js';

export class ScriptivoxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    // `cause` is ES2022; Node 18 supports it.
    super(message, options);
    this.name = new.target.name;
  }
}

export interface APIErrorInit {
  status: number;
  code: string;
  message: string;
  requestId?: string;
  docsUrl?: string;
  helpId?: string;
  retryAfter?: number;
  /** The whole `error` object from the body, including fields beyond code and message. */
  error?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** The API answered with an HTTP error. Branch on `code` (stable) or `instanceof`; never on `message`. */
export class APIError extends ScriptivoxError {
  /** HTTP status. */
  readonly status: number;
  /** The API's machine-readable `error.code`, e.g. "ZERO_BALANCE". "UNKNOWN_ERROR" when the body had none. */
  readonly code: string;
  /** `X-Request-Id` / `error.request_id` (`req_` + 16 hex). Quote it to support. */
  readonly requestId: string | undefined;
  /** The page that explains this exact error: `https://www.scriptivox.com/errors/{helpId}`. */
  readonly docsUrl: string | undefined;
  /**
   * The help page's id (`error.help_id`), e.g. "api-key-invalid". Stable: an id is never renamed, and one code can have
   * several pages. Branch on `code`; use `helpId` for more detail than the code gives.
   */
  readonly helpId: string | undefined;
  /** Seconds from the `Retry-After` header, when the answer had one. */
  readonly retryAfter: number | undefined;
  /** The whole `error` object (extra fields such as `in_flight` and `limit` live here). */
  readonly error: Record<string, unknown> | undefined;
  /** Response headers, lower-case names. */
  readonly headers: Record<string, string>;

  constructor(init: APIErrorInit) {
    const ref = [init.code, init.requestId ? `request ${init.requestId}` : undefined].filter(Boolean).join(', ');
    super(`${init.message} [${ref}]`);
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.docsUrl = init.docsUrl;
    this.helpId = init.helpId;
    this.retryAfter = init.retryAfter;
    this.error = init.error;
    this.headers = init.headers ?? {};
  }
}

export class BadRequestError extends APIError {}
export class AuthenticationError extends APIError {}
export class PaymentRequiredError extends APIError {}
export class PermissionDeniedError extends APIError {}
export class NotFoundError extends APIError {}
export class MethodNotAllowedError extends APIError {}
export class ConflictError extends APIError {}
export class GoneError extends APIError {}
export class PayloadTooLargeError extends APIError {}
export class UnsupportedMediaTypeError extends APIError {}
export class UnprocessableEntityError extends APIError {}
export class RateLimitError extends APIError {}
export class InternalServerError extends APIError {}
export class ServiceUnavailableError extends APIError {}

/**
 * `MAINTENANCE` (HTTP 503). This part of the API is briefly paused for maintenance: nothing was
 * created or charged. Send the same request again after `retryAfter` seconds. `status()`
 * (GET /v1/status, no API key needed) says what is paused, what still works and how long to wait.
 * Jobs already accepted always finish.
 */
export class MaintenanceError extends ServiceUnavailableError {
  declare readonly code: 'MAINTENANCE';
  /**
   * What is paused, as `error.scope` names it: "upload" (new jobs and uploads), "link" (a link to a
   * video or social media site on transcribe; uploads and other file addresses carry on) or
   * "global" (site-wide maintenance, or full maintenance, which pauses every call, reads included).
   * New values may be added. undefined when the answer had none.
   */
  readonly scope: string | undefined;
  /** `error.status_url`: the address of GET /v1/status. undefined when the answer had none. */
  readonly statusUrl: string | undefined;
  /**
   * `error.back_by`: when the pause is expected to end, if a time was set (ISO 8601, UTC); otherwise
   * null. `retryAfter` then counts the seconds until it (at most an hour). It is a plan: `status()`
   * says when the pause is really over.
   */
  readonly backBy: string | null;

  constructor(init: APIErrorInit) {
    super(init);
    const error = init.error ?? {};
    this.scope = typeof error.scope === 'string' ? error.scope : undefined;
    this.statusUrl = typeof error.status_url === 'string' ? error.status_url : undefined;
    this.backBy = typeof error.back_by === 'string' ? error.back_by : null;
  }
}

/** The category class for an HTTP status, used when a code is not one the SDK knows. */
export function categoryForStatus(status: number): new (init: APIErrorInit) => APIError {
  switch (status) {
    case 400: return BadRequestError;
    case 401: return AuthenticationError;
    case 402: return PaymentRequiredError;
    case 403: return PermissionDeniedError;
    case 404: return NotFoundError;
    case 405: return MethodNotAllowedError;
    case 409: return ConflictError;
    case 410: return GoneError;
    case 413: return PayloadTooLargeError;
    case 415: return UnsupportedMediaTypeError;
    case 422: return UnprocessableEntityError;
    case 429: return RateLimitError;
    case 503: return ServiceUnavailableError;
    default: return status >= 500 ? InternalServerError : APIError;
  }
}

/** No HTTP answer at all: DNS failure, connection refused or reset. */
export class APIConnectionError extends ScriptivoxError {}

/** No answer within the request timeout. */
export class APITimeoutError extends APIConnectionError {}

/** The PUT of the file bytes to the presigned upload URL failed. */
export class UploadFailedError extends ScriptivoxError {
  /** HTTP status from the storage server, when it answered. */
  readonly status: number | undefined;
  /** The start of the storage server's answer (often XML). */
  readonly body: string | undefined;
  constructor(message: string, init: { status?: number; body?: string; cause?: unknown } = {}) {
    super(message, { cause: init.cause });
    this.status = init.status;
    this.body = init.body;
  }
}

/**
 * wait(): the job ended with `status: "failed"`. Failed jobs cost nothing. `code` is the job's
 * `error.code` (URL_NOT_ACCESSIBLE, INVALID_MEDIA_FORMAT, CANCELLED, ...); `transcription` is the job.
 */
export class TranscriptionFailedError extends ScriptivoxError {
  readonly code: string;
  /** The page that explains this failure (the job's `error.docs_url`), when it has one. */
  readonly docsUrl: string | undefined;
  /** That page's stable id (the job's `error.help_id`), e.g. "drive-not-shared", when it has one. */
  readonly helpId: string | undefined;
  readonly transcriptionId: string;
  readonly transcription: Transcription;
  constructor(transcription: Transcription) {
    const code = transcription.error?.code ?? 'UNKNOWN_ERROR';
    const message = transcription.error?.message ?? 'The transcription failed.';
    super(`Transcription ${transcription.id} failed: ${message} [${code}]`);
    this.code = code;
    this.docsUrl = typeof transcription.error?.docs_url === 'string' ? transcription.error.docs_url : undefined;
    this.helpId = typeof transcription.error?.help_id === 'string' ? transcription.error.help_id : undefined;
    this.transcriptionId = transcription.id;
    this.transcription = transcription;
  }
}

/** wait(): the timeout passed while the job was still running. The job carries on; wait again or poll later. */
export class WaitTimeoutError extends ScriptivoxError {
  readonly transcriptionId: string;
  /** The last status seen. */
  readonly transcription: Transcription;
  constructor(transcription: Transcription, timeoutMs: number) {
    super(
      `Transcription ${transcription.id} is still "${transcription.status}" after ${Math.round(timeoutMs / 1000)} s. ` +
        `It carries on running; call wait() again or get() later.`,
    );
    this.transcriptionId = transcription.id;
    this.transcription = transcription;
  }
}

export type WebhookVerificationReason =
  | 'missing_header'
  | 'invalid_timestamp'
  | 'timestamp_outside_tolerance'
  | 'signature_mismatch'
  | 'invalid_json';

/** verifyWebhook(): the request is not a genuine, fresh Scriptivox webhook. Answer it with 400. */
export class WebhookVerificationError extends ScriptivoxError {
  readonly reason: WebhookVerificationReason;
  constructor(reason: WebhookVerificationReason, message: string) {
    super(message);
    this.reason = reason;
  }
}
