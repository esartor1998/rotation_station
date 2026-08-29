import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { unzip } from 'fflate';

// ---------------------------------------------------------------------------
// Scene, camera, renderer
// ---------------------------------------------------------------------------
const stage = document.getElementById('stage');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f12);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(0, 0, 5);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.appendChild(renderer.domElement);

// Lighting — a soft key/fill so an untextured mesh still reads as a solid.
scene.add(new THREE.HemisphereLight(0xffffff, 0x202028, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(3, 5, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xbfd4ff, 0.5);
fill.position.set(-4, -1, -3);
scene.add(fill);

// Ground grid for spatial reference when moving the model around.
const grid = new THREE.GridHelper(20, 40, 0x2a2f38, 0x1c2027);
grid.position.y = -1.4;
scene.add(grid);

// `pivot` is what the user manipulates. Rotation lives on its quaternion,
// panning on its position. The loaded model is centered inside it so it
// always spins about its own middle.
const pivot = new THREE.Group();
scene.add(pivot);

// Fallback material for meshes that arrive with no material at all.
const defaultMaterial = new THREE.MeshStandardMaterial({
  color: 0x9aa4b2, metalness: 0.05, roughness: 0.75, side: THREE.DoubleSide,
});

let currentModel = null;   // the centered/scaled group inside the pivot
let currentName = 'model'; // basename of the loaded model, for the gif filename
let baseDistance = 5;      // camera Z that framed the model at zoom = 1
let activeBlobUrls = [];   // object URLs for uploaded textures, revoked on reload

// Turntable / GIF settings, driven by the tuning panel.
const settings = { frames: 60, fps: 30, pitch: 20, roll: 0, size: 480 };
let spinning = false;      // live preview spin
let capturing = false;     // GIF capture in progress
let phase = 0;             // 0..1 position within the current rotation
let lastFrameT = performance.now();

// Native timers captured up front, in case the capture library virtualises them.
const nativeRAF = window.requestAnimationFrame.bind(window);

// ---------------------------------------------------------------------------
// Loading — shared core
// ---------------------------------------------------------------------------

// Pull every filename referenced by `mtllib` lines out of the OBJ text.
function extractMtlLibs(objText) {
  const libs = [];
  const re = /^\s*mtllib\s+(.+)$/gim;
  let m;
  while ((m = re.exec(objText))) {
    m[1].trim().split(/\s+/).forEach((n) => n && libs.push(n));
  }
  return [...new Set(libs)];
}

const basename = (p) => p.split(/[\\/]/).pop();

// Build a same-origin proxy URL *relative to wherever the app is mounted*, so it
// keeps working behind a reverse proxy at a sub-path (e.g. /rotation-station/).
// Requires the page to be served with a trailing slash — see the deploy notes.
function proxyURL(target) {
  const u = new URL('proxy', document.baseURI);
  u.searchParams.set('url', target);
  return u.href;
}

// A 1×1 transparent PNG. Returned instead of ever handing a loader a file:// or
// bare OS path — browsers refuse to load those from an http(s) page ("may not
// load or link to file:///"), so we swap in a harmless pixel instead.
const BLANK_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Only http(s) survives as something we can safely route; everything else
// (file:, about:, C:\…) becomes the blank pixel.
function safeTextureURL(resolvedAbsolute) {
  return /^https?:\/\//i.test(resolvedAbsolute) ? proxyURL(resolvedAbsolute) : BLANK_PIXEL;
}

// mtlResolver(libName) -> Promise<string|null> returns the .mtl text.
// manager is a THREE.LoadingManager whose URL modifier routes texture requests
// to blob URLs (uploads) or the /proxy endpoint (web).
async function loadObjWithMaterials({ objText, objName, mtlResolver, manager }) {
  const libs = extractMtlLibs(objText);
  const objLoader = new OBJLoader(manager);
  let materialInfo = { requested: libs.length, loaded: 0 };

  if (libs.length && mtlResolver) {
    const texts = [];
    for (const lib of libs) {
      try {
        const t = await mtlResolver(lib);
        if (t) texts.push(t);
      } catch { /* missing .mtl — fall back to default material */ }
    }
    if (texts.length) {
      const mtlLoader = new MTLLoader(manager);
      const creator = mtlLoader.parse(texts.join('\n'), '');
      creator.preload();                 // builds materials + kicks off textures
      objLoader.setMaterials(creator);
      materialInfo.loaded = texts.length;
    }
  }

  let object;
  try {
    object = objLoader.parse(objText);
  } catch (err) {
    return status(`Parse failed: ${err.message}`, 'error');
  }
  if (!object || object.children.length === 0) {
    return status('No geometry found in that file.', 'error');
  }
  installModel(object, objName, materialInfo);
}

function installModel(object, name, materialInfo = {}) {
  if (currentModel) {
    pivot.remove(currentModel);
    disposeTree(currentModel);
  }

  let triangles = 0;
  object.traverse((child) => {
    if (!child.isMesh) return;
    if (!child.geometry.attributes.normal) child.geometry.computeVertexNormals();

    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat, i) => {
      // Only replace the blank material OBJLoader invents when no .mtl matched;
      // keep anything that came from an .mtl.
      if (isBlankObjMaterial(mat)) {
        if (Array.isArray(child.material)) child.material[i] = defaultMaterial;
        else child.material = defaultMaterial;
        return;
      }
      mat.side = THREE.DoubleSide;                 // preview-friendly
      if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace; // correct texture color
      mat.needsUpdate = true;
    });

    const g = child.geometry;
    triangles += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  });

  // Center the bounding box on the pivot origin, then scale so the largest
  // dimension is ~2 world units — frames any model consistently.
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const container = new THREE.Group();
  object.position.sub(center);
  container.add(object);
  container.scale.setScalar(2 / maxDim);

  currentModel = container;
  currentName = (name || 'model').replace(/\.[^.]+$/, '');
  pivot.add(container);

  resetView();

  document.getElementById('hud-name').textContent = name;
  document.getElementById('hud-tris').textContent = Math.round(triangles).toLocaleString();

  const { requested = 0, loaded = 0 } = materialInfo;
  if (requested && !loaded) status(`Loaded ${name} — .mtl not found, using default material`, 'ok');
  else if (loaded) status(`Loaded ${name} with materials`, 'ok');
  else status(`Loaded ${name}`, 'ok');
}

// OBJLoader gives meshes with no matched material a nameless MeshPhongMaterial.
function isBlankObjMaterial(mat) {
  return mat && mat.isMeshPhongMaterial && (mat.name === '' || mat.name == null);
}

function disposeTree(root) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((m) => {
      if (!m || m === defaultMaterial) return;
      m.map?.dispose();
      m.dispose();
    });
  });
}

function clearBlobUrls() {
  activeBlobUrls.forEach((u) => URL.revokeObjectURL(u));
  activeBlobUrls = [];
}

// ---------------------------------------------------------------------------
// Zip handling — extract .obj/.mtl/textures in the browser, with guards
// ---------------------------------------------------------------------------
// Limits are enforced against the zip's *declared* sizes before decompression,
// so a decompression bomb never gets expanded. Names are sanitised against
// zip-slip. Everything stays client-side — nothing is written to disk.
const ZIP_MAX_INPUT = 150 * 1024 * 1024;        // reject a zip file bigger than this
const ZIP_MAX_TOTAL = 300 * 1024 * 1024;        // cap total uncompressed bytes
const ZIP_MAX_FILE = 150 * 1024 * 1024;         // cap any single uncompressed file
const ZIP_MAX_ENTRIES = 5000;
const MODEL_FILE_RE = /\.(obj|mtl|png|jpe?g|bmp|gif|webp|tga)$/i;

function extractZip(file) {
  return new Promise((resolve, reject) => {
    if (file.size > ZIP_MAX_INPUT) {
      return reject(new Error('Zip is larger than the 150 MB limit.'));
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the zip file.'));
    reader.onload = () => {
      const data = new Uint8Array(reader.result);
      let total = 0, count = 0, aborted = null;

      unzip(data, {
        // Runs on each central-directory entry BEFORE it is decompressed.
        filter: (f) => {
          if (aborted) return false;
          if (++count > ZIP_MAX_ENTRIES) { aborted = 'Zip has too many files.'; return false; }

          const name = f.name;
          if (name.endsWith('/')) return false;                 // directory entry
          if (name.includes('..') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
            return false;                                        // zip-slip / absolute path
          }
          if (!MODEL_FILE_RE.test(name)) return false;          // only model assets

          const size = f.originalSize || 0;
          if (size > ZIP_MAX_FILE) { aborted = 'A file inside the zip is too large.'; return false; }
          total += size;
          if (total > ZIP_MAX_TOTAL) { aborted = 'Zip contents exceed the size limit.'; return false; }
          return true;
        },
      }, (err, unzipped) => {
        if (err) return reject(new Error('Could not unzip: ' + err.message));
        if (aborted) return reject(new Error(aborted));

        const files = Object.entries(unzipped).map(([p, bytes]) =>
          new File([bytes], p.split(/[\\/]/).pop())); // keep basename only
        if (!files.length) return reject(new Error('No model files found in the zip.'));
        resolve(files);
      });
    };
    reader.readAsArrayBuffer(file);
  });
}

// Replace any dropped/selected .zip with its extracted contents.
async function gatherFiles(inputFiles) {
  const out = [];
  for (const f of inputFiles) {
    if (/\.zip$/i.test(f.name)) {
      status('Unzipping…', 'busy', 0);
      out.push(...await extractZip(f));
    } else {
      out.push(f);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loading — local files (.obj + .mtl + textures, or a .zip of them)
// ---------------------------------------------------------------------------
async function loadFromFiles(fileList) {
  let files;
  try {
    files = await gatherFiles([...fileList]);
  } catch (err) {
    return status(err.message, 'error');
  }

  const objFile = files.find((f) => /\.obj$/i.test(f.name));
  if (!objFile) {
    return status('No .obj file found.', 'error');
  }

  clearBlobUrls();

  // Index everything by lowercased basename; make blob URLs for images.
  const fileByName = new Map();
  const imageUrlByName = new Map();
  for (const f of files) {
    const key = f.name.toLowerCase();
    fileByName.set(key, f);
    if (/\.(png|jpe?g|bmp|gif|webp|tga)$/i.test(f.name)) {
      const url = URL.createObjectURL(f);
      activeBlobUrls.push(url);
      imageUrlByName.set(key, url);
    }
  }

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    const hit = imageUrlByName.get(basename(url).toLowerCase());
    return hit || BLANK_PIXEL; // don't attempt a file:// / disk path the .mtl may name
  });

  const objText = await objFile.text();
  const mtlResolver = async (lib) => {
    const f = fileByName.get(basename(lib).toLowerCase());
    return f ? await f.text() : null;
  };

  await loadObjWithMaterials({ objText, objName: objFile.name, mtlResolver, manager });
}

// ---------------------------------------------------------------------------
// Loading — remote URL (.obj, its .mtl, and textures via the proxy)
// ---------------------------------------------------------------------------
async function proxyText(url) {
  const res = await fetch(proxyURL(url));
  if (!res.ok) throw new Error(await res.text());
  return res.text();
}

async function loadFromURL(rawUrl) {
  const url = rawUrl.trim();
  if (!url) return;
  status('Fetching…', 'busy', 0);
  clearBlobUrls();
  try {
    const objText = await proxyText(url);
    const objName = basename(url.split('?')[0]) || 'model.obj';

    const manager = new THREE.LoadingManager();
    manager.setURLModifier((u) => {
      if (u.startsWith('blob:') || u.startsWith('data:')) return u;
      let abs;
      try { abs = new URL(u, url).href; } catch { return BLANK_PIXEL; }
      return safeTextureURL(abs); // http(s) → proxy; file:// etc → blank pixel
    });

    const mtlResolver = async (lib) => {
      const absMtl = new URL(lib, url).href;
      return proxyText(absMtl);
    };

    await loadObjWithMaterials({ objText, objName, mtlResolver, manager });
  } catch (err) {
    status(`Load failed: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Interaction — rotate (drag), move (ctrl+drag / arrows), zoom (scroll)
// ---------------------------------------------------------------------------
const ROTATE_SPEED = 0.008;   // radians per pixel
const KEY_STEP = 0.12;        // world units per arrow press
const ZOOM_STEP = 1.12;       // scroll multiplier
const MIN_ZOOM = 0.25, MAX_ZOOM = 8;

let dragging = false;
let panning = false;
let lastX = 0, lastY = 0;
let zoom = 1;

const canvas = renderer.domElement;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  panning = e.ctrlKey || e.metaKey || e.button === 2;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = panning ? 'move' : 'grabbing';
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;

  if (panning) {
    panBy(dx, dy);
  } else if (!spinning) {
    // Trackball-style: premultiply so rotation is always in world space,
    // which avoids the gimbal weirdness of stacking Euler angles.
    const q = new THREE.Quaternion();
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * ROTATE_SPEED);
    pivot.quaternion.premultiply(q);
    q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * ROTATE_SPEED);
    pivot.quaternion.premultiply(q);
  }
  updateHUD();
});

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
  canvas.style.cursor = 'grab';
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // right-drag pans

// Translate the model in the camera plane. Convert pixel deltas to world units
// using the view size at the model's distance so panning tracks the cursor.
function panBy(dxPixels, dyPixels) {
  const dist = camera.position.z;
  const worldPerPixel =
    (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / stage.clientHeight;
  pivot.position.x += dxPixels * worldPerPixel;
  pivot.position.y -= dyPixels * worldPerPixel;
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoom = clamp(zoom * (e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP), MIN_ZOOM, MAX_ZOOM);
  camera.position.z = baseDistance / zoom;
  updateHUD();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't hijack the URL box

  switch (e.key) {
    case 'ArrowLeft':  pivot.position.x -= KEY_STEP; break;
    case 'ArrowRight': pivot.position.x += KEY_STEP; break;
    case 'ArrowUp':    pivot.position.y += KEY_STEP; break;
    case 'ArrowDown':  pivot.position.y -= KEY_STEP; break;
    case 'r': case 'R': resetView(); break;
    case 'g': case 'G': grid.visible = !grid.visible; break;
    default: return;
  }
  e.preventDefault();
  updateHUD();
});

function resetView() {
  pivot.position.set(0, 0, 0);
  pivot.quaternion.identity();
  zoom = 1;
  baseDistance = 5;
  camera.position.z = baseDistance;
  updateHUD();
}

// ---------------------------------------------------------------------------
// HUD + status
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);
const deg = (r) => Math.round((r * 180) / Math.PI);

function updateHUD() {
  const e = new THREE.Euler().setFromQuaternion(pivot.quaternion, 'YXZ');
  el('hud-rot').textContent = `${deg(e.x)}\u00b0, ${deg(e.y)}\u00b0, ${deg(e.z)}\u00b0`;
  el('hud-pos').textContent =
    `${pivot.position.x.toFixed(2)}, ${pivot.position.y.toFixed(2)}`;
  el('hud-zoom').textContent = `${zoom.toFixed(2)}\u00d7`;
}

let statusTimer;
function status(msg, kind = 'ok', hideAfter = 2600) {
  const s = el('status');
  s.textContent = msg;
  s.className = 'show' + (kind === 'error' ? ' error' : kind === 'busy' ? ' busy' : '');
  clearTimeout(statusTimer);
  if (hideAfter) statusTimer = setTimeout(() => (s.className = ''), hideAfter);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------------------------------------------------------------------------
// Turntable — the orientation used by both the live preview and the GIF
// ---------------------------------------------------------------------------
// The model is tilted by (pitch, roll), then spun a full 360° about the world
// vertical. A full turn returns to the start, so frame 0 == frame N and the GIF
// loops seamlessly regardless of the tilt.
const _tilt = new THREE.Quaternion();
const _yaw = new THREE.Quaternion();
const _euler = new THREE.Euler();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function applyOrientation(p) {
  _euler.set(
    THREE.MathUtils.degToRad(settings.pitch), 0,
    THREE.MathUtils.degToRad(settings.roll), 'ZYX'
  );
  _tilt.setFromEuler(_euler);
  _yaw.setFromAxisAngle(Y_AXIS, p * Math.PI * 2);
  pivot.quaternion.copy(_yaw).multiply(_tilt); // world-space yaw ∘ object tilt
}

// ---------------------------------------------------------------------------
// GIF capture (CCapture, self-contained streaming GIF encoder)
// ---------------------------------------------------------------------------
function enterCaptureResolution(size) {
  const prev = new THREE.Vector2();
  renderer.getSize(prev);
  const prevPR = renderer.getPixelRatio();
  const prevAspect = camera.aspect;
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false); // square drawing buffer; leave CSS size alone
  camera.aspect = 1;
  camera.updateProjectionMatrix();
  return () => {
    renderer.setPixelRatio(prevPR);
    renderer.setSize(prev.x, prev.y, false);
    camera.aspect = prevAspect;
    camera.updateProjectionMatrix();
    resize();
  };
}

function setCapProgress(p, label) {
  const pct = Math.round(p * 100);
  el('capfill').style.width = pct + '%';
  el('capPct').textContent = pct + '%';
  if (label) el('capLabel').textContent = label;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function recordGif() {
  if (capturing) return;
  if (!currentModel) return status('Load a model first.', 'error');
  if (!window.CCapture) return status('Recorder did not load — check vendor/ccapture.', 'error');

  capturing = true;
  const wasSpinning = spinning;
  const savedQuat = pivot.quaternion.clone();
  const { frames, fps, size } = settings;

  renderer.setAnimationLoop(null);          // take over the loop during capture
  const restore = enterCaptureResolution(size);
  el('capture').classList.add('show');
  setCapProgress(0, 'Rendering frames…');

  const capturer = new window.CCapture({
    format: 'gif',
    framerate: fps,
    gifColors: 256,
    manual: true,        // we advance one frame per iteration ourselves
    verbose: false,
  });

  try {
    await capturer.start();
    for (let i = 0; i < frames; i++) {
      applyOrientation(i / frames);
      renderer.render(scene, camera);
      await capturer.capture(renderer.domElement);
      setCapProgress((i + 1) / frames);
      await new Promise((r) => nativeRAF(r)); // yield so the progress bar paints
    }
    await capturer.stop();
    setCapProgress(1, 'Encoding GIF…');
    const blob = await capturer.save(() => {}); // no-op cb suppresses auto-download
    if (!blob) throw new Error('encoder returned no data');
    downloadBlob(blob, `${currentName}-spin.gif`);
    status('GIF saved', 'ok');
  } catch (err) {
    status(`Recording failed: ${err.message}`, 'error');
  } finally {
    restore();
    el('capture').classList.remove('show');
    capturing = false;
    spinning = wasSpinning;
    if (!spinning) { pivot.quaternion.copy(savedQuat); updateHUD(); }
    lastFrameT = performance.now();
    renderer.setAnimationLoop(renderLoop);  // resume normal loop
  }
}

// ---------------------------------------------------------------------------
// Tuning panel
// ---------------------------------------------------------------------------
function syncReadouts() {
  el('framesVal').textContent = settings.frames;
  el('fpsVal').textContent = settings.fps;
  el('pitchVal').textContent = settings.pitch + '\u00b0';
  el('rollVal').textContent = settings.roll + '\u00b0';
  el('sizeVal').textContent = settings.size + 'px';
  el('loopVal').textContent = (settings.frames / settings.fps).toFixed(2) + ' s';
  el('stepVal').textContent = (360 / settings.frames).toFixed(1) + '\u00b0';
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
el('loadUrl').addEventListener('click', () => loadFromURL(el('url').value));
el('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadFromURL(el('url').value);
});
el('file').addEventListener('change', (e) => loadFromFiles(e.target.files));
el('reset').addEventListener('click', resetView);

// --- Tuning panel controls ---
function bindRange(id, key, poseAffecting) {
  const input = el(id);
  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    syncReadouts();
    if (poseAffecting && !spinning && currentModel) applyOrientation(phase); // live pose
  });
}
bindRange('frames', 'frames', false);
bindRange('fps', 'fps', false);
bindRange('pitch', 'pitch', true);
bindRange('roll', 'roll', true);

el('sizeSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  settings.size = Number(btn.dataset.size);
  [...el('sizeSeg').children].forEach((b) => b.classList.toggle('on', b === btn));
  syncReadouts();
});

el('previewBtn').addEventListener('click', () => {
  if (!currentModel) return status('Load a model first.', 'error');
  spinning = !spinning;
  el('previewBtn').classList.toggle('on', spinning);
  el('previewBtn').textContent = spinning ? 'Stop' : 'Preview';
  lastFrameT = performance.now();
  if (!spinning) updateHUD();
});

el('recordBtn').addEventListener('click', recordGif);

el('panelToggle').addEventListener('click', () => {
  const collapsed = el('panel').classList.toggle('collapsed');
  el('panelToggle').textContent = collapsed ? '+' : '\u2013';
});

syncReadouts();

// Recursively pull File objects out of a dropped directory entry.
function walkEntry(entry, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((f) => { out.push(f); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => reader.readEntries(async (entries) => {
        if (!entries.length) return resolve();
        for (const e of entries) await walkEntry(e, out);
        readBatch();
      }, () => resolve());
      readBatch();
    } else {
      resolve();
    }
  });
}

const drop = el('drop');
window.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('show'); });
window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) drop.classList.remove('show'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('show');
  const dt = e.dataTransfer;

  // Grab directory entries synchronously — they expire after the first await.
  let entries = null;
  if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
    entries = [];
    for (const it of dt.items) {
      const en = it.webkitGetAsEntry();
      if (en) entries.push(en);
    }
  }
  const plainFiles = [...dt.files];

  (async () => {
    let files = [];
    if (entries && entries.length) {
      for (const en of entries) await walkEntry(en, files);
    }
    if (!files.length) files = plainFiles;
    if (files.some((f) => /\.(obj|zip)$/i.test(f.name))) loadFromFiles(files);
    else status('Drop a .zip, a folder, or files that include a .obj.', 'error');
  })();
});

// ---------------------------------------------------------------------------
// Resize + render loop
// ---------------------------------------------------------------------------
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', resize);
resize();

canvas.style.cursor = 'grab';
updateHUD();

function renderLoop() {
  const now = performance.now();
  if (spinning && !capturing) {
    const dt = (now - lastFrameT) / 1000;
    phase = (phase + (settings.fps / settings.frames) * dt) % 1; // preview matches GIF speed
    applyOrientation(phase);
    updateHUD();
  }
  lastFrameT = now;
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(renderLoop);
