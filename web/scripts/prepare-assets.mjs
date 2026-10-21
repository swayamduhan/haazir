// Places the on-device liveness model and its WASM runtime under public/, so
// the demo works on a classroom network without reaching a CDN mid-session.
// Both are generated assets and are git-ignored; this script recreates them.
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const wasmSrc = join(dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
const wasmDst = join(web, 'public', 'mediapipe', 'wasm');
mkdirSync(wasmDst, { recursive: true });
cpSync(wasmSrc, wasmDst, { recursive: true });
console.log('liveness runtime  -> public/mediapipe/wasm');

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const model = join(web, 'public', 'models', 'face_landmarker.task');
if (existsSync(model) && statSync(model).size > 1_000_000) {
  console.log('liveness model    -> already present');
} else {
  mkdirSync(dirname(model), { recursive: true });
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  writeFileSync(model, Buffer.from(await res.arrayBuffer()));
  console.log(`liveness model    -> public/models (${Math.round(statSync(model).size / 1024)} KB)`);
}
