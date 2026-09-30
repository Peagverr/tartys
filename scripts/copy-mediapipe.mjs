// Копирует WASM-рантайм MediaPipe в public/, чтобы приложение не зависело от CDN.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dst = join(root, 'public', 'mediapipe', 'wasm');

if (!existsSync(src)) {
  console.warn('[copy-mediapipe] wasm folder not found, skipping');
  process.exit(0);
}
mkdirSync(dst, { recursive: true });
// ES-модульные сборки WASM нам не нужны (грузим обычные) — не раздуваем сайт.
cpSync(src, dst, { recursive: true, filter: (f) => !basename(f).includes('module') });
console.log('[copy-mediapipe] wasm copied to public/mediapipe/wasm');
