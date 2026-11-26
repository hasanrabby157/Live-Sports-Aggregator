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
function abbr(a, b) { // "sysw" ~ "sydney sixers women"
  if (a.includes(' ') || a.length < 3 || a.length > 5 || b.length < a.length * 2 || a[0] !== b[0]) return false;
  const f = b.replace(/ /g, ''); let i = 0;
  for (const ch of a) { i = f.indexOf(ch, i); if (i < 0) return false; i++; }
  return true;
}
function same(a, b) {
  a = clean(a); b = clean(b);
  if (!a || !b) return false;
  if (a === b || abbr(a, b) || abbr(b, a)) return true;
  if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))) return true;
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  const inter = [...A].filter(x => B.has(x)).length;
  return inter / (A.size + B.size - inter) >= 0.5;
}
function teams(it) {
  const n = x => (x && x.name) || x;
  if (it.team1 && it.team2) return [n(it.team1), n(it.team2)];
  const nm = dname(it.name).replace(/\(.*?\)|\[.*?\]/g, ' ');
  const p = nm.split(/\s+(?:vs\.?|v|-|–|—|@|x)\s+/i).map(x => x.trim());
  if (p.length < 2) return null;
  p[0] = p[0].replace(/^.*[:|]\s*/, '');
  p[1] = p[1].replace(/\s*[:|].*$/, '');
  return p[0] && p[1] ? [p[0], p[1]] : null;
}
const junk = it => (it.genres || []).includes('NETWORKS') || it.releaseInfo === '24/7' || /24\/7/.test(it.description || '')
  || /^(leaf|recap):/.test(it.id || '');
function matches(a, b) {
  if (a.t && b.t) return (same(a.t[0], b.t[0]) && same(a.t[1], b.t[1])) || (same(a.t[0], b.t[1]) && same(a.t[1], b.t[0]));
  return !a.t && !b.t && clean(a.name) === clean(b.name);
}

// ---------- catalog ----------
const INC = /live|event|today|upcoming|football|soccer|cricket|basketball|hockey|tennis|sport/i;
const EXC = /anime|network|24.?7|replay|recap|vod|custom|world|sports ?event/i;
const blob = it => [it.name, it.releaseInfo, it.description, (it.genres || []).join(' '), it.category].join(' ');
const dname = n => String(n || '').replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '').replace(/^upcoming\s+/i, '').trim();
function sportOf(t) {
  if (/american football|\bnfl\b|ncaaf|baseball|\bmlb\b|anime|wwe|wrestl|\bufc\b|\bmma\b|boxing|\bf1\b|formula|motogp|motorsport|nascar|golf|darts|snooker|rugby|cycling|\bsports? (world|event)\b/i.test(t)) return null;
  if (/cricket|wbbl|\bbbl|big bash|\bipl\b|\bicc\b|\bt20|\bt10\b|\bodi\b|test match|sa20|ilt20|\bcpl\b|the hundred|\bpsl\b|\blpl\b|\bbpl\b|smash/i.test(t)) return 'Cricket';
  if (/basketball|\bnba\b|wnba|euroleague|ncaab/i.test(t)) return 'Basketball';
  if (/hockey|\bnhl\b|\bahl\b/i.test(t)) return 'Hockey';
  if (/tennis|\batp\b|\bwta\b|grand slam/i.test(t)) return 'Tennis';
  if (/football|soccer|premier league|la liga|laliga|serie a|bundesliga|ligue 1|champions league|\bucl\b|europa|\bmls\b|\bepl\b|copa|libertadores|liga mx|\bisl\b|\bafc\b|uefa|fifa|eredivisie|championship|\bfc\b/i.test(t)) return 'Football';
  return 'Sports';
}
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function status(it, c) {
  const n = String(it.name || '').trim(), t = blob(it);
  if (/^🔴/.test(n)) return 'live';
  if (/^(🔜|⏱|➡|upcoming\b)/i.test(n)) return 'upcoming';
  if (/^✅/.test(n)) return 'ended';
  if (/\b(ended|finished|full.?time|ft|final score|completed)\b/i.test(t)) return 'ended';
  if (/upcoming|starts? (in|at|on)|scheduled|kick.?off|⏱|\bin \d+ ?(h|m|min|hours?)\b/i.test(t)) return 'upcoming';
  if (/🔴|\blive\b|in.?play|\b\d{1,3}'|1st half|2nd half|half.?time|quarter|period|innings/i.test(t)) return 'live';
  const d = t.match(/(\d{1,2}) ([A-Za-z]{3}) (\d{4}) · (\d\d):(\d\d) UTC/);
  if (d && MON[d[2].toLowerCase()] !== undefined) return Date.UTC(+d[3], MON[d[2].toLowerCase()], +d[1], +d[4], +d[5]) > Date.now() ? 'upcoming' : 'ended';
  const k = c.id + ' ' + c.name;
  if (/(^|[_\s])live([_\s]|$)/i.test(k)) return 'live';
  if (/upcoming/i.test(k)) return 'upcoming';
  return null;
}
async function pool(tasks, n = 12) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { try { await tasks[i++](); } catch {} } }));
}
function add(list, x) {
  const g = list.find(g => matches(g, x));
  if (!g) return list.push({ ...x, src: [x.src] });
  if (!g.src.some(s => s[0] === x.src[0] && s[2] === x.src[2])) g.src.push(x.src);
  if (!g.p) g.p = x.p;
  if (g.sp === 'Sports' && x.sp !== 'Sports') g.sp = x.sp;
  if (x.name.length > g.name.length) g.name = x.name;
}

async function buildAll(addons, dbg) {
  const G = { live: [], upcoming: [] }, jobs = [];
  await Promise.all(addons.map(async (a, ai) => {
    let m;
    try { m = await manifest(a); } catch (e) { dbg && dbg.push({ addon: a.base, error: String(e.message) }); return; }
    for (const c of m.catalogs) {
      const k = c.id + ' ' + c.name;
      if (/^(other|series|movie)$/.test(c.type) || !INC.test(k) || EXC.test(k)) continue;
      const opts = (c.extra || []).find(e => e.name === 'genre')?.options || [];
      const targets = opts.length ? opts.map(o => [o, sportOf(o)]).filter(([, s]) => s && s !== 'Sports') : [[null, null]];
      for (const [g, gs] of targets) jobs.push(async () => {
        const url = `${a.base}/catalog/${c.type}/${c.id}${g ? '/genre=' + encodeURIComponent(g) : ''}.json`;
        const d = { addon: m.label, catalog: c.id + (g ? ' | ' + g : ''), total: 0, live: 0, upcoming: 0, sample: [] };
        try {
          const items = ((await getJSON(url)).metas || []).slice(0, 150);
          d.total = items.length;
          for (const it of items) {
            const st = junk(it) ? 'junk' : status(it, c), sp = gs || sportOf(blob(it) + ' ' + c.id + ' ' + c.name);
            if (d.sample.length < 3) d.sample.push({ name: it.name, releaseInfo: it.releaseInfo, status: st, sport: sp });
            if (!sp || !G[st]) continue;
            d[st]++;
            add(G[st], { name: dname(it.name), sp, t: teams(it), p: it.poster || it.background, src: [ai, c.type, it.id] });
          }
        } catch (e) { d.error = String(e.message); }
        dbg && dbg.push(d);
      });
    }
  }));
  await pool(jobs);
  const metas = l => l.sort((a, b) => b.src.length - a.src.length).map(g => ({
    id: 'agg:' + enc({ n: g.name, p: g.p, s: g.src }), type: 'tv', name: g.name, poster: g.p, posterShape: 'landscape',
    description: `${g.sp} · ${g.src.length} source(s)`, genres: [g.sp], _sp: g.sp,
  }));
  return { live: metas(G.live), upcoming: metas(G.upcoming) };
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
    const dm = p.match(/^\/([^/]+)\/debug\.json$/);
    if (dm) { const dbg = []; await buildAll(parseCfg(dm[1]), dbg); return send(res, 200, dbg); }
    const m = p.match(/^\/([^/]+)\/(?:manifest\.json|(catalog|meta|stream)\/([^/]+)\/(.+?)\.json)$/);
    if (!m) return send(res, 404, { error: 'not found' });
    const [, seg, kind, , rawId] = m;
    const addons = parseCfg(seg);
    if (!kind) return send(res, 200, {
      id: 'community.sports.aggregator', version: '1.2.0', name: '🏆 Sports Aggregator',
      description: 'One clean live-sports catalogue merged from your addons, with dead links filtered.',
      resources: ['catalog', 'meta', 'stream'], types: ['tv'], idPrefixes: ['agg:'],
      catalogs: [
        { type: 'tv', id: 'agg_live', name: '🔴 Live Now', extra: [{ name: 'skip', isRequired: false }] },
        { type: 'tv', id: 'agg_cricket', name: '🏏 Live Cricket', extra: [{ name: 'skip', isRequired: false }] },
        { type: 'tv', id: 'agg_football', name: '⚽ Live Football', extra: [{ name: 'skip', isRequired: false }] },
        { type: 'tv', id: 'agg_upcoming', name: '⏱ Upcoming', extra: [{ name: 'skip', isRequired: false }] }],
      behaviorHints: { configurable: true },
    });
    const id = decodeURIComponent(rawId).split('/')[0];
    if (kind === 'catalog') {
      if (/skip=[1-9]/.test(decodeURIComponent(rawId))) return send(res, 200, { metas: [] });
      let c = cCache.get(seg);
      if (!c || Date.now() - c.t > 6e4) { c = { t: Date.now(), v: await buildAll(addons) }; cCache.set(seg, c); }
      const L = id === 'agg_upcoming' ? c.v.upcoming.slice(0, 80)
        : c.v.live.filter(x => id === 'agg_cricket' ? x._sp === 'Cricket' : id === 'agg_football' ? x._sp === 'Football' : true);
      return send(res, 200, { metas: L.map(({ _sp, ...m }) => m) });
    }
    const pl = dec(id.replace(/^agg:/, ''));
    if (kind === 'meta') return send(res, 200, { meta: { id, type: 'tv', name: pl.n, poster: pl.p, background: pl.p, posterShape: 'landscape' } });
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    return send(res, 200, { streams: await buildStreams(addons, pl, ip) });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, () => console.log('Listening on ' + PORT));
