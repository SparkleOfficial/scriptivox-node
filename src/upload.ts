/**
 * Sending a file's bytes to the presigned upload URL, streamed (files up to 5 GB are never read
 * into memory) and with progress. Uses node:http(s) because fetch cannot report upload progress
 * and cannot stream a request body on every Node 18 release.
 */
import { createReadStream, promises as fsp } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APIConnectionError, APITimeoutError, UploadFailedError } from './errors.js';
import { backoffMs, sleep, userAgent } from './http.js';
import type { FileInput, UploadProgress } from './types.js';

const CHUNK = 1024 * 1024;
/** No byte moving for this long ends the upload (it is retried when the source can be read again). */
const IDLE_TIMEOUT_MS = 120_000;
const MAX_FILENAME = 255;

export interface FileSource {
  /** Name derived from the input (path or File name), before making it safe. */
  name: string | undefined;
  size: number;
  /** A fresh iterator of the bytes; undefined for a stream that can only be read once. */
  open: () => AsyncIterable<Uint8Array>;
  /** Whether open() may be called again (for retries). */
  repeatable: boolean;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return !!value && typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function';
}

async function* chunksOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
    yield bytes.subarray(offset, Math.min(offset + CHUNK, bytes.byteLength));
  }
}

/** Turn any accepted input into a sized, (where possible) re-readable byte source. */
export async function resolveSource(file: FileInput, size?: number): Promise<FileSource> {
  if (typeof file === 'string' || file instanceof URL) {
    const path = file instanceof URL ? fileURLToPath(file) : file;
    const stat = await fsp.stat(path);
    if (!stat.isFile()) throw new TypeError(`${path} is not a file.`);
    return {
      name: basename(path),
      size: stat.size,
      repeatable: true,
      open: () => createReadStream(path, { highWaterMark: CHUNK }),
    };
  }
  if (file instanceof ArrayBuffer) file = new Uint8Array(file);
  if (file instanceof Uint8Array) {
    const bytes = file;
    return { name: undefined, size: bytes.byteLength, repeatable: true, open: () => chunksOf(bytes) };
  }
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    const blob = file;
    const maybeName = (blob as unknown as { name?: unknown }).name;
    const name = typeof maybeName === 'string' ? maybeName : undefined;
    return {
      name,
      size: blob.size,
      repeatable: true,
      open: () => blob.stream() as unknown as AsyncIterable<Uint8Array>,
    };
  }
  if (isAsyncIterable(file)) {
    if (size === undefined || !Number.isInteger(size) || size < 0) {
      throw new TypeError('Uploading a stream needs its byte length: pass { size }. (Paths, bytes and Blobs work it out.)');
    }
    const path = (file as { path?: unknown }).path;
    const stream = file;
    let used = false;
    return {
      name: typeof path === 'string' ? basename(path) : undefined,
      size,
      repeatable: false,
      open: () => {
        if (used) throw new TypeError('A stream can only be uploaded once.');
        used = true;
        return stream;
      },
    };
  }
  throw new TypeError('file must be a path, a file: URL, a Buffer/Uint8Array/ArrayBuffer, a Blob/File, or a readable stream.');
}

/**
 * The filename the API accepts: printable ASCII, no path separators, none of < > " ' `, at most
 * 255 characters, with an extension. Accents are dropped (é → e), anything else becomes "_".
 */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  let safe = base
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]|[<>"'`]/g, '_')
    .trim();
  const dot = safe.lastIndexOf('.');
  if (dot <= 0 || dot === safe.length - 1) {
    throw new TypeError(`The filename "${name}" needs an extension such as .mp3 or .mp4: pass { filename }.`);
  }
  if (safe.length > MAX_FILENAME) {
    const ext = safe.slice(dot);
    safe = safe.slice(0, MAX_FILENAME - ext.length) + ext;
  }
  return safe;
}

function putOnce(
  uploadUrl: string,
  headers: Record<string, string>,
  source: FileSource,
  onProgress: ((p: UploadProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const url = new URL(uploadUrl);
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest;
    let settled = false;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const req = send(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Length': String(source.size), 'User-Agent': userAgent() },
    });
    const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error('The upload was aborted.'));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    req.setTimeout(IDLE_TIMEOUT_MS, () => {
      req.destroy(new APITimeoutError(`The upload stalled: no progress for ${IDLE_TIMEOUT_MS / 1000} s.`));
    });
    req.on('error', (err) => {
      if (signal?.aborted) return finish(signal.reason ?? err);
      finish(err instanceof APITimeoutError ? err : new APIConnectionError(`The upload connection failed: ${err.message}`, { cause: err }));
    });
    req.on('response', (res) => {
      const parts: Buffer[] = [];
      let kept = 0;
      res.on('data', (chunk: Buffer) => {
        if (kept < 2048) {
          parts.push(chunk);
          kept += chunk.length;
        }
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) return finish();
        const body = Buffer.concat(parts).toString('utf8').slice(0, 2048);
        finish(new UploadFailedError(`The file upload was refused with HTTP ${status}.`, { status, body }));
      });
      res.on('error', (err) => finish(new APIConnectionError(`The upload answer was cut off: ${err.message}`, { cause: err })));
    });

    (async () => {
      let sent = 0;
      for await (const chunk of source.open()) {
        const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk as ArrayBuffer);
        if (sent + bytes.byteLength > source.size) {
          throw new UploadFailedError(`The source has more bytes than the size given (${source.size}).`);
        }
        if (!req.write(bytes)) await once(req, 'drain');
        sent += bytes.byteLength;
        onProgress?.({ loaded: sent, total: source.size, percent: source.size ? Math.round((sent / source.size) * 1000) / 10 : 100 });
      }
      if (sent !== source.size) {
        throw new UploadFailedError(`The source ended after ${sent} of ${source.size} bytes.`);
      }
      if (source.size === 0) onProgress?.({ loaded: 0, total: 0, percent: 100 });
      req.end();
    })().catch((err) => {
      req.destroy(err instanceof Error ? err : new Error(String(err)));
      finish(err);
    });
  });
}

/**
 * PUT the bytes, retrying a dropped connection or a 5xx from storage when the source can be read
 * again. A 4xx from storage (usually an expired URL) is not retried.
 */
export async function putFile(
  uploadUrl: string,
  headers: Record<string, string>,
  source: FileSource,
  opts: { maxRetries: number; onProgress?: (p: UploadProgress) => void; signal?: AbortSignal },
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await putOnce(uploadUrl, headers, source, opts.onProgress, opts.signal);
      return;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const transient =
        err instanceof APIConnectionError || (err instanceof UploadFailedError && (err.status ?? 0) >= 500);
      if (!transient || !source.repeatable || attempt >= opts.maxRetries) throw err;
      await sleep(backoffMs(attempt), opts.signal);
    }
  }
}
