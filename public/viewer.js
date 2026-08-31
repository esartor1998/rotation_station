import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { unzip } from 'fflate';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

// ---------------------------------------------------------------------------
// Scene, camera, renderer
// ---------------------------------------------------------------------------
const stage = document.getElementById('stage');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f12);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(0, 0, 5);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
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
// delayCs (centiseconds per frame) is the source of truth for timing; fps is a
// display value. Deriving frames from the *actual* delay keeps the loop duration
// exact, and keeping delays ≥ 3cs avoids the browser clamp that bumps tiny GIF
// delays toward 100ms (which is what made smoother = slower before).
const settings = { frames: 63, delayCs: 4, fps: 25, pitch: 20, roll: 0, size: 480, transparent: true, optimize: true };

// "Rotation speed" sets how long one full turn takes; "smoothness" sets the
// per-frame delay. Frames-per-rotation is then frames = round(turnSec / delay),
// so a smoother GIF (shorter delay) adds frames but the turn still takes the
// same time — the spin speed stays put.
const SPEED_PRESETS = [ // seconds per full 360° turn (ascending speed)
  { label: 'Slow', turnSec: 4.0 },
  { label: 'Medium', turnSec: 2.5 },
  { label: 'Fast', turnSec: 1.5 },
  { label: 'Turbo', turnSec: 0.9 },
];
const SMOOTH_PRESETS = [ // centiseconds per frame (ascending smoothness ≈ fps)
  { label: 'Basic', delayCs: 8 },   // ~12 fps
  { label: 'Smooth', delayCs: 5 },  // 20 fps
  { label: 'Silky', delayCs: 4 },   // 25 fps
  { label: 'Ultra', delayCs: 3 },   // ~33 fps
];
let speedIdx = 1;   // Medium
let smoothIdx = 2;  // Silky

function applyPresets() {
  const turnSec = SPEED_PRESETS[speedIdx].turnSec;
  const delayCs = SMOOTH_PRESETS[smoothIdx].delayCs;
  settings.delayCs = delayCs;
  settings.frames = Math.min(300, Math.max(8, Math.round((turnSec * 100) / delayCs)));
  settings.fps = Math.round(100 / delayCs); // display only
  syncReadouts();
}
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
// Interaction — works with mouse and touch through Pointer Events:
//   • 1 pointer drag           → rotate  (ctrl/⌘/right-drag → pan)
//   • 2 pointers (touch)       → pinch to zoom + two-finger pan
//   • wheel / arrow keys       → zoom / move  (desktop)
// ---------------------------------------------------------------------------
const ROTATE_SPEED = 0.008;   // radians per pixel
const KEY_STEP = 0.12;        // world units per arrow press
const ZOOM_STEP = 1.12;       // scroll multiplier
const MIN_ZOOM = 0.25, MAX_ZOOM = 8;

let zoom = 1;
let lastX = 0, lastY = 0;
let mode = 'none';            // 'rotate' | 'pan' | 'gesture' | 'none'
const pointers = new Map();  // pointerId -> { x, y }
let pinch = { dist: 0, midX: 0, midY: 0 };

const canvas = renderer.domElement;
const pts = () => [...pointers.values()];

function refreshMode(e) {
  if (pointers.size >= 2) {
    mode = 'gesture';
    const [a, b] = pts();
    pinch.dist = Math.hypot(a.x - b.x, a.y - b.y);
    pinch.midX = (a.x + b.x) / 2;
    pinch.midY = (a.y + b.y) / 2;
  } else if (pointers.size === 1) {
    const wantsPan = !!e && (e.ctrlKey || e.metaKey || e.button === 2);
    mode = wantsPan ? 'pan' : (spinning ? 'none' : 'rotate');
    const p = pts()[0];
    lastX = p.x; lastY = p.y;                       // re-anchor to avoid jumps
  } else {
    mode = 'none';
  }
  canvas.style.cursor = mode === 'pan' ? 'move' : mode === 'rotate' ? 'grabbing' : 'grab';
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  refreshMode(e);
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  e.preventDefault();

  if (mode === 'gesture' && pointers.size >= 2) {
    const [a, b] = pts();
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    if (pinch.dist > 0) {
      zoom = clamp(zoom * (dist / pinch.dist), MIN_ZOOM, MAX_ZOOM);
      camera.position.z = baseDistance / zoom;
    }
    panBy(midX - pinch.midX, midY - pinch.midY);    // two-finger pan
    pinch.dist = dist; pinch.midX = midX; pinch.midY = midY;
    updateHUD();
    return;
  }

  const p = pts()[0];
  const dx = p.x - lastX, dy = p.y - lastY;
  lastX = p.x; lastY = p.y;

  if (mode === 'pan') {
    panBy(dx, dy);
  } else if (mode === 'rotate' && !spinning) {
    // Trackball-style: premultiply so rotation is always in world space.
    const q = new THREE.Quaternion();
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * ROTATE_SPEED);
    pivot.quaternion.premultiply(q);
    q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * ROTATE_SPEED);
    pivot.quaternion.premultiply(q);
  }
  updateHUD();
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
  refreshMode();  // 2→1 re-anchors the survivor; 1→0 goes idle
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
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
// GIF capture (gifenc — small, worker-free, supports 1-bit alpha transparency)
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

// Read the WebGL canvas back as straight-alpha RGBA via a reused 2D canvas.
let _readCanvas = null, _readCtx = null;
function readCanvasRGBA(src) {
  const w = src.width, h = src.height;
  if (!_readCtx || _readCanvas.width !== w || _readCanvas.height !== h) {
    _readCanvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    _readCtx = _readCanvas.getContext('2d', { willReadFrequently: true });
  }
  _readCtx.clearRect(0, 0, w, h);
  _readCtx.drawImage(src, 0, 0);
  return _readCtx.getImageData(0, 0, w, h); // { data, width, height }, straight alpha
}

// Copy a rectangular sub-region out of a full-frame RGBA buffer.
function cropRGBA(data, srcW, rect) {
  if (rect.x === 0 && rect.y === 0 && rect.w === srcW && rect.h * srcW * 4 === data.length) {
    return data; // already the whole frame — no copy needed
  }
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  const rowBytes = rect.w * 4;
  for (let row = 0; row < rect.h; row++) {
    const src = ((rect.y + row) * srcW + rect.x) * 4;
    out.set(data.subarray(src, src + rowBytes), row * rowBytes);
  }
  return out;
}

function concatRGBA(list) {
  if (list.length === 1) return list[0];
  let total = 0;
  for (const d of list) total += d.length;
  const out = new Uint8ClampedArray(total);
  let off = 0;
  for (const d of list) { out.set(d, off); off += d.length; }
  return out;
}

const ALPHA_THRESHOLD = 8;  // matches the GIF's 1-bit alpha cut
const CROP_PAD = 1;         // keep a hair of margin around the content
const SAMPLE_FRAMES = 12;   // frames sampled to build the shared palette

// Everything below runs entirely in the browser — the generated GIF is never
// uploaded, so this optimization adds zero server attack surface (the secure
// option by construction; no shelling out to gifsicle on untrusted data).
async function recordGif() {
  if (capturing) return;
  if (!currentModel) return status('Load a model first.', 'error');

  capturing = true;
  const wasSpinning = spinning;
  const savedQuat = pivot.quaternion.clone();
  const { frames, size, fps, transparent, optimize } = settings;
  // gifenc's writeFrame takes delay in MILLISECONDS (it stores round(ms/10) as
  // centiseconds). Our timing source of truth is delayCs, so ×10 to hand it ms.
  const delayMs = Math.max(10, settings.delayCs * 10);
  const format = transparent ? 'rgba4444' : 'rgb565';

  renderer.setAnimationLoop(null);          // take over the loop during capture
  const restore = enterCaptureResolution(size);

  // For a clean cut-out: clear to fully transparent and hide the reference grid.
  const savedBg = scene.background;
  const savedGrid = grid.visible;
  if (transparent) { scene.background = null; renderer.setClearColor(0x000000, 0); }
  grid.visible = false;

  el('capture').classList.add('show');
  setCapProgress(0, 'Analysing frames…');

  const renderFrame = (i) => { applyOrientation(i / frames); renderer.render(scene, camera); };
  const yield_ = () => new Promise((r) => nativeRAF(r));

  try {
    // ---- Pass 1: content box (always, when transparent) + palette sample ----
    // The bounding-box trim always runs. The "optimize filesize" switch only
    // chooses a shared global palette (on) vs a per-frame palette (off).
    let rect = { x: 0, y: 0, w: size, h: size };
    let palette = null; // non-null ⇒ one shared global palette for all frames

    const needBBox = transparent;   // trim transparent exports to their content
    const needSample = optimize;    // sample frames to build a global palette
    const pass1 = needBBox || needSample;

    if (pass1) {
      let minX = size, minY = size, maxX = -1, maxY = -1;
      const stride = Math.max(1, Math.floor(frames / SAMPLE_FRAMES));
      const samples = []; // stored full-frame, cropped afterwards

      for (let i = 0; i < frames; i++) {
        const isSample = needSample && i % stride === 0 && samples.length < SAMPLE_FRAMES;
        if (needBBox || isSample) {
          renderFrame(i);
          const img = readCanvasRGBA(renderer.domElement);
          if (needBBox) {
            // Scan alpha (top byte of each RGBA word) to grow the content box.
            const u32 = new Uint32Array(img.data.buffer, img.data.byteOffset, size * size);
            let p = 0;
            for (let y = 0; y < size; y++) {
              for (let x = 0; x < size; x++, p++) {
                if ((u32[p] >>> 24) > ALPHA_THRESHOLD) {
                  if (x < minX) minX = x; if (x > maxX) maxX = x;
                  if (y < minY) minY = y; if (y > maxY) maxY = y;
                }
              }
            }
          }
          if (isSample) samples.push(img.data.slice());
          await yield_();
        }
        setCapProgress((i + 1) / frames * 0.45);
      }

      // Content rectangle (padded), or the full frame when opaque / empty.
      if (transparent && maxX >= minX && maxY >= minY) {
        const x = Math.max(0, minX - CROP_PAD);
        const y = Math.max(0, minY - CROP_PAD);
        rect = {
          x, y,
          w: Math.min(size, maxX + 1 + CROP_PAD) - x,
          h: Math.min(size, maxY + 1 + CROP_PAD) - y,
        };
      }

      // One global palette from the cropped samples → a single color table for
      // the whole GIF instead of a local table per frame (a large size saving).
      if (needSample) {
        const sample = concatRGBA(samples.map((d) => cropRGBA(d, size, rect)));
        palette = quantize(sample, 256, transparent ? { format, oneBitAlpha: true } : { format });
      }
    }

    // ---- Pass 2: encode every frame ----------------------------------------
    const p2start = pass1 ? 0.45 : 0;
    const p2span = pass1 ? 0.5 : 0.95;
    setCapProgress(p2start, 'Encoding GIF…');
    const gif = GIFEncoder();
    const qOpts = transparent ? { format, oneBitAlpha: true } : { format };
    for (let i = 0; i < frames; i++) {
      renderFrame(i);
      const data = cropRGBA(readCanvasRGBA(renderer.domElement).data, size, rect);
      // Shared global palette (optimize on) or a fresh palette per frame (off).
      const framePalette = palette || quantize(data, 256, qOpts);
      const index = applyPalette(data, framePalette, format);
      // A palette on a frame writes a colour table. For the global palette that's
      // only needed on frame 0; per-frame palettes write one on every frame.
      const opts = { delay: delayMs, transparent, transparentIndex: 0 };
      if (!palette || i === 0) opts.palette = framePalette;
      gif.writeFrame(index, rect.w, rect.h, opts);
      setCapProgress(p2start + (i + 1) / frames * p2span);
      await yield_();
    }

    setCapProgress(0.98, 'Finishing…');
    gif.finish();
    const blob = new Blob([gif.bytes()], { type: 'image/gif' });
    setCapProgress(1);
    downloadBlob(blob, `${currentName}-spin.gif`);
    status(`GIF saved · ${rect.w}\u00d7${rect.h} · ${Math.round(blob.size / 1024)} KB`, 'ok');
  } catch (err) {
    status(`Recording failed: ${err.message}`, 'error');
  } finally {
    if (transparent) { scene.background = savedBg; renderer.setClearColor(0x000000, 1); }
    grid.visible = savedGrid;
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
  el('pitchVal').textContent = settings.pitch + '\u00b0';
  el('rollVal').textContent = settings.roll + '\u00b0';
  el('sizeVal').textContent = settings.size + 'px';
  el('loopVal').textContent = ((settings.frames * settings.delayCs) / 100).toFixed(2) + ' s';
  el('framesVal').textContent = settings.frames;
  el('fpsVal').textContent = settings.fps;
  el('framesManVal').textContent = settings.frames;
  el('fpsManVal').textContent = settings.fps;
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
bindRange('pitch', 'pitch', true);
bindRange('roll', 'roll', true);
bindRange('frames', 'frames', false); // manual mode only (hidden unless Advanced)
el('fps').addEventListener('input', () => {
  settings.fps = Number(el('fps').value);
  settings.delayCs = Math.max(1, Math.round(100 / settings.fps)); // keep timing in sync
  syncReadouts();
});

function bindSeg(segId, onPick) {
  el(segId).addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    [...el(segId).children].forEach((b) => b.classList.toggle('on', b === btn));
    onPick(btn);
  });
}
bindSeg('speedSeg', (btn) => { speedIdx = Number(btn.dataset.i); applyPresets(); });
bindSeg('smoothSeg', (btn) => { smoothIdx = Number(btn.dataset.i); applyPresets(); });
bindSeg('sizeSeg', (btn) => { settings.size = Number(btn.dataset.size); syncReadouts(); });
bindSeg('bgSeg', (btn) => { settings.transparent = btn.dataset.bg === '1'; });
bindSeg('optSeg', (btn) => { settings.optimize = btn.dataset.opt === '1'; });

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

el('advToggle').addEventListener('click', () => {
  const adv = el('panel').classList.toggle('advanced');
  el('advToggle').classList.toggle('on', adv);
  if (adv) {
    // Seed the sliders from whatever the presets currently produce.
    el('frames').value = settings.frames;
    el('fps').value = settings.fps;
    syncReadouts();
  } else {
    applyPresets(); // presets take back over
  }
});

applyPresets(); // sets frames/fps from the default speed + smoothness presets

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
    // Rotations per second the exported GIF will actually play at:
    // frames × delayCs centiseconds per full turn.
    const rps = 100 / (settings.frames * settings.delayCs);
    phase = (phase + rps * dt) % 1;
    applyOrientation(phase);
    updateHUD();
  }
  lastFrameT = now;
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(renderLoop);
