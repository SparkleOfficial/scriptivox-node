# Scriptivox Node.js SDK

The official Node.js and TypeScript client for the [Scriptivox transcription API](https://platform.scriptivox.com/docs/quickstart). Upload a file or pass a link, wait for the transcript, export SRT, VTT or text, list your jobs and verify webhooks. Typed responses and one error class per error code.

- Node.js 18 or newer. No runtime dependencies. ESM and CommonJS.
- Every submit carries an `Idempotency-Key`, so a retried call never starts a second job.
- Large files are streamed from disk with progress, never read into memory.

## Install

```bash
npm install scriptivox
```

## Quickstart

Create an API key on the [API Keys page](https://platform.scriptivox.com/platform/keys) and add balance on the [Billing page](https://platform.scriptivox.com/platform/billing).

```js
import Scriptivox from 'scriptivox';

const client = new Scriptivox(); // reads SCRIPTIVOX_API_KEY, or pass { apiKey: 'sk_live_...' }

const job = await client.transcribe({ file: './meeting.mp3', language: 'en' });
const done = await client.wait(job.id);
console.log(done.result.full_transcript);
```

CommonJS: `const { Scriptivox } = require('scriptivox');`

From a public link (direct file links, Google Drive, Dropbox and OneDrive share links):

```js
const job = await client.transcribe({ url: 'https://example.com/podcast.mp3', diarize: true, speaker_count: 2 });
```

Pass `language` when you know it: it is faster and more accurate than auto-detection. Omit it to auto-detect.

## Captions and plain text

```js
const srt = await client.get(job.id, { format: 'srt', max_words: 4 });
const vtt = await client.get(job.id, { format: 'vtt', include_speakers: true });
const text = await client.get(job.id, { format: 'text', include_timestamps: true });
```

Without `format` (or with `format: 'json'`) you get the whole job. The caption options are `max_words`, `max_chars`, `max_duration`, `sentence_aware`, `include_speakers`, `strip_chars` and, for text, `include_timestamps`. See [caption export](https://platform.scriptivox.com/docs/api-reference#get-result).

## Upload with progress

```js
const upload = await client.upload('./lecture.mp4', {
  onProgress: ({ loaded, total, percent }) => console.log(`${percent}%  ${loaded}/${total}`),
});
const job = await client.transcribe({ upload_id: upload.upload_id });
// or in one call:
const job2 = await client.transcribe({ file: './lecture.mp4' }, { onUploadProgress: (p) => console.log(p.percent) });
```

`file` can be a path, a `file:` URL, a `Buffer`/`Uint8Array`, a `Blob`/`File`, or a readable stream. Bytes and streams need `filename: 'audio.mp3'`, and a stream also needs `size`. Filenames are made ASCII-safe for you (`Réunion.mp3` is sent as `Reunion.mp3`).

## Waiting

`wait(id)` polls until the job ends. It waits 2 s between polls at first, growing to 10 s, and honours `Retry-After` when rate-limited. It resolves with the completed job. A job that fails throws `TranscriptionFailedError`, whose `code` is the job's `error.code`:

```js
import { TranscriptionFailedError } from 'scriptivox';

try {
  const done = await client.wait(job.id, { timeout: 60 * 60 * 1000 });
} catch (err) {
  if (err instanceof TranscriptionFailedError) console.log(err.code, err.transcription.error?.message); // e.g. URL_NOT_ACCESSIBLE
  else throw err;
}
```

Failed and cancelled jobs cost nothing. Prefer webhooks to polling for long files. `wait()` also takes `pollInterval`, `maxPollInterval`, `onPoll` and an `AbortSignal`.

## Listing, cancelling, deleting, balance

```js
for await (const t of client.list({ status: 'completed' })) {   // follows the cursor page by page
  console.log(t.id, t.audio_duration_seconds);
}

await client.cancel(jobId);   // before transcription starts; not charged
await client.delete(jobId);   // a finished job and its transcript
const b = await client.balance();
console.log(b.available_cents, b.auto_topup.enabled);
```

`list()` takes `status`, `from`, `to` (a `Date` or ISO string), `limit` (page size) and `order`. Items leave out `result`; `get(id)` has it.

## Webhooks

Pass `webhook_url` when you submit, and check every request with `verifyWebhook`. It needs the **raw** body, your key's webhook signing secret (`whsec_…`, on the API Keys page) and the request headers. It refuses a bad signature and a timestamp more than 5 minutes old.

```js
import express from 'express';
import { verifyWebhook, WebhookVerificationError } from 'scriptivox';

const app = express();
app.post('/scriptivox', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = verifyWebhook(req.body, req.headers, process.env.SCRIPTIVOX_WEBHOOK_SECRET);
  } catch (err) {
    if (err instanceof WebhookVerificationError) return res.sendStatus(400);
    throw err;
  }
  const deliveryId = req.headers['x-scriptivox-delivery']; // the same on every retry: skip ones you have handled
  if (event.event === 'transcription.completed') console.log(event.transcription_id, event.result.full_transcript);
  if (event.event === 'transcription.failed') console.log(event.transcription_id, event.error.code);
  res.sendStatus(200);
});
```

With the Fetch API (Next.js route handlers, Hono, …): `verifyWebhook(await request.text(), request.headers, secret)`.

`client.testWebhook('https://your.server/scriptivox')` sends a signed `webhook.test` event and tells you what your server answered. `client.resendWebhook(jobId)` sends a finished job's final event again.

## Errors

Every error extends `ScriptivoxError`. When the API answers with an error you get an `APIError` subclass named after its `error.code`, under a class for its HTTP status:

```js
import { APIError, RateLimitExceededError, ZeroBalanceError } from 'scriptivox';

try {
  await client.transcribe({ url: 'https://example.com/a.mp3' });
} catch (err) {
  if (err instanceof ZeroBalanceError) console.log('Add funds on the Billing page');
  else if (err instanceof RateLimitExceededError) console.log('Jobs in progress:', err.error?.in_flight, 'of', err.error?.limit);
  else if (err instanceof APIError) console.log(err.status, err.code, err.message, err.requestId); // quote requestId to support
  else throw err;
}
```

| Class | When |
| --- | --- |
| `BadRequestError` (400): `InvalidRequestError`, `InvalidFilenameError`, `InvalidMediaFormatError`, … | The request is wrong; fix it, do not retry |
| `AuthenticationError` (401): `InvalidApiKeyError`, `ApiKeyRevokedError` | The key is missing, wrong or revoked |
| `PaymentRequiredError` (402): `InsufficientBalanceError`, `ZeroBalanceError` | Add balance |
| `NotFoundError` (404): `TranscriptionNotFoundError`, `UploadNotFoundError` | Wrong id |
| `ConflictError` (409), `IdempotencyKeyLockedError` | Not allowed in the job's current state |
| `RateLimitError` (429): `RateLimitExceededError` | Too many requests, or too many jobs in progress |
| `InternalServerError` (5xx), `ServiceUnavailableError` (503): `MaintenanceError` | Our side; safe to retry |
| `APIConnectionError`, `APITimeoutError` | No answer |
| `UploadFailedError` | The file upload itself failed |
| `TranscriptionFailedError` | `wait()`: the job ended failed |
| `WaitTimeoutError` | `wait()`: still running at the timeout |
| `WebhookVerificationError` | `verifyWebhook()`: not a genuine, fresh webhook |

The full list of codes is in the [API reference](https://platform.scriptivox.com/docs/api-reference#error-codes).

## Retries, timeouts and idempotency

- Requests that are safe to repeat (reads, deletes, cancels and submits with an `Idempotency-Key`) are retried up to 2 times after a dropped connection or a 5xx, waiting longer before each try (0.5 s, 1 s, 2 s, …).
- A `429` or `503` with `Retry-After` is retried after that many seconds, if it is 60 s or less. A `429` without `Retry-After` (the jobs-in-progress cap) is thrown at once.
- `upload()` and `transcribe()` send a new random `Idempotency-Key` per call, reused on the SDK's own retries. Pass `{ idempotencyKey }` (for example your own record id) to make a retry after a crash safe too.

```js
const client = new Scriptivox({ maxRetries: 4, timeout: 30_000 }); // timeout per request, in ms
await client.balance({ signal: AbortSignal.timeout(5000) });       // every method takes a signal
```

## Configuration

| Setting | Option | Environment variable | Default |
| --- | --- | --- | --- |
| API key | `apiKey` | `SCRIPTIVOX_API_KEY` | none (required) |
| Base URL | `baseUrl` | `SCRIPTIVOX_BASE_URL` | `https://api.scriptivox.com` |
| Retries | `maxRetries` | | 2 |
| Request timeout (ms) | `timeout` | | 60 000 |
| fetch implementation | `fetch` | | the global `fetch` |

The response types (`Transcription`, `Balance`, `WebhookEvent`, …) are generated from the [OpenAPI document](https://platform.scriptivox.com/openapi.json) and exported from the package; `paths` and `components` are exported too.

## Development

```bash
npm install
npm run generate             # regenerate src/generated/ from openapi/openapi.json
npm run generate -- --fetch  # refresh the snapshot from platform.scriptivox.com first
npm test                     # build, unit tests (no network), type tests

# integration tests against a test deployment
SCRIPTIVOX_API_KEY=sk_live_... SCRIPTIVOX_BASE_URL=https://api-test.scriptivox.com npm run test:integration
```

## License

MIT
