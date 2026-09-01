import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// host/port are configurable for deployment, the defaults are fine locally
const PORT = Number(process.env.PORT) || 4182;
const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 so a reverse proxy can reach it

const app = express();
app.disable('x-powered-by');

// behind a reverse proxy, set TRUST_PROXY (e.g. TRUST_PROXY=1, or a subnet) so
// Express reads X-Forwarded-* properly. leave it unset if the app is exposed
// directly: trusting those headers with no proxy in front lets anyone spoof
// their IP, which would let them dodge the rate limit
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', tp === 'true' ? true : /^\d+$/.test(tp) ? Number(tp) : tp);
}

// ---- find the static files --------------------------------------------------
// prefer a ./public folder, but fall back to this file's own directory so the
// app still runs if everything got downloaded flat (index.html next to this)
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;

if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
  console.error(
    '\n  \u2717 index.html not found.\n' +
    `    Looked in: ${path.join(__dirname, 'public')} and ${__dirname}\n` +
    '    Make sure index.html and viewer.js sit in a "public" folder\n' +
    '    next to server.js (or in the same folder as server.js).\n'
  );
}

app.use(express.static(PUBLIC_DIR));

// ---- proxy hardening --------------------------------------------------------
// the viewer sends the model, its .mtl and every texture the .mtl names through
// here. those URLs come out of an untrusted model file rather than from someone
// typing them, so this has to defend against SSRF: otherwise a nasty model could
// point them at localhost, internal services, or cloud metadata
// (169.254.169.254) and read back the response. so we block private address
// ranges, re-check every redirect hop, time out, and cap the response size
const MAX_BYTES = Number(process.env.PROXY_MAX_BYTES) || 25 * 1024 * 1024; // 25 MB per resource
const FETCH_TIMEOUT_MS = Number(process.env.PROXY_CONNECT_TIMEOUT_MS) || 8000;   // per hop, to headers
const STREAM_DEADLINE_MS = Number(process.env.PROXY_STREAM_TIMEOUT_MS) || 20000; // whole request
const MAX_REDIRECTS = 4;
const MAX_URL_LENGTH = 2048;
const PROXY_DISABLED = /^(1|true|yes)$/i.test(process.env.DISABLE_PROXY || '');

// ---- abuse controls ---------------------------------------------------------
// the proxy fetches URLs an attacker picks, so past SSRF the main risk is just
// volume: someone spamming links to huge files to chew up our bandwidth. a
// per-IP token bucket lets a normal load through (which fires the .mtl plus
// every texture at once) while capping sustained traffic. the concurrency caps
// sit above the browser's own ~6 connections, so real loads pass but sockets
// and memory stay bounded
const RL_BURST = Number(process.env.PROXY_RATE_BURST) || 60;          // burst allowance / IP
const RL_REFILL_PER_SEC = Number(process.env.PROXY_RATE_REFILL) || 1; // sustained req/s / IP
const MAX_CONCURRENT = Number(process.env.PROXY_MAX_CONCURRENT) || 24;         // global in-flight
const MAX_CONCURRENT_PER_IP = Number(process.env.PROXY_MAX_CONCURRENT_PER_IP) || 8;

const buckets = new Map();        // ip -> { tokens, last }
const inFlightPerIp = new Map();  // ip -> count
let inFlight = 0;

// returns 0 if allowed, otherwise the Retry-After value in seconds
function takeToken(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: RL_BURST, last: now }; buckets.set(ip, b); }
  b.tokens = Math.min(RL_BURST, b.tokens + ((now - b.last) / 1000) * RL_REFILL_PER_SEC);
  b.last = now;
  if (b.tokens < 1) return Math.max(1, Math.ceil((1 - b.tokens) / RL_REFILL_PER_SEC));
  b.tokens -= 1;
  return 0;
}

// drop idle buckets so the map can't grow forever if someone rotates IPs
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) {
    const t = Math.min(RL_BURST, b.tokens + ((now - b.last) / 1000) * RL_REFILL_PER_SEC);
    if (t >= RL_BURST && now - b.last > 60_000) buckets.delete(ip);
  }
  if (buckets.size > 100_000) buckets.clear(); // hard cap: shed state under a flood
}, 60_000).unref();

function isPrivateAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;      // this-host / private / loopback
    if (a === 169 && b === 254) return true;                 // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;        // private
    if (a === 192 && b === 168) return true;                 // private
    if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT
    if (a >= 224) return true;                               // multicast / reserved
    return false;
  }
  if (kind === 6) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;              // loopback / unspecified
    if (l.startsWith('fe80')) return true;                  // link-local
    if (l.startsWith('fc') || l.startsWith('fd')) return true; // unique local (fc00::/7)
    const mapped = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);  // IPv4-mapped
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // not an IP we recognise, so treat it as unsafe
}

// reject anything that isn't http(s), or that resolves to a private address
async function assertSafeUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  const host = url.hostname.replace(/^\[|\]$/g, ''); // unwrap IPv6 literals
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((r) => r.address);
    } catch {
      throw new Error('DNS resolution failed');
    }
  }
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) throw new Error('Blocked private/internal address');
  }
  return url;
}

// follow redirects by hand so every hop gets re-checked. a public URL can 302
// to an internal one, and automatic redirects would sail straight past the IP
// check
async function safeFetch(startUrl) {
  let target = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(target);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(target, { redirect: 'manual', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      target = new URL(loc, target).href;
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

// ---- health check, handy for reverse proxies and orchestrators --------------
app.get('/health', (_req, res) => res.type('text/plain').send('ok'));

// ---- the proxy endpoint itself ----------------------------------------------
app.get('/proxy', async (req, res) => {
  if (PROXY_DISABLED) return res.status(403).send('Remote URL loading is disabled.');

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const target = req.query.url;
  if (typeof target !== 'string') return res.status(400).send('Pass a "url" query parameter.');
  if (target.length > MAX_URL_LENGTH) return res.status(414).send('URL too long.');

  // per-IP rate limit. the token bucket allows a model's texture burst but caps floods
  const retryAfter = takeToken(ip);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).send('Rate limit exceeded. Slow down.');
  }

  // concurrency caps keep sockets and bandwidth bounded without blocking a normal load
  if (inFlight >= MAX_CONCURRENT) {
    res.set('Retry-After', '2');
    return res.status(503).send('Server busy, retry shortly.');
  }
  const perIp = inFlightPerIp.get(ip) || 0;
  if (perIp >= MAX_CONCURRENT_PER_IP) {
    res.set('Retry-After', '2');
    return res.status(429).send('Too many concurrent requests.');
  }

  inFlight++;
  inFlightPerIp.set(ip, perIp + 1);
  const started = Date.now();
  let reader = null;

  try {
    const upstream = await safeFetch(target);
    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream responded ${upstream.status}.`);
    }

    const declared = Number(upstream.headers.get('content-length') || 0);
    if (declared && declared > MAX_BYTES) {
      return res.status(413).send('Remote file exceeds size limit.');
    }

    // pass the real content type through so images and text both work downstream
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Access-Control-Allow-Origin', '*');

    if (!upstream.body) return res.end();

    // stream with a hard byte cap and a whole-request deadline, and respect the
    // client's backpressure, so neither a huge/endless upstream nor a slow
    // reader can eat all our memory. the byte cap also kills gzip bombs, since
    // it counts bytes after decompression as they arrive
    reader = upstream.body.getReader();
    let total = 0;
    for (;;) {
      if (Date.now() - started > STREAM_DEADLINE_MS) { await reader.cancel(); return res.destroy(); }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { await reader.cancel(); return res.destroy(); }
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve)); // backpressure
      }
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(502).send(`Proxy error: ${err.message}`);
    else res.destroy();
  } finally {
    try { reader && reader.cancel(); } catch {}
    inFlight = Math.max(0, inFlight - 1);
    const n = (inFlightPerIp.get(ip) || 1) - 1;
    if (n <= 0) inFlightPerIp.delete(ip); else inFlightPerIp.set(ip, n);
  }
});

app.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Rotation Station \u2192 http://${shown}:${PORT}`);
  console.log(`Serving static files from: ${PUBLIC_DIR}`);
  if (process.env.TRUST_PROXY) console.log(`trust proxy: ${app.get('trust proxy')}`);
  console.log(PROXY_DISABLED
    ? 'proxy: DISABLED (remote URL loading off)'
    : `proxy: on · ${RL_BURST} burst + ${RL_REFILL_PER_SEC}/s per IP · ${MAX_CONCURRENT_PER_IP}/${MAX_CONCURRENT} concurrent · ${(MAX_BYTES / 1048576).toFixed(0)}MB cap`);
});
