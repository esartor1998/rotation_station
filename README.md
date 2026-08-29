# Rotation Station

An interactive Three.js viewer for `.obj` models — load a file, a `.zip`, a folder,
or a URL; inspect it; then export a smooth, seamlessly-looping rotating **GIF**.

## Run

```bash
npm install
npm start          # http://localhost:4182
```

Load a model (Open files / drag-drop a `.zip` or folder / paste a URL), open the
**GIF turntable** panel, hit **Preview** to dial in frames, FPS, pitch and roll,
then **Record GIF**.

## Configuration (env vars)

| Variable      | Default   | Purpose                                                        |
|---------------|-----------|----------------------------------------------------------------|
| `PORT`        | `4182`    | Port to listen on.                                             |
| `HOST`        | `0.0.0.0` | Bind address. `0.0.0.0` lets a reverse proxy reach it.         |
| `TRUST_PROXY` | *(unset)* | Set behind a proxy so Express reads `X-Forwarded-*`. `1`, `true`, or a subnet. Leave unset when exposed directly. |

`GET /healthz` returns `200 ok` for health checks.

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

- Local files (uploads, zips, folders) are parsed entirely in the browser —
  nothing is written to the server.
- The `proxy` endpoint blocks non-`http(s)` schemes and private/internal
  addresses (SSRF), re-validates redirects, times out, and caps response size.
  Add rate-limiting before exposing it publicly.
- GIF frame delays are stored in centiseconds, so 30 fps → ~33 ms/frame. Use 33
  or 50 fps for an exact rate.
