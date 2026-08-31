# Rotation Station

An interactive Three.js viewer for `.obj` models — load a file, a `.zip`, a folder,
or a URL; inspect it; then export a smooth, seamlessly-looping rotating **GIF**.

## Run

```bash
npm install
npm start          # http://localhost:4182
```

Load a model (Open files / drag-drop a `.zip` or folder / paste a URL), open the
**GIF turntable** panel, pick a **Rotation speed** and **Smoothness**, tweak pitch
and roll, then **Record GIF**. On a touchscreen: one finger rotates, two fingers
pinch-zoom and pan.

## Configuration (env vars)

| Variable      | Default   | Purpose                                                        |
|---------------|-----------|----------------------------------------------------------------|
| `PORT`        | `4182`    | Port to listen on.                                             |
| `HOST`        | `0.0.0.0` | Bind address. `0.0.0.0` lets a reverse proxy reach it.         |
| `TRUST_PROXY` | *(unset)* | Set behind a proxy so Express reads `X-Forwarded-*` (needed for correct per-IP rate limiting). `1`, `true`, or a subnet. Leave unset when exposed directly. |
| `DISABLE_PROXY` | *(unset)* | Set to `1` to turn off remote-URL loading entirely (uploads still work). |
| `PROXY_MAX_BYTES` | `26214400` | Max bytes streamed per fetched resource (25 MB). |
| `PROXY_RATE_BURST` | `60` | Per-IP burst allowance (one model load = the .mtl + every texture). |
| `PROXY_RATE_REFILL` | `1` | Per-IP sustained requests/sec after the burst is spent. |
| `PROXY_MAX_CONCURRENT` | `24` | Global cap on in-flight upstream fetches. |
| `PROXY_MAX_CONCURRENT_PER_IP` | `8` | Per-IP cap on in-flight fetches (above the browser's ~6). |
| `PROXY_CONNECT_TIMEOUT_MS` | `8000` | Time-to-headers timeout per hop. |
| `PROXY_STREAM_TIMEOUT_MS` | `20000` | Whole-request deadline including streaming. |

`GET /healthz` returns `200 ok` for health checks.

### Proxy abuse hardening

`/proxy` is the only server-side surface (uploads/zips are parsed entirely in the
browser). It is hardened against a bot spamming links to hostile/large files:

- **SSRF:** only `http(s)`; blocks private/loopback/link-local/CGNAT ranges
  (IPv4 + IPv6, incl. IPv4-mapped and bracketed literals); resolves DNS and
  checks every address; re-validates each redirect hop.
- **Rate limit:** per-IP token bucket — allows a normal load's texture burst,
  caps sustained volume (`429` + `Retry-After`).
- **Concurrency:** per-IP and global in-flight caps (`429`/`503`).
- **Size/time:** 25 MB streamed cap per resource (also defuses gzip
  decompression bombs, since it counts decompressed bytes), plus connect and
  whole-request deadlines.
- **Backpressure:** respects the client's read speed so a slow receiver can't
  balloon server memory. Nothing is buffered to disk or cached.
- **Kill-switch:** `DISABLE_PROXY=1` removes remote loading altogether.

Set `TRUST_PROXY` behind a reverse proxy so the rate limiter keys on the real
client IP rather than the proxy's.

## Behind a reverse proxy

The app works both at a domain root and at a sub-path. All asset and API URLs are
**relative**, and the remote-URL feature calls `proxy` relative to the page, so a
sub-path mount works **as long as the app is served with a trailing slash**
(`/rotation-station/`, not `/rotation-station`). Redirect the slash-less form.

Run the app with `TRUST_PROXY=1` when a proxy sits in front.

### nginx — sub-path

```nginx
location = /rotation-station { return 301 /rotation-station/; }   # enforce trailing slash
location /rotation-station/ {
    proxy_pass http://127.0.0.1:4182/;      # trailing slash strips the prefix
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### nginx — root

```nginx
location / {
    proxy_pass http://127.0.0.1:4182;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Caddy — sub-path

```
example.com {
    redir /rotation-station /rotation-station/
    handle_path /rotation-station/* {
        reverse_proxy 127.0.0.1:4182
    }
}
```

### TLS / mixed content

Terminating HTTPS at the proxy is fine. Every external resource a model
references (its `.mtl`, textures) is fetched **server-side** through the
same-origin `proxy` endpoint, so an `https` page never makes an insecure
cross-origin request. The only third-party resources loaded directly by the
browser are the Three.js / fflate modules from the jsDelivr CDN (also `https`);
vendor those locally if you need a CDN-free deployment.

## Notes / limits

- **Rotation speed / Smoothness** presets set the frame count and playback fps
  for you: speed fixes how long one turn takes, smoothness sets the fps, and
  frames-per-rotation is derived — so a smoother GIF adds frames without slowing
  the spin.
- **Touch:** one-finger drag rotates, two-finger pinch zooms and pans. The
  desktop mouse/keyboard controls are unchanged.
- GIFs export with a **transparent background** by default. On export the GIF is
  **trimmed to the model's content box** (union across all frames) and encoded
  with a **single global colour palette** — both cut file size substantially.
  All of this runs in the browser; the GIF is never uploaded, so there's no
  server-side processing of untrusted data (the secure choice — no `gifsicle`
  subprocess on user content). Trimming applies to transparent exports; a solid
  background has no transparent border to trim.
- GIF alpha is 1-bit, so anti-aliased edges are cut at a hard threshold. The
  reference grid is omitted from the GIF automatically.
- Local files (uploads, zips, folders) are parsed entirely in the browser.
- A **remote `.zip`** works too: paste the URL and it's fetched (through the
  hardened proxy) and unzipped in the browser, same as a local one. If an archive
  has no `.obj`, the app names the unsupported model formats it found (e.g. a
  `.fbx`/`.dae`-only rip) instead of failing vaguely.
- OBJ text is normalized (BOM stripped, CR/CRLF line endings) before parsing, so
  files from various exporters don't silently yield "no geometry".
- The `proxy` endpoint blocks non-`http(s)` schemes and private/internal
  addresses (SSRF), re-validates redirects, times out, and caps response size.
  Add rate-limiting before exposing it publicly.
- GIF frame delays are stored in centiseconds, so 30 fps → ~33 ms/frame.
- Three.js, fflate, and gifenc load from the jsDelivr CDN via the import map in
  `index.html`. To run without a CDN, download those three files and repoint the
  import map at local copies.
