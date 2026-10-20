// Tarayıcının ayrı dosya olarak yüklemesi gereken ses/görüntü işleme dosyalarını public altına kopyalar:
//   public/noise      RNNoise (Lucid gürültü engelleme) worklet + wasm
//   public/mediapipe  MediaPipe kişi ayırma (arka plan bulanıklaştırma) wasm
// Paket güncellenince kopya da güncellensin diye her dev/build öncesi çalışır.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const copy = (srcDir, outDir, pairs) => {
  mkdirSync(outDir, { recursive: true });
  for (const [from, to] of pairs) copyFileSync(join(srcDir, from), join(outDir, to));
};

copy(join(root, "node_modules", "@sapphi-red", "web-noise-suppressor", "dist"), join(root, "public", "noise"), [
  ["rnnoise/workletProcessor.js", "rnnoiseWorklet.js"],
  ["rnnoise.wasm", "rnnoise.wasm"],
  ["rnnoise_simd.wasm", "rnnoise_simd.wasm"],
]);

copy(join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm"), join(root, "public", "mediapipe"), [
  ["vision_wasm_internal.js", "vision_wasm_internal.js"],
  ["vision_wasm_internal.wasm", "vision_wasm_internal.wasm"],
  ["vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.js"],
  ["vision_wasm_nosimd_internal.wasm", "vision_wasm_nosimd_internal.wasm"],
]);
