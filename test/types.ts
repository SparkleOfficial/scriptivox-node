// Compile-only: how a customer's TypeScript uses the published types (npm run test:types).
import Scriptivox, {
  APIError,
  MaintenanceError,
  RateLimitExceededError,
  TranscriptionFailedError,
  ZeroBalanceError,
  status,
  verifyWebhook,
  type Balance,
  type CompletedTranscription,
  type ServiceStatus,
  type ServiceStatusPause,
  type Transcription,
  type TranscriptionSummary,
  type TranscriptionWaiting,
  type NotStarted,
  type WebhookEvent,
} from 'scriptivox';

export async function statusUsage(client: Scriptivox): Promise<void> {
  const s: ServiceStatus = await client.status();
  const keyless: ServiceStatus = await status({ baseUrl: 'https://api-test.scriptivox.com', timeout: 5_000 });
  const state: 'operational' | 'maintenance' | 'unknown' = s.status;
  // @ts-expect-error accepting_new_jobs is null while the state could not be checked
  const accepting: boolean = keyless.accepting_new_jobs;
  const pauses: ServiceStatusPause[] = s.maintenance?.paused ?? [];
  const backBy: string | null | undefined = pauses[0]?.back_by;
  const wait: number | undefined = s.maintenance?.retry_after_seconds;
  const working: string[] | null = s.still_working;
  try {
    await client.transcribe({ url: 'https://example.com/a.mp3' });
  } catch (e) {
    if (e instanceof MaintenanceError) {
      const scope: string | undefined = e.scope;
      const url: string | undefined = e.statusUrl;
      const by: string | null = e.backBy;
      const code: 'MAINTENANCE' = e.code;
      void [scope, url, by, code, e.retryAfter];
    }
  }
  void [state, accepting, backBy, wait, working];
}

export async function usage(client: Scriptivox, raw: string, headers: Record<string, string>): Promise<void> {
  const job = await client.transcribe({ file: './a.mp3', language: 'en', diarize: true, speaker_count: 2 });
  const job2 = await client.transcribe({ url: 'https://example.com/a.mp3' }, { idempotencyKey: 'k' });
  await client.transcribe({ upload_id: job2.id });
  // @ts-expect-error exactly one source
  await client.transcribe({ url: 'x', upload_id: 'y' });

  const done: CompletedTranscription = await client.wait(job.id, { timeout: 60_000, onPoll: (t) => t.status });
  const text: string = done.result.full_transcript ?? '';
  const t: Transcription = await client.get(job.id);
  const srt: string = await client.get(job.id, { format: 'srt', max_words: 3, include_speakers: true });
  // @ts-expect-error a caption export is a string, not a Transcription
  const wrong: Transcription = await client.get(job.id, { format: 'vtt' });

  for await (const item of client.list({ status: 'completed', from: new Date() })) {
    const s: TranscriptionSummary = item;
    void s.audio_duration_seconds;
    // Why a job waits for its turn: on the list and the job alike, absent once it starts.
    const why: TranscriptionWaiting | undefined = s.waiting;
    const code: string | undefined = why?.reason;
    const retryAt: string | null | undefined = why?.retry_at;
    void [code, retryAt];
  }
  const w: TranscriptionWaiting | undefined = t.waiting;
  const accepted: NotStarted | undefined = job.not_started;
  void [w, accepted?.google_drive];
  const b: Balance = await client.balance();
  const on: boolean = b.auto_topup.enabled;

  const event: WebhookEvent = verifyWebhook(raw, headers, 'whsec_x');
  switch (event.event) {
    case 'transcription.completed':
      void event.result.full_transcript;
      break;
    case 'transcription.failed': {
      void event.error.code;
      const page: string | undefined = event.error.docs_url;
      const helpId: string | undefined = event.error.help_id;
      void [page, helpId];
      break;
    }
    case 'webhook.test':
      void event.test;
      break;
  }

  try {
    await client.cancel(job.id);
  } catch (e) {
    if (e instanceof ZeroBalanceError) void e.requestId;
    if (e instanceof RateLimitExceededError) void e.error?.in_flight;
    if (e instanceof TranscriptionFailedError) void [e.code, e.docsUrl, e.helpId];
    if (e instanceof APIError) { const id: string | undefined = e.helpId; void [id, e.docsUrl]; }
    if (e instanceof APIError && e.code === 'TRANSCRIPTION_NOT_FOUND') void e.status;
  }
  void [text, t, srt, wrong, on];
}
