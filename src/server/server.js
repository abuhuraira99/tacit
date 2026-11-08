import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SafeWriteError } from '../core/apply.js';
import { RefineError } from '../core/ai.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(here, '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const MAX_BODY = 1024 * 1024;

/**
 * Local-only HTTP server for the Tacit UI.
 * - binds to 127.0.0.1 only
 * - rejects requests whose Host header is not localhost (DNS-rebinding protection)
 * - every state-changing request needs the per-launch token embedded in the page
 */
export function createServer(app, { port = 0, host = '127.0.0.1' } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const clients = new Set();
  let boundPort = port;

  app.on('progress', (state) => {
    const data = `event: progress\ndata: ${JSON.stringify(state)}\n\n`;
    for (const res of clients) res.write(data);
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host, boundPort)) return send(res, 421, { error: 'Tacit only answers on localhost.' });
      const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(req, res, url);
    } catch (err) {
      const status = err.status || (err instanceof SafeWriteError ? 409 : err instanceof RefineError ? 502 : 500);
      if (status >= 500 && !(err instanceof RefineError)) console.error('[tacit]', err);
      if (!res.headersSent) send(res, status, { error: err.message || 'Something went wrong.', code: err.code || null });
    }
  });

  async function handleApi(req, res, url) {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      if (req.headers['x-tacit-token'] !== token) return send(res, 403, { error: 'Missing or invalid session token. Reload the page.' });
      const origin = req.headers.origin;
      if (origin && !hostAllowed(origin.replace(/^https?:\/\//, ''), boundPort)) return send(res, 403, { error: 'Cross-origin requests are not allowed.' });
    }
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams);

    if (p === '/api/events' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
      res.write(`event: progress\ndata: ${JSON.stringify(app.state)}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (p === '/api/status' && method === 'GET') return send(res, 200, app.status());
    if (p === '/api/scan' && method === 'POST') {
      app.load({ force: true });
      return send(res, 202, { ok: true });
    }

    if (p === '/api/settings' && method === 'GET') return send(res, 200, await app.settingsView());
    if (p === '/api/settings' && method === 'POST') {
      const body = await readJson(req);
      const rescan = app.updateSettings(body);
      return send(res, 200, { ...(await app.settingsView()), rescan });
    }

    if (!app.ready) return send(res, 503, { error: 'Still reading your history.', status: app.status() });

    if (p === '/api/overview' && method === 'GET') return send(res, 200, app.overview());
    if (p === '/api/patterns' && method === 'GET') return send(res, 200, app.listPatterns(q));
    let m = /^\/api\/patterns\/([\w-]+)$/.exec(p);
    if (m && method === 'GET') {
      const pat = app.getPattern(m[1]);
      return pat ? send(res, 200, pat) : send(res, 404, { error: 'Pattern not found.' });
    }
    if (p === '/api/sessions' && method === 'GET') return send(res, 200, app.listSessions({ ...q, limit: Number(q.limit) || 500 }));
    m = /^\/api\/sessions\/([\w-]+)$/.exec(p);
    if (m && method === 'GET') {
      const s = app.getSession(m[1]);
      return s ? send(res, 200, s) : send(res, 404, { error: 'Session not found.' });
    }
    if (p === '/api/projects' && method === 'GET') return send(res, 200, app.projects());
    if (p === '/api/health' && method === 'GET') return send(res, 200, app.health());
    if (p === '/api/report' && method === 'GET') {
      const md = app.report();
      if (q.download) {
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="claude-code-retro-${new Date().toISOString().slice(0, 10)}.md"`,
          'cache-control': 'no-store',
        });
        return res.end(md);
      }
      return send(res, 200, { markdown: md });
    }

    if (p === '/api/forge/draft' && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, app.draft(b.patternId, b.kind, b));
    }
    if (p === '/api/forge/evaluate' && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, app.evaluate(b.patternId, b.description));
    }
    if (p === '/api/forge/refine' && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, await app.refine(b.patternId, b.kind, b));
    }
    if (p === '/api/forge/apply' && method === 'POST') {
      const b = await readJson(req);
      if (b.confirm !== true) return send(res, 400, { error: 'Confirm the write first.' });
      return send(res, 200, app.apply(b.patternId, b.kind, b));
    }
    return send(res, 404, { error: 'Not found.' });
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.resolve(WEB_ROOT, '.' + rel);
    if (!file.startsWith(WEB_ROOT + path.sep)) return send(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'Not found' });
      const ext = path.extname(file);
      const headers = {
        'content-type': MIME[ext] || 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
      };
      if (ext === '.html') {
        data = Buffer.from(String(data).replace('__TACIT_TOKEN__', token));
        headers['content-security-policy'] =
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
        headers['x-frame-options'] = 'DENY';
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  return {
    token,
    server,
    listen() {
      return new Promise((resolve, reject) => {
        const tryListen = (p, attemptsLeft) => {
          server.once('error', (err) => {
            if (err.code === 'EADDRINUSE' && attemptsLeft > 0) tryListen(p === 0 ? 0 : p + 1, attemptsLeft - 1);
            else reject(err);
          });
          server.listen(p, host, () => {
            boundPort = server.address().port;
            resolve({ port: boundPort, url: `http://localhost:${boundPort}` });
          });
        };
        tryListen(port, 10);
      });
    },
    close() {
      for (const res of clients) res.end();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

function hostAllowed(hostHeader, port) {
  if (!hostHeader) return false;
  const h = String(hostHeader).toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}
