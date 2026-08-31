# Rotation Station

A sorta interactive three.js model viewer. Can load a file, a `.zip`, a folder, or a URL;
inspect it; and always exports a smooth, seamlessly-looping rotating GIF.

Supported formats: **.obj** (+`.mtl`), **.dae** (Collada), **.gltf/.glb**,
**.stl**, **.ply**, and **.fbx**, each with their associated textures.

## Run

```bash
npm install
npm start          # http://localhost:4182
```

Load a model (Open files / drag-drop a `.zip` or folder / paste a URL), open the
**GIF turntable** panel, pick a **Rotation speed** and **Smoothness**, tweak pitch
and roll, then **Record GIF**. on a touchscreen, one finger rotates, two fingers
pinch-zoom and pan.

## Configuration (env vars)

| Variable      | Default   | Purpose                                                        |
|---------------|-----------|----------------------------------------------------------------|
| `PORT`        | `4182`    | port to listen on                                              |
| `HOST`        | `0.0.0.0` | bind address. `0.0.0.0` lets a reverse proxy reach it          |
| `TRUST_PROXY` | *(unset)* | set behind a proxy so Express reads `X-Forwarded-*` (needed for correct per-IP rate limiting). `1`, `true`, or a subnet. Leave unset when exposed directly  |
| `DISABLE_PROXY` | *(unset)* | set to `1` to turn off remote-URL loading entirely (uploads still work)  |
| `PROXY_MAX_BYTES` | `26214400` | max bytes streamed per fetched resource (25 MB)  |
| `PROXY_RATE_BURST` | `60` | per-IP burst allowance (one model load = the .mtl + every texture)  |
| `PROXY_RATE_REFILL` | `1` | per-IP sustained requests/sec after the burst is spent  |
| `PROXY_MAX_CONCURRENT` | `24` | global cap on in-flight upstream fetches  |
| `PROXY_MAX_CONCURRENT_PER_IP` | `8` | per-IP cap on in-flight fetches (above the browser's ~6)  |
| `PROXY_CONNECT_TIMEOUT_MS` | `8000` | time-to-headers timeout per hop  |
| `PROXY_STREAM_TIMEOUT_MS` | `20000` | whole-request deadline including streaming  |

`GET /health` returns `200 ok` for health checks.

### Proxy abuse hardening

`/proxy` is the only server-side surface (uploads/zips are parsed entirely in the
browser). Somewhat hardened against a bot spamming links to hostile/large files:

- **SSRF:** only `http(s)`; blocks private/loopback/link-local/CGNAT ranges
  (IPv4 + IPv6, incl. IPv4-mapped and bracketed literals); resolves DNS and
  checks every address; re-validates each redirect hop
- **Rate limit:** per-IP token bucket
- **Concurrency:** per-IP and global in-flight caps (`429`/`503`)
- **Size/time:** 25 MB streamed cap per resource, has connect and whole-request deadlines
- **Backpressure:** respects the client's read speed

Set `TRUST_PROXY` behind a reverse proxy so the rate limiter keys on the real
client IP rather than the proxy's!

## Behind a reverse proxy

The app works both at a domain root and at a sub-path, just please redirect the slash-less form.
Run the app with `TRUST_PROXY=1` when a proxy sits in front.

### nginx:  sub-path

```nginx
location = /rotation-station { return 301 /rotation-station/; }   # enforce trailing slash
location /rotation-station/ {
    proxy_pass http://127.0.0.1:4182/;      # trailing slash strips the prefix
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### nginx:  root

```nginx
location / {
    proxy_pass http://127.0.0.1:4182;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Caddy:  sub-path

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
references (its `.mtl`, textures) is fetched server-side through the
same-origin `proxy` endpoint, so an `https` page never makes an insecure
cross-origin request. The only third-party resources loaded directly by the
browser are the three.js / fflate modules from the jsDelivr CDN (also `https`);
vendor those locally if you need a CDN-free deployment.