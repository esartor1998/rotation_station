import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

// ---------------------------------------------------------------------------
// Scene, camera, renderer
// ---------------------------------------------------------------------------
const stage = document.getElementById('stage');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f12);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(0, 0, 5);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
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

// Fallback material for meshes that arrive without one.
const defaultMaterial = new THREE.MeshStandardMaterial({
  color: 0x9aa4b2, metalness: 0.05, roughness: 0.75, side: THREE.DoubleSide,
});

let currentModel = null;   // the centered/scaled group inside the pivot
let baseDistance = 5;      // camera Z that framed the model at zoom = 1

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
const loader = new OBJLoader();

function loadFromText(text, name = 'model.obj') {
  let object;
  try {
    object = loader.parse(text);
  } catch (err) {
    return status(`Parse failed: ${err.message}`, 'error');
  }
  if (!object || object.children.length === 0) {
    return status('No geometry found in that file.', 'error');
  }
  installModel(object, name);
}

function installModel(object, name) {
  // Drop the previous model.
  if (currentModel) {
    pivot.remove(currentModel);
    disposeTree(currentModel);
  }

  let triangles = 0;
  object.traverse((child) => {
    if (!child.isMesh) return;
    if (!child.geometry.attributes.normal) child.geometry.computeVertexNormals();
    if (isDefaultObjMaterial(child.material)) child.material = defaultMaterial;
    const g = child.geometry;
    triangles += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  });

  // Center the model's bounding box on the pivot origin, then scale it so its
  // largest dimension is ~2 world units — this frames any model consistently.
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const container = new THREE.Group();
  object.position.sub(center);          // recenter geometry
  container.add(object);
  container.scale.setScalar(2 / maxDim); // normalize size

  currentModel = container;
  pivot.add(container);

  resetView();

  document.getElementById('hud-name').textContent = name;
  document.getElementById('hud-tris').textContent =
    Math.round(triangles).toLocaleString();
  status(`Loaded ${name}`, 'ok');
}

async function loadFromURL(rawUrl) {
  const url = rawUrl.trim();
  if (!url) return;
  status('Fetching…', 'busy', 0);
  try {
    // Go through the server proxy to dodge cross-origin restrictions.
    const res = await fetch('/proxy?url=' + encodeURIComponent(url));
    if (!res.ok) throw new Error(await res.text());
    const text = await res.text();
    const name = url.split('/').pop().split('?')[0] || 'model.obj';
    loadFromText(text, name);
  } catch (err) {
    status(`Load failed: ${err.message}`, 'error');
  }
}

function loadFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadFromText(reader.result, file.name);
  reader.onerror = () => status('Could not read that file.', 'error');
  reader.readAsText(file);
}

// A freshly-parsed OBJ mesh with no .mtl gets a plain white MeshPhongMaterial.
// Detect that so we can swap in something nicer, but keep real materials.
function isDefaultObjMaterial(mat) {
  return mat && mat.isMeshPhongMaterial && mat.name === '';
}

function disposeTree(root) {
  root.traverse((child) => {
    if (child.isMesh) {
      child.geometry?.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => m && m !== defaultMaterial && m.dispose());
    }
  });
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
  } else {
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
  const dist = camera.position.z; // camera looks down -Z at the origin plane
  const worldPerPixel =
    (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / stage.clientHeight;
  pivot.position.x += dxPixels * worldPerPixel;
  pivot.position.y -= dyPixels * worldPerPixel;
}

// Scroll to zoom (dolly the camera; the model never moves off its own axis).
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoom = clamp(zoom * (e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP), MIN_ZOOM, MAX_ZOOM);
  camera.position.z = baseDistance / zoom;
  updateHUD();
}, { passive: false });

// Arrow keys nudge the model around; R recenters, G toggles the grid.
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
  el('hud-rot').textContent = `${deg(e.x)}°, ${deg(e.y)}°, ${deg(e.z)}°`;
  el('hud-pos').textContent =
    `${pivot.position.x.toFixed(2)}, ${pivot.position.y.toFixed(2)}`;
  el('hud-zoom').textContent = `${zoom.toFixed(2)}×`;
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
// Wiring
// ---------------------------------------------------------------------------
el('loadUrl').addEventListener('click', () => loadFromURL(el('url').value));
el('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadFromURL(el('url').value);
});
el('file').addEventListener('change', (e) => loadFromFile(e.target.files[0]));
el('reset').addEventListener('click', resetView);

// Drag-and-drop a file anywhere onto the viewport.
const drop = el('drop');
window.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('show'); });
window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) drop.classList.remove('show'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('show');
  const file = e.dataTransfer.files[0];
  if (file && /\.obj$/i.test(file.name)) loadFromFile(file);
  else status('Drop a .obj file.', 'error');
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

renderer.setAnimationLoop(() => renderer.render(scene, camera));
