// Tiny local HTTP API over the search engine. Localhost only, no external services.
import http from 'node:http';
import { open, search } from './search.mjs';

const PORT = Number(process.env.PORT || 8791);
const db = open();
const meta = Object.fromEntries(db.prepare('SELECT k, v FROM meta').all().map(r => [r.k, r.v]));

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const send = (code, obj) => {
    const b = JSON.stringify(obj);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(b),
    });
    res.end(b);
  };

  if (u.pathname === '/health') {
    const total = db.prepare('SELECT COUNT(*) AS n FROM docs').get().n;
    return send(200, {
      ok: true,
      docs: total,
      built_at: meta.built_at,
      weights: JSON.parse(meta.weights || '{}'),
    });
  }

  if (u.pathname === '/search') {
    const raw = u.searchParams.get('q') || '';
    const prefix = u.searchParams.get('prefix') === '1';
    const r = search(db, {
      q: prefix && raw ? raw.split(/\s+/).map(t => (t.endsWith('*') ? t : t + '*')).join(' ') : raw,
      phrase: u.searchParams.get('phrase') || '',
      type: u.searchParams.get('type') || '',
      status: u.searchParams.get('status') || '',
      category: u.searchParams.get('category') || '',
      bounty: u.searchParams.get('bounty') || '',
      limit: Math.min(Number(u.searchParams.get('limit') || 10), 50),
      fuzzy: u.searchParams.get('fuzzy') === '1',
    });
    return send(200, { query: raw, prefix, ...r });
  }

  if (u.pathname === '/doc') {
    const d = db.prepare('SELECT * FROM docs WHERE id = ?').get(u.searchParams.get('id'));
    return d ? send(200, d) : send(404, { error: 'not_found', id: u.searchParams.get('id') });
  }

  return send(404, { error: 'not_found', hint: 'try /health, /search?q=... or /doc?id=task:...' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`search api on http://127.0.0.1:${PORT}  (/health /search?q= /doc?id=)`);
});