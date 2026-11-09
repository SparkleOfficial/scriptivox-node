// Compile-only: how a customer's TypeScript uses the published types (npm run test:types).
import Scriptivox, {
  APIError,
  RateLimitExceededError,
  TranscriptionFailedError,
  ZeroBalanceError,
  verifyWebhook,
  type Balance,
  type CompletedTranscription,
  type Transcription,
  type TranscriptionSummary,
  type WebhookEvent,
} from 'scriptivox';

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
  }
  const b: Balance = await client.balance();
  const on: boolean = b.auto_topup.enabled;

  const event: WebhookEvent = verifyWebhook(raw, headers, 'whsec_x');
  switch (event.event) {
    case 'transcription.completed':
      void event.result.full_transcript;
      break;
    case 'transcription.failed':
      void event.error.code;
      break;
    case 'webhook.test':
      void event.test;
      break;
  }

  try {
    await client.cancel(job.id);
  } catch (e) {
    if (e instanceof ZeroBalanceError) void e.requestId;
    if (e instanceof RateLimitExceededError) void e.error?.in_flight;
    if (e instanceof TranscriptionFailedError) void e.code;
    if (e instanceof APIError && e.code === 'TRANSCRIPTION_NOT_FOUND') void e.status;
  }
  void [text, t, srt, wrong, on];
}
