# Changelog

## 0.4.0

- `status()`: whether the API is taking new jobs right now (GET /v1/status), what is paused for maintenance and why, what still works, how long to wait and planned maintenance ahead. It needs no API key: call `client.status()`, or the exported `status()` with no client at all. Typed as `ServiceStatus`. If the call gets no answer it throws; it never reports "all fine" from a failed call.
- `MaintenanceError` now has `scope` (`upload`, `link` or `global`), `statusUrl` and `backBy`, the time the pause is expected to end if one was set.
- `wait()` waits out full maintenance (reads paused for a few minutes while the job carries on), the same way it waits out a rate limit.
- Regenerated from the API document: the status call and its types, `scope`, `back_by` and `status_url` on a `503 MAINTENANCE`.
- README: a "Maintenance" section.

## 0.3.0

- Transcribe again: `client.transcribeAgain(id, options)` and `transcribe({ source_transcription_id })` start a new job from an earlier completed one's audio, with no new upload (`SourceExpiredError`, 409, once the source is past 24 hours).
- `NoSpeechError` (422), `TemporarilyUnavailableError` (503), the job error `SPEECH_BELOW_THRESHOLD` and `result.no_speech`.

## 0.2.0

- Public social media post links on `transcribe()`, with `UrlNotAccessibleError`, `DurationTooLongError` and `LinkCheckUnavailableError`.
- Feedback needs words (`comment` or `their_words`, 20 or more characters) and has the "clarity" topic.

## 0.1.0

- First release: upload with progress, transcribe (url, file or upload_id) with an automatic Idempotency-Key, wait, get as JSON, SRT, VTT or text, list, cancel, delete, balance, webhook resend and test, feedback, `verifyWebhook`, and one error class per `error.code`.
