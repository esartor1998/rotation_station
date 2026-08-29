import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 4182;
const app = express();

// ---- Static frontend --------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ---- Remote .obj proxy ------------------------------------------------------
// The browser can't fetch arbitrary cross-origin URLs (CORS), so when the user
// pastes a link we pull the file server-side and stream it back same-origin.
//
// NOTE: this is boilerplate. Before exposing it publicly you should restrict
// which hosts can be fetched (SSRF protection), cap the response size, etc.
app.get('/proxy', async (req, res) => {
  const target = req.query.url;

  if (typeof target !== 'string' || !/^https?:\/\//i.test(target)) {
    return res.status(400).send('Pass a valid http(s) "url" query parameter.');
  }

  try {
    const upstream = await fetch(target, { redirect: 'follow' });
    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream responded ${upstream.status}.`);
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(body);
  } catch (err) {
    res.status(502).send(`Could not fetch that URL: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`OBJ preview → http://localhost:${PORT}`);
});
