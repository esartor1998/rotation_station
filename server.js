import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 4182;
const app = express();

// ---- Locate the static files ------------------------------------------------
// Prefer a ./public folder, but fall back to the server's own directory so the
// app still runs if the files were downloaded flat (index.html next to this).
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

// ---- Proxy hardening --------------------------------------------------------
// The viewer routes the .obj, its .mtl, AND every texture the .mtl names through
// this endpoint. Those texture/mtl URLs come from an untrusted model file, not
// from the user typing them, so the proxy must defend against SSRF: a malicious
// model could otherwise point the URLs at internal services, cloud metadata
// (169.254.169.254), localhost, etc. We therefore block private address ranges,
// re-validate every redirect hop, time out, and cap the response size.
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per resource
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 4;

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
  return true; // not a recognizable IP → treat as unsafe
}

// Reject non-http(s) schemes and any host that resolves to a private address.
async function assertSafeUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  const host = url.hostname;
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

// Follow redirects manually so each hop is re-validated (a public URL can 302 to
// an internal one — automatic redirects would sail right past the IP check).
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

// ---- Proxy endpoint ---------------------------------------------------------
app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (typeof target !== 'string') {
    return res.status(400).send('Pass a "url" query parameter.');
  }

  try {
    const upstream = await safeFetch(target);
    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream responded ${upstream.status}.`);
    }

    const declared = Number(upstream.headers.get('content-length') || 0);
    if (declared && declared > MAX_BYTES) {
      return res.status(413).send('Remote file exceeds size limit.');
    }

    // Forward the real content type so images and text both work downstream.
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.set('Cache-Control', 'no-store');
    res.set('Access-Control-Allow-Origin', '*');

    if (!upstream.body) return res.end();

    // Stream with a hard byte cap so an oversized/endless response can't OOM us.
    const reader = upstream.body.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        await reader.cancel();
        return res.destroy();
      }
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(502).send(`Proxy error: ${err.message}`);
    else res.destroy();
  }
});

app.listen(PORT, () => {
  console.log(`OBJ preview \u2192 http://localhost:${PORT}`);
  console.log(`Serving static files from: ${PUBLIC_DIR}`);
});
