import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { unzip } from 'fflate';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

// ---------------------------------------------------------------------------
// scene, camera, renderer
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

// default lighting — swapped out for the custom rig in expert mode
const defaultLightGroup = new THREE.Group();
scene.add(defaultLightGroup);

const hemi = new THREE.HemisphereLight(0xffffff, 0x202028, 1.1);
defaultLightGroup.add(hemi);

const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(3, 5, 4);
defaultLightGroup.add(key);

const fill = new THREE.DirectionalLight(0xbfd4ff, 0.5);
fill.position.set(-4, -1, -3);
defaultLightGroup.add(fill);

const customLightGroup = new THREE.Group();
scene.add(customLightGroup);

// ground grid, just so you can tell where the model is when you move it
const grid = new THREE.GridHelper(20, 40, 0x2a2f38, 0x1c2027);
grid.position.y = -1.4;
scene.add(grid);

// `pivot` is the thing you actually manipulate. rotation exists on its
// quaternion, panning on its position. the model gets centered inside it so it
// always* spins around its own middle
const pivot = new THREE.Group();
scene.add(pivot);

// fallback for meshes that show up with no material at all
const defaultMaterial = new THREE.MeshStandardMaterial({
  color: 0x9aa4b2, metalness: 0.05, roughness: 0.75, side: THREE.DoubleSide,
});

let currentModel = null;   // the centred/scaled group sitting in the pivot
let currentName = 'model'; // name of the loaded model, used for the gif filename
let baseDistance = 5;      // the camera Z that framed the model at zoom 1
let activeBlobUrls = [];   // blob URLs for uploaded textures, revoked on reload
let loadGeneration = 0;    // bumped each load, so a stale async callback can be ignored

// turntable + GIF settings, driven by the tuning panel
// delayCs (centiseconds per frame) is the source of truth for timing, fps is
// only for display. working out the frame count from the *actual* delay keeps
// the loop length exact, and staying at 3cs or more dodges the browser clamp
// that bumps tiny GIF delays up toward 100ms. that clamp is what used to make
// "smoother" come out slower
const settings = { frames: 63, delayCs: 4, fps: 25, pitch: 20, roll: 0, size: 480, transparent: true, optimize: true };

// "rotation speed" sets how long one full turn takes, "smoothness" sets the
// per-frame delay. the frame count is then round(turnSec / delay), so a
// smoother GIF (shorter delay) just adds more frames while the turn still takes
// the same time. that's the trick: smoothness doesn't touch the spin speed
const SPEED_PRESETS = [ // seconds for one full turn, getting faster
  { label: 'Slow', turnSec: 4.0 },
  { label: 'Medium', turnSec: 2.5 },
  { label: 'Fast', turnSec: 1.5 },
  { label: 'Turbo', turnSec: 0.9 },
];
const SMOOTH_PRESETS = [ // centiseconds per frame, getting smoother
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
  settings.fps = Math.round(100 / delayCs); // just for the readout
  syncReadouts();
}
let spinning = false;      // is the live preview spinning
let capturing = false;     // is a GIF being captured right now
let phase = 0;             // where we are in the current turn, 0 to 1
let lastFrameT = performance.now();

// grab the real timer up front, in case a capture lib ever fakes it
const nativeRAF = window.requestAnimationFrame.bind(window);

// ---------------------------------------------------------------------------
// loading, shared core
// ---------------------------------------------------------------------------

// pull every filename the OBJ's `mtllib` lines point at
function extractMtlLibs(objText) {
  const libs = [];
  const lineRe = /^\s*mtllib\s+(.+)$/gim;
  let m;
  while ((m = lineRe.exec(objText))) {
    const rest = m[1].trim();
    // one mtllib line can list several .mtl files, AND any one name can have
    // spaces in it. so split on the .mtl extension, not on whitespace
    const names = rest.match(/\S.*?\.mtl(?=\s|$)/gi);
    if (names) names.forEach((n) => libs.push(n.trim()));
    else if (rest) libs.push(rest); // no .mtl extension on it, so take the whole thing
  }
  return [...new Set(libs)];
}

const basename = (p) => p.split(/[\\/]/).pop();

// build the proxy URL *relative to wherever the app is mounted*, so it still
// works behind a reverse proxy on a sub-path (e.g. /rotation-station/). needs
// the page served with a trailing slash, see the readme
function proxyURL(target) {
  const u = new URL('proxy', document.baseURI);
  u.searchParams.set('url', target);
  return u.href;
}

// a 1x1 transparent PNG. we hand this back rather than ever give a loader a
// file:// or bare disk path, since browsers flat out refuse those from an
// http(s) page ("may not load or link to file:///"). swapping in a harmless
// pixel means one bad texture path doesn't blow up the whole load
const BLANK_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// only http(s) is safe to route. anything else (file:, about:, C:\... ) turns
// into the blank pixel
function safeTextureURL(resolvedAbsolute) {
  return /^https?:\/\//i.test(resolvedAbsolute) ? proxyURL(resolvedAbsolute) : BLANK_PIXEL;
}

// mtlResolver(libName) -> Promise<string|null>, gives back the .mtl text
// manager is a THREE.LoadingManager whose URL modifier sends texture requests
// either to blob URLs (uploads) or to the proxy (web)
async function loadObjWithMaterials({ objText, objName, mtlResolver, manager }) {
  // strip a UTF-8 BOM and normalise CR / CRLF line endings. OBJLoader only
  // splits on "\n", so an old CR-only file (some exporters still do this) parses
  // as a single line and you get no geometry. do it here so every path benefits
  objText = objText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

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
      creator.preload();                 // builds the materials and starts the textures loading
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

// ---------------------------------------------------------------------------
// multi-format loading. picks the right three.js loader off the extension
// the loaders are imported lazily through the CDN import map, so they cost
// nothing until you actually open a model of that type
// ---------------------------------------------------------------------------
const SUPPORTED_RE = /\.(obj|dae|gltf|glb|stl|ply|fbx)$/i;
const FORMAT_PRIORITY = ['obj', 'glb', 'gltf', 'fbx', 'dae', 'stl', 'ply'];
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const toArrayBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

async function dispatchModel({ name, bytes, manager, mtlResolver, texBase = '' }) {
  const ext = extOf(name);
  const text = () => new TextDecoder('utf-8').decode(bytes);

  // some exporters (Cinema4D's Collada export is a known one) put an alpha
  // channel in the diffuse texture but never declare <transparent> or opacity
  // in the material. three.js takes that at face value, ignores the alpha, and
  // paints the "transparent" bits with the texture's raw RGB, which is usually
  // black. so once every texture in this load has finished decoding, go look
  // for that case and switch blending on. the generation check throws this away
  // if a newer load already started
  const myGen = ++loadGeneration;
  if (manager) {
    manager.onLoad = () => {
      if (myGen === loadGeneration && currentModel) applyAlphaTransparencyFix(currentModel);
    };
  }

  try {
    if (ext === 'obj') {
      return await loadObjWithMaterials({ objText: text(), objName: name, mtlResolver, manager });
    }
    if (ext === 'dae') {
      const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
      const result = new ColladaLoader(manager).parse(text(), texBase);
      return finishScene(result && result.scene, name);
    }
    if (ext === 'gltf' || ext === 'glb') {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const loader = new GLTFLoader(manager);
      const data = ext === 'glb' ? toArrayBuffer(bytes) : text();
      return await new Promise((resolve) => {
        loader.parse(data, texBase,
          (gltf) => { finishScene(gltf.scene, name); resolve(); },
          (err) => { status(`Parse failed: ${err.message || err}`, 'error'); resolve(); });
      });
    }
    if (ext === 'fbx') {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      return finishScene(new FBXLoader(manager).parse(toArrayBuffer(bytes), texBase), name);
    }
    if (ext === 'stl') {
      const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
      return finishGeometry(new STLLoader().parse(toArrayBuffer(bytes)), name, false);
    }
    if (ext === 'ply') {
      const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
      return finishGeometry(new PLYLoader().parse(toArrayBuffer(bytes)), name, true);
    }
    return status(`Unsupported format: .${ext}`, 'error');
  } catch (err) {
    return status(`Parse failed: ${err.message || err}`, 'error');
  }
}

// for loaders that hand back a scene or group (Collada, glTF, FBX)
function finishScene(scene, name) {
  if (!scene) return status('No geometry found in that file.', 'error');
  let hasMesh = false;
  scene.traverse((c) => { if (c.isMesh) hasMesh = true; });
  if (!hasMesh) return status('No geometry found in that file.', 'error');
  installModel(scene, name, {});
}

// for loaders that hand back bare geometry (STL, PLY), so wrap it in a mesh
function finishGeometry(geo, name, preferVertexColors) {
  if (!geo || !geo.getAttribute('position')) {
    return status('No geometry found in that file.', 'error');
  }
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const hasColor = preferVertexColors && !!geo.getAttribute('color');
  const mat = new THREE.MeshStandardMaterial({
    color: hasColor ? 0xffffff : 0x9aa4b2, vertexColors: hasColor,
    metalness: 0.05, roughness: 0.8, side: THREE.DoubleSide,
  });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geo, mat));
  installModel(group, name, {});
}

// ---------------------------------------------------------------------------
// the alpha-channel transparency fix, see dispatchModel above for why it's
// needed. we detect it by shrinking the texture onto a tiny canvas instead of
// scanning every pixel of what might be a huge image. cheap, and any real
// transparent area easily survives the downscale
// ---------------------------------------------------------------------------
let _alphaCanvas = null, _alphaCtx = null;
function textureHasAlpha(tex) {
  const img = tex && tex.image;
  if (!img || !img.width || !img.height) return false;
  try {
    const S = 32;
    if (!_alphaCtx) {
      _alphaCanvas = Object.assign(document.createElement('canvas'), { width: S, height: S });
      _alphaCtx = _alphaCanvas.getContext('2d', { willReadFrequently: true });
    }
    _alphaCtx.clearRect(0, 0, S, S);
    _alphaCtx.drawImage(img, 0, 0, S, S);
    const data = _alphaCtx.getImageData(0, 0, S, S).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
    return false;
  } catch {
    return false; // tainted cross-origin canvas etc. fail safe rather than crash
  }
}

function applyAlphaTransparencyFix(root) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat) => {
      if (!mat || mat.transparent) return; // leave alone anything that already asked for transparency
      if (mat.alphaMap) { mat.transparent = true; mat.needsUpdate = true; return; }
      if (mat.map && textureHasAlpha(mat.map)) { mat.transparent = true; mat.needsUpdate = true; }
    });
  });
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
      // swap in our default if the material is missing, or if it's the blank
      // one OBJLoader invents when no .mtl matched. keep anything real
      if (!mat || isBlankObjMaterial(mat)) {
        if (Array.isArray(child.material)) child.material[i] = defaultMaterial;
        else child.material = defaultMaterial;
        return;
      }
      mat.side = THREE.DoubleSide;                 // nicer for previewing
      if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace; // keeps texture colours correct
      mat.needsUpdate = true;
    });

    const g = child.geometry;
    triangles += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  });

  // centre the bounding box on the pivot, then scale so the biggest dimension
  // is about 2 world units. that way any model frames up the same
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

// OBJLoader hands meshes with no matched material a nameless MeshPhongMaterial
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
// zip handling. unpacks the model + textures in the browser, with guards
// ---------------------------------------------------------------------------
// the limits are checked against the sizes the zip *claims* before we
// decompress anything, so a zip bomb never actually gets expanded. names are
// sanitised against zip-slip. it all stays client side, nothing hits the disk
const ZIP_MAX_INPUT = 150 * 1024 * 1024;        // refuse a zip file bigger than this
const ZIP_MAX_TOTAL = 300 * 1024 * 1024;        // cap on the total unpacked size
const ZIP_MAX_FILE = 150 * 1024 * 1024;         // cap on any one unpacked file
const ZIP_MAX_ENTRIES = 5000;
const MODEL_FILE_RE = /\.(obj|mtl|dae|gltf|glb|stl|ply|fbx|bin|png|jpe?g|bmp|gif|webp|tga|dds|ktx2)$/i;
// 3D formats we recognise but still can't open. only used so we can give a
// useful message when a zip has models in it but nothing we handle
const OTHER_MODEL_RE = /\.(blend|3ds|smd|pmx|pmd|md5mesh|max|c4d|nif|mdl|mesh|vmt|vtf|x|usd[acz]?)$/i;
let lastOtherModels = []; // formats we can't open that turned up in the last archive

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
      const others = [];

      unzip(data, {
        // runs on each entry BEFORE it gets decompressed, which is the point
        filter: (f) => {
          if (aborted) return false;
          if (++count > ZIP_MAX_ENTRIES) { aborted = 'Zip has too many files.'; return false; }

          const name = f.name;
          if (name.endsWith('/')) return false;                 // it's a folder entry
          if (name.includes('..') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
            return false;                                        // zip-slip or an absolute path, nope
          }
          if (!MODEL_FILE_RE.test(name)) {
            if (OTHER_MODEL_RE.test(name)) others.push(basename(name).replace(/.*\./, '.'));
            return false;                                        // only take model assets
          }

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
          new File([bytes], p.split(/[\\/]/).pop())); // drop the folders, keep the filename
        resolve({ files, others: [...new Set(others)] });
      });
    };
    reader.readAsArrayBuffer(file);
  });
}

// swap any dropped/selected .zip for the files inside it
async function gatherFiles(inputFiles) {
  const out = [];
  const others = [];
  for (const f of inputFiles) {
    if (/\.zip$/i.test(f.name)) {
      status('Unzipping…', 'busy', 0);
      const r = await extractZip(f);
      out.push(...r.files);
      others.push(...r.others);
    } else {
      out.push(f);
    }
  }
  lastOtherModels = [...new Set(others)];
  return out;
}

// ---------------------------------------------------------------------------
// loading local files: a model + its textures, or a .zip of them
// ---------------------------------------------------------------------------
async function loadFromFiles(fileList) {
  let files;
  try {
    files = await gatherFiles([...fileList]);
  } catch (err) {
    return status(err.message, 'error');
  }

  // pick which file is the actual model, by format preference
  let primary = null, bestRank = Infinity;
  for (const f of files) {
    const rank = FORMAT_PRIORITY.indexOf(extOf(f.name));
    if (rank !== -1 && rank < bestRank) { bestRank = rank; primary = f; }
  }
  if (!primary) {
    if (lastOtherModels.length) {
      return status(`Archive has no supported model (found ${lastOtherModels.join(', ')}).`, 'error');
    }
    return status('No supported model file found (.obj, .dae, .gltf/.glb, .stl, .ply, .fbx).', 'error');
  }

  clearBlobUrls();

  // index everything by lowercased basename, and make a blob URL for *every*
  // file (textures, glTF .bin buffers, whatever) so references resolve no
  // matter what format we're loading
  const fileByName = new Map();
  const urlByName = new Map();
  for (const f of files) {
    const key = f.name.toLowerCase();
    fileByName.set(key, f);
    const url = URL.createObjectURL(f);
    activeBlobUrls.push(url);
    urlByName.set(key, url);
  }

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    const hit = urlByName.get(basename(url).toLowerCase());
    return hit || BLANK_PIXEL; // never hand a loader a file:// or disk path
  });

  const mtlResolver = async (lib) => {
    const f = fileByName.get(basename(lib).toLowerCase());
    return f ? await f.text() : null;
  };

  const bytes = new Uint8Array(await primary.arrayBuffer());
  await dispatchModel({ name: primary.name, bytes, manager, mtlResolver, texBase: '' });
}

// ---------------------------------------------------------------------------
// loading from a URL. the model, its .mtl and textures all go via the proxy
// ---------------------------------------------------------------------------
async function proxyText(url) {
  const res = await fetch(proxyURL(url));
  if (!res.ok) throw new Error(await res.text());
  return res.text();
}

async function proxyBytes(url) {
  const res = await fetch(proxyURL(url));
  if (!res.ok) throw new Error(await res.text());
  return new Uint8Array(await res.arrayBuffer());
}

// PK\x03\x04 and friends, the magic bytes at the start of a zip
function looksLikeZip(b) {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b &&
    (b[2] === 3 || b[2] === 5 || b[2] === 7) && (b[3] === 4 || b[3] === 6 || b[3] === 8);
}

async function loadFromURL(rawUrl) {
  const url = rawUrl.trim();
  if (!url) return;
  status('Fetching…', 'busy', 0);
  clearBlobUrls();
  try {
    const bytes = await proxyBytes(url);
    const name = basename(url.split(/[?#]/)[0]) || 'model';

    // a remote zip (spotted by extension or magic bytes) goes through the exact
    // same unzip + material path as the file picker
    if (/\.zip$/i.test(name) || looksLikeZip(bytes)) {
      status('Unzipping…', 'busy', 0);
      const zipName = /\.zip$/i.test(name) ? name : 'download.zip';
      return loadFromFiles([new File([bytes], zipName)]);
    }

    // otherwise it's a single model file. textures, .mtl and .bin all resolve
    // through the proxy, relative to this URL
    const objName = SUPPORTED_RE.test(name) ? name : 'model.obj';

    const manager = new THREE.LoadingManager();
    manager.setURLModifier((u) => {
      if (u.startsWith('blob:') || u.startsWith('data:')) return u;
      let abs;
      try { abs = new URL(u, url).href; } catch { return BLANK_PIXEL; }
      return safeTextureURL(abs); // http(s) goes to the proxy, file:// etc gets the blank pixel
    });

    const mtlResolver = async (lib) => proxyText(new URL(lib, url).href);

    await dispatchModel({ name: objName, bytes, manager, mtlResolver, texBase: url });
  } catch (err) {
    status(`Load failed: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// interaction. mouse and touch both go through Pointer Events:
//   - 1 pointer drag       -> rotate (ctrl / cmd / right-drag -> pan)
//   - 2 pointers (touch)   -> pinch zoom + two-finger pan
//   - wheel / arrow keys   -> zoom / move, desktop only
// ---------------------------------------------------------------------------
const ROTATE_SPEED = 0.008;   // radians per pixel dragged
const KEY_STEP = 0.12;        // world units per arrow key press
const ZOOM_STEP = 1.12;       // how much one scroll notch zooms
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
    lastX = p.x; lastY = p.y;                       // re-anchor so it doesn't jump
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
    panBy(midX - pinch.midX, midY - pinch.midY);    // pan with two fingers
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
    // trackball style. premultiply so rotation is always in world space
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
  refreshMode();  // going 2->1 re-anchors the one left, 1->0 just goes idle
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // so right-drag can pan

// move the model in the camera plane. converts pixel deltas to world units
// using the view size at the model's distance, so panning tracks your cursor
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
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't steal keys from the URL box

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
// the turntable. this is the orientation both the live preview and the GIF use
// ---------------------------------------------------------------------------
// tilt the model by (pitch, roll), then spin it a full 360 around the world
// vertical. a whole turn lands back where it started, so frame 0 == frame N and
// the GIF loops seamlessly no matter what the tilt is
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
  pivot.quaternion.copy(_yaw).multiply(_tilt); // world-space yaw, then the object's tilt
}

// ---------------------------------------------------------------------------
// GIF capture, via gifenc. small, no worker, and does 1-bit alpha transparency
// ---------------------------------------------------------------------------
function enterCaptureResolution(size) {
  const prev = new THREE.Vector2();
  renderer.getSize(prev);
  const prevPR = renderer.getPixelRatio();
  const prevAspect = camera.aspect;
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false); // square buffer to draw into, leave the CSS size alone
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

// read the WebGL canvas back as straight-alpha RGBA, reusing one 2D canvas
let _readCanvas = null, _readCtx = null;
function readCanvasRGBA(src) {
  const w = src.width, h = src.height;
  if (!_readCtx || _readCanvas.width !== w || _readCanvas.height !== h) {
    _readCanvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    _readCtx = _readCanvas.getContext('2d', { willReadFrequently: true });
  }
  _readCtx.clearRect(0, 0, w, h);
  _readCtx.drawImage(src, 0, 0);
  return _readCtx.getImageData(0, 0, w, h); // gives { data, width, height } with straight alpha
}

// copy a rectangle out of a full-frame RGBA buffer
function cropRGBA(data, srcW, rect) {
  if (rect.x === 0 && rect.y === 0 && rect.w === srcW && rect.h * srcW * 4 === data.length) {
    return data; // it's already the whole frame, no copy needed
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

const ALPHA_THRESHOLD = 8;  // matches where the GIF's 1-bit alpha cuts off
const CROP_PAD = 1;         // leave a hair of margin around the content
const SAMPLE_FRAMES = 12;   // how many frames we sample to build the shared palette

// all of this runs in the browser and the GIF never gets uploaded, so none of
// it adds any server attack surface. that's deliberate: no shelling out to
// gifsicle on a file someone else made
async function recordGif() {
  if (capturing) return;
  if (!currentModel) return status('Load a model first.', 'error');

  capturing = true;
  const wasSpinning = spinning;
  const savedQuat = pivot.quaternion.clone();
  const { frames, size, fps, transparent, optimize } = settings;
  // gifenc's writeFrame wants the delay in MILLISECONDS (it stores round(ms/10)
  // as centiseconds). we track delayCs, so multiply by 10 on the way in. getting
  // this wrong is what made the fps dial do nothing
  const delayMs = Math.max(10, settings.delayCs * 10);
  const format = transparent ? 'rgba4444' : 'rgb565';

  renderer.setAnimationLoop(null);          // we drive the loop ourselves while capturing
  const restore = enterCaptureResolution(size);

  // for a clean cutout: clear to fully transparent and hide the grid
  const savedBg = scene.background;
  const savedGrid = grid.visible;
  if (transparent) { scene.background = null; renderer.setClearColor(0x000000, 0); }
  grid.visible = false;

  el('capture').classList.add('show');
  setCapProgress(0, 'Analysing frames…');

  const renderFrame = (i) => { applyOrientation(i / frames); renderer.render(scene, camera); };
  const yield_ = () => new Promise((r) => nativeRAF(r));

  try {
    // ---- pass 1: find the content box, and sample for the palette ----------
    // the bounding-box trim always runs. the "optimize filesize" switch only
    // picks between one shared global palette (on) and a palette per frame
    let rect = { x: 0, y: 0, w: size, h: size };
    let palette = null; // if set, it's one shared palette for every frame

    const needBBox = transparent;   // trim transparent exports down to the content
    const needSample = optimize;    // sample some frames to build a global palette
    const pass1 = needBBox || needSample;

    if (pass1) {
      let minX = size, minY = size, maxX = -1, maxY = -1;
      const stride = Math.max(1, Math.floor(frames / SAMPLE_FRAMES));
      const samples = []; // kept full-frame, cropped later

      for (let i = 0; i < frames; i++) {
        const isSample = needSample && i % stride === 0 && samples.length < SAMPLE_FRAMES;
        if (needBBox || isSample) {
          renderFrame(i);
          const img = readCanvasRGBA(renderer.domElement);
          if (needBBox) {
            // check alpha (top byte of each RGBA word) to grow the content box
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

      // the content rect with a little padding, or the whole frame if opaque
      if (transparent && maxX >= minX && maxY >= minY) {
        const x = Math.max(0, minX - CROP_PAD);
        const y = Math.max(0, minY - CROP_PAD);
        rect = {
          x, y,
          w: Math.min(size, maxX + 1 + CROP_PAD) - x,
          h: Math.min(size, maxY + 1 + CROP_PAD) - y,
        };
      }

      // one global palette off the cropped samples means a single colour table
      // for the whole GIF instead of one per frame. saves a lot of bytes
      if (needSample) {
        const sample = concatRGBA(samples.map((d) => cropRGBA(d, size, rect)));
        palette = quantize(sample, 256, transparent ? { format, oneBitAlpha: true } : { format });
      }
    }

    // ---- pass 2: encode every frame ----------------------------------------
    const p2start = pass1 ? 0.45 : 0;
    const p2span = pass1 ? 0.5 : 0.95;
    setCapProgress(p2start, 'Encoding GIF…');
    const gif = GIFEncoder();
    const qOpts = transparent ? { format, oneBitAlpha: true } : { format };
    for (let i = 0; i < frames; i++) {
      renderFrame(i);
      const data = cropRGBA(readCanvasRGBA(renderer.domElement).data, size, rect);
      // shared global palette if optimize is on, otherwise a fresh one each frame
      const framePalette = palette || quantize(data, 256, qOpts);
      const index = applyPalette(data, framePalette, format);
      // passing a palette on a frame writes a colour table. with the global one
      // we only need that on frame 0, per-frame palettes write one every time
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
    renderer.setAnimationLoop(renderLoop);  // back to the normal loop
  }
}

// ---------------------------------------------------------------------------
// tuning panel
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
// lighting rig
// ---------------------------------------------------------------------------
const lightSettings = {
  count: 2,
  type: 'directional',
  distance: 5,
  orbit: 45,
  elevation: 20,
  colour: '#ffffff',
  brightness: 1.6,
};

function updateLightRig() {
  while (customLightGroup.children.length) {
    customLightGroup.remove(customLightGroup.children[0]);
  }

  const expert = el('panel').classList.contains('advanced');
  if (!expert) {
    defaultLightGroup.visible = true;
    customLightGroup.visible = false;
    el('lightPanel').style.display = 'none';
    return;
  }

  defaultLightGroup.visible = false;
  customLightGroup.visible = true;
  el('lightPanel').style.display = 'block';

  const { count, type, distance, orbit, elevation, colour, brightness } = lightSettings;
  const c = new THREE.Color(colour);
  const orbitRad = THREE.MathUtils.degToRad(orbit);
  const elevRad = THREE.MathUtils.degToRad(elevation);

  for (let i = 0; i < count; i++) {
    const angle = orbitRad + (i / count) * Math.PI * 2;
    const cosElev = Math.cos(elevRad);
    const x = Math.cos(angle) * cosElev;
    const z = Math.sin(angle) * cosElev;
    const y = Math.sin(elevRad);

    let light;
    if (type === 'directional') {
      light = new THREE.DirectionalLight(c, brightness);
      light.position.set(x, y, z);
    } else if (type === 'point') {
      light = new THREE.PointLight(c, brightness, distance * 3, 1);
      light.position.set(x * distance, y * distance, z * distance);
    } else if (type === 'spot') {
      light = new THREE.SpotLight(c, brightness, distance * 3, Math.PI / 4, 0.5, 1);
      light.position.set(x * distance, y * distance, z * distance);
      light.target.position.set(0, 0, 0);
      customLightGroup.add(light.target);
    }
    customLightGroup.add(light);
  }
}

function syncLightReadouts() {
  el('distVal').textContent = lightSettings.distance;
  el('orbitVal').textContent = lightSettings.orbit + '\u00b0';
  el('elevVal').textContent = lightSettings.elevation + '\u00b0';
  el('brightVal').textContent = lightSettings.brightness.toFixed(1);
  el('distanceCtl').style.display = lightSettings.type === 'directional' ? 'none' : '';
}

function maybeCollapseOther(opening) {
  if (window.innerWidth > 720) return;
  if (opening === 'gif') {
    el('lightPanel').classList.add('collapsed');
    el('lightPanelToggle').textContent = '+';
  } else {
    el('panel').classList.add('collapsed');
    el('panelToggle').textContent = '+';
  }
}

// ---------------------------------------------------------------------------
// wiring it all up
// ---------------------------------------------------------------------------
el('loadUrl').addEventListener('click', () => loadFromURL(el('url').value));
el('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadFromURL(el('url').value);
});
el('file').addEventListener('change', (e) => loadFromFiles(e.target.files));
el('reset').addEventListener('click', resetView);

// --- tuning panel controls ---
function bindRange(id, key, poseAffecting) {
  const input = el(id);
  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    syncReadouts();
    if (poseAffecting && !spinning && currentModel) applyOrientation(phase); // update the pose live
  });
}
bindRange('pitch', 'pitch', true);
bindRange('roll', 'roll', true);
bindRange('frames', 'frames', false); // manual mode only, hidden unless Advanced is on
el('fps').addEventListener('input', () => {
  settings.fps = Number(el('fps').value);
  settings.delayCs = Math.max(1, Math.round(100 / settings.fps)); // keep the real timing in sync
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
  if (!collapsed) maybeCollapseOther('gif');
});

el('advToggle').addEventListener('click', () => {
  const adv = el('panel').classList.toggle('advanced');
  el('advToggle').classList.toggle('on', adv);
  if (adv) {
    el('frames').value = settings.frames;
    el('fps').value = settings.fps;
    syncReadouts();
    el('lightPanel').classList.remove('collapsed');
    el('lightPanelToggle').textContent = '\u2013';
  } else {
    applyPresets();
    el('lightPanel').classList.add('collapsed');
    el('lightPanelToggle').textContent = '+';
  }
  updateLightRig();
});

applyPresets(); // set frames/fps from the default speed + smoothness presets

// --- light panel controls ---
bindSeg('lightCountSeg', (btn) => { lightSettings.count = Number(btn.dataset.n); updateLightRig(); });
bindSeg('lightTypeSeg', (btn) => { lightSettings.type = btn.dataset.type; syncLightReadouts(); updateLightRig(); });

function bindLightRange(id, key) {
  const input = el(id);
  input.addEventListener('input', () => {
    lightSettings[key] = Number(input.value);
    syncLightReadouts();
    updateLightRig();
  });
}
bindLightRange('distance', 'distance');
bindLightRange('orbit', 'orbit');
bindLightRange('elevation', 'elevation');
bindLightRange('brightness', 'brightness');

el('lightColour').addEventListener('input', () => {
  lightSettings.colour = el('lightColour').value;
  updateLightRig();
});

el('lightPanelToggle').addEventListener('click', () => {
  const collapsed = el('lightPanel').classList.toggle('collapsed');
  el('lightPanelToggle').textContent = collapsed ? '+' : '\u2013';
  if (!collapsed) maybeCollapseOther('light');
});

// walk a dropped folder and pull all the File objects out of it
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

  // grab the directory entries synchronously, they expire after the first await
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
// resize + render loop
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
updateLightRig();

function renderLoop() {
  const now = performance.now();
  if (spinning && !capturing) {
    const dt = (now - lastFrameT) / 1000;
    // rotations per second the exported GIF will actually play at, i.e
    // frames * delayCs centiseconds for one full turn
    const rps = 100 / (settings.frames * settings.delayCs);
    phase = (phase + rps * dt) % 1;
    applyOrientation(phase);
    updateHUD();
  }
  lastFrameT = now;
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(renderLoop);