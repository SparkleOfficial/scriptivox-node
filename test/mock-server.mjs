// A scripted HTTP server on 127.0.0.1 (ephemeral port) that records every request.
import { createServer } from 'node:http';

export async function startMock() {
  const requests = [];
  const queue = [];
  let fallback = null;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const record = {
      method: req.method,
      url: req.url,
      path: req.url.split('?')[0],
      query: Object.fromEntries(new URL(req.url, 'http://x').searchParams),
      headers: req.headers,
      body,
      text: body.toString('utf8'),
      json: (() => {
        try {
          return JSON.parse(body.toString('utf8'));
        } catch {
          return undefined;
        }
      })(),
      at: Date.now(),
    };
    requests.push(record);
    const handler = queue.length ? queue.shift() : fallback;
    if (!handler) {
      res.writeHead(599, { 'content-type': 'text/plain' });
      res.end('no handler queued');
      return;
    }
    const out = await handler(record, mock);
    if (out === 'hang') return; // never answer (timeouts)
    if (out === 'destroy') {
      req.socket.destroy();
      return;
    }
    const headers = { 'x-request-id': 'req_00000000000000aa', ...(out.headers ?? {}) };
    let payload = out.body;
    if (payload !== undefined && typeof payload !== 'string' && !Buffer.isBuffer(payload)) {
      payload = JSON.stringify(payload);
      headers['content-type'] ??= 'application/json';
    }
    res.writeHead(out.status ?? 200, headers);
    res.end(payload);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const mock = {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** Queue one answer per handler, in order. */
    reply(...handlers) {
      for (const h of handlers) queue.push(typeof h === 'function' ? h : () => h);
      return mock;
    },
    always(handler) {
      fallback = typeof handler === 'function' ? handler : () => handler;
      return mock;
    },
    reset() {
      requests.length = 0;
      queue.length = 0;
      fallback = null;
    },
    pending: () => queue.length,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
  return mock;
}

export const apiError = (status, code, message = code, extra = {}, headers = {}) => ({
  status,
  headers,
  body: { error: { code, message, docs_url: 'https://platform.scriptivox.com/docs/api-reference#error-codes', request_id: 'req_0123456789abcdef', ...extra } },
});
