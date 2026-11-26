// Sports Aggregator: Stremio/Nuvio meta-addon. Node 18+, no dependencies.
const http = require('http'), zlib = require('zlib');
const PORT = process.env.PORT || 3000;

const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Sports Aggregator</title><style>:root{color-scheme:light dark}body{font:16px system-ui;max-width:640px;margin:auto;padding:16px}
textarea{width:100%;height:150px;box-sizing:border-box}button{padding:10px 16px;margin:8px 4px 8px 0}code{word-break:break-all;display:block;margin-top:8px}</style>
<h2>Sports Aggregator</h2><p>Paste your addon manifest URLs, one per line (3-4 works best).</p>
<textarea id=u placeholder="https://.../manifest.json"></textarea><br>
<button onclick=gen()>Generate install link</button><button onclick=cp()>Copy</button>
<code id=o></code><script>
function gen(){const u=document.getElementById('u').value.split(/\\s+/).filter(x=>/^https?:\\/\\//.test(x));
if(!u.length){o.textContent='Add at least one URL';return}
const c=btoa(unescape(encodeURIComponent(JSON.stringify({u})))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
o.textContent=location.origin+'/'+c+'/manifest.json'}
function cp(){navigator.clipboard.writeText(o.textContent)}</script>`;

// ---------- helpers ----------
const enc = o => zlib.deflateSync(Buffer.from(JSON.stringify(o))).toString('base64url');
const dec = s => JSON.parse(zlib.inflateSync(Buffer.from(s, 'base64url')).toString());
const priv = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/;

async function getJSON(url, { ms = 8000, headers = {} } = {}) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers, signal: c.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function parseCfg(seg) {
  const cfg = JSON.parse(Buffer.from(seg, 'base64url').toString());
  return (cfg.u || []).filter(u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && !priv.test(x.hostname); } catch { return false; } })
    .slice(0, 8).map(u => ({ base: u.replace(/\/manifest\.json.*$/, '').replace(/\/$/, '') }));
}

const mCache = new Map(), cCache = new Map();
async function manifest(a) {
  const c = mCache.get(a.base);
  if (c && Date.now() - c.t < 6e5) return c.v;
  const m = await getJSON(a.base + '/manifest.json');
  const v = { label: (m.name || 'Addon').replace(/[^\w\s]/g, '').trim().split(/\s+/).slice(0, 2).join(' '), catalogs: m.catalogs || [] };
  mCache.set(a.base, { t: Date.now(), v });
  return v;
}

// ---------- matching ----------
const clean = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\b(fc|cf|sc|afc|ac|cd|fk|sk|bk|kk|club|de|the|vs)\b/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function same(a, b) {
  a = clean(a); b = clean(b);
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))) return true;
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  const inter = [...A].filter(x => B.has(x)).length;
  return inter / (A.size + B.size - inter) >= 0.5;
}
function teams(it) {
  const n = x => (x && x.name) || x;
  if (it.team1 && it.team2) return [n(it.team1), n(it.team2)];
  const p = String(it.name || '').replace(/^[^\w]+/, '').split(/\s+(?:vs\.?|v|-|@|x)\s+/i);
  return p.length === 2 ? p : null;
}
const junk = it => (it.genres || []).includes('NETWORKS') || it.releaseInfo === '24/7' || /24\/7/.test(it.description || '')
  || /^(leaf|recap):/.test(it.id || '');
function matches(a, b) {
  if (a.t && b.t) return (same(a.t[0], b.t[0]) && same(a.t[1], b.t[1])) || (same(a.t[0], b.t[1]) && same(a.t[1], b.t[0]));
  return !a.t && !b.t && clean(a.name) === clean(b.name);
}

// ---------- catalog ----------
const INC = /live|event|today|football|soccer|cricket|basketball|hockey|baseball|tennis|other|sport/i;
const EXC = /anime|network|24.?7|replay|recap|vod|custom|world|upcoming/i;

async function buildCatalog(addons) {
  const groups = [];
  await Promise.all(addons.map(async (a, ai) => {
    try {
      const m = await manifest(a);
      const cats = m.catalogs.filter(c => INC.test(c.id + ' ' + c.name) && !EXC.test(c.id + ' ' + c.name));
      await Promise.all(cats.map(async c => {
        try {
          const r = await getJSON(`${a.base}/catalog/${c.type}/${c.id}.json`);
          for (const it of (r.metas || []).slice(0, 100)) {
            if (junk(it)) continue;
            const x = { name: it.name, t: teams(it), p: it.poster || it.background, src: [ai, c.type, it.id] };
            const g = groups.find(g => matches(g, x));
            if (g) { if (!g.src.some(s => s[0] === ai && s[2] === it.id)) g.src.push(x.src); if (!g.p) g.p = x.p; }
            else groups.push({ ...x, src: [x.src] });
          }
        } catch {}
      }));
    } catch {}
  }));
  return groups.sort((a, b) => b.src.length - a.src.length).map(g => ({
    id: 'agg:' + enc({ n: g.name, p: g.p, s: g.src }), type: 'tv', name: g.name, poster: g.p, posterShape: 'landscape',
    description: `${g.src.length} source(s) found`,
  }));
}

// ---------- streams ----------
const badStream = s => !s.url || /google\.com|\/health$/.test(s.url) || /upgrade|support us|^tip:/i.test((s.name || '') + ' ' + (s.title || ''));
async function probe(s) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 4000);
  try {
    const r = await fetch(s.url, { headers: { Range: 'bytes=0-2047', ...(s.behaviorHints?.proxyHeaders?.request || {}) }, signal: c.signal });
    if (r.status === 401 || r.status === 403) { c.abort(); return 'unverified'; }
    if (r.status >= 400) { c.abort(); return 'dead'; }
    const isM3u = /m3u8|mpegurl/i.test(r.headers.get('content-type') || '') || /\.m3u8/i.test(s.url);
    if (!isM3u) { r.body?.cancel().catch(() => {}); return 'ok'; }
    const rd = r.body.getReader(), { value } = await rd.read();
    rd.cancel().catch(() => {});
    return Buffer.from(value || []).toString('utf8', 0, 300).includes('#EXTM3U') ? 'ok' : 'dead';
  } catch { return 'unverified'; } finally { clearTimeout(t); }
}
const rank = s => { const t = (s.resolution || '') + (s.title || ''); return (s.score || 0) + (/4k|2160/i.test(t) ? 40 : /1080/.test(t) ? 30 : /720/.test(t) ? 15 : 0); };

async function buildStreams(addons, payload, ip) {
  const fwd = ip ? { 'X-Forwarded-For': ip, 'X-Real-IP': ip } : {};
  const lists = await Promise.all(payload.s.map(async ([ai, type, id]) => {
    const a = addons[ai]; if (!a) return [];
    try {
      const [m, r] = await Promise.all([manifest(a), getJSON(`${a.base}/stream/${type}/${encodeURIComponent(id)}.json`, { ms: 7000, headers: fwd })]);
      return (r.streams || []).filter(s => !badStream(s)).map(s => ({ ...s, _l: m.label }));
    } catch { return []; }
  }));
  const all = lists.flat().slice(0, 60);
  const states = await Promise.all(all.map(probe));
  return all.map((s, i) => ({ s, st: states[i] })).filter(x => x.st !== 'dead')
    .sort((a, b) => (b.st === 'ok') - (a.st === 'ok') || rank(b.s) - rank(a.s))
    .map(({ s, st }) => ({
      name: `${st === 'ok' ? '✅' : '⚠️'} ${s._l}`,
      title: (st === 'ok' ? '' : 'Unverified (may still work)\n') + (s.title || ''),
      url: s.url, behaviorHints: s.behaviorHints,
    }));
}

// ---------- server ----------
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/' || p.endsWith('/configure')) return send(res, 200, PAGE, 'text/html; charset=utf-8');
    const m = p.match(/^\/([^/]+)\/(?:manifest\.json|(catalog|meta|stream)\/([^/]+)\/(.+?)\.json)$/);
    if (!m) return send(res, 404, { error: 'not found' });
    const [, seg, kind, , rawId] = m;
    const addons = parseCfg(seg);
    if (!kind) return send(res, 200, {
      id: 'community.sports.aggregator', version: '1.0.0', name: '🏆 Sports Aggregator',
      description: 'One clean live-sports catalogue merged from your addons, with dead links filtered.',
      resources: ['catalog', 'meta', 'stream'], types: ['tv'], idPrefixes: ['agg:'],
      catalogs: [{ type: 'tv', id: 'agg_live', name: '🔴 Live Sports', extra: [{ name: 'skip', isRequired: false }] }],
      behaviorHints: { configurable: true },
    });
    const id = decodeURIComponent(rawId).split('/')[0];
    if (kind === 'catalog') {
      if (/skip=[1-9]/.test(decodeURIComponent(rawId))) return send(res, 200, { metas: [] });
      let c = cCache.get(seg);
      if (!c || Date.now() - c.t > 6e4) { c = { t: Date.now(), v: await buildCatalog(addons) }; cCache.set(seg, c); }
      return send(res, 200, { metas: c.v });
    }
    const pl = dec(id.replace(/^agg:/, ''));
    if (kind === 'meta') return send(res, 200, { meta: { id, type: 'tv', name: pl.n, poster: pl.p, background: pl.p, posterShape: 'landscape' } });
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    return send(res, 200, { streams: await buildStreams(addons, pl, ip) });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, () => console.log('Listening on ' + PORT));
