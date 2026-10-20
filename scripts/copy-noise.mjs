// RNNoise'un ses işleme dosyalarını (worklet + wasm) public/noise altına kopyalar.
// Tarayıcı bunları ayrı dosya olarak yüklemek zorunda; paket güncellenince kopya da güncellensin diye
// her dev/build öncesi çalışır.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "@sapphi-red", "web-noise-suppressor", "dist");
const out = join(root, "public", "noise");
mkdirSync(out, { recursive: true });
for (const [from, to] of [
  ["rnnoise/workletProcessor.js", "rnnoiseWorklet.js"],
  ["rnnoise.wasm", "rnnoise.wasm"],
  ["rnnoise_simd.wasm", "rnnoise_simd.wasm"],
]) {
  copyFileSync(join(src, from), join(out, to));
}
