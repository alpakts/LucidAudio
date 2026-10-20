// Lucid: Discord/Krisp tarzı gürültü engelleme. Mikrofon sesi tarayıcıda RNNoise (yapay zekâ modeli)
// üzerinden geçer, temizlenmiş ses gönderilir. İşlem tamamen cihazda yapılır.

import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";

export type NoiseMode = "strong" | "standard" | "off";

let wasm: Promise<ArrayBuffer> | null = null;

export type CleanMic = { track: MediaStreamTrack; stop: () => void };

// Ham mikrofon parçasını alır, temizlenmiş bir parça döner. stop() ikisini de kapatır.
// Desteklenmezse (eski tarayıcı, ses bağlamı başlatılamadı) hata fırlatır; çağıran ham parçaya döner.
export async function suppressNoise(raw: MediaStreamTrack): Promise<CleanMic> {
  // RNNoise 48 kHz bekliyor.
  const ctx = new AudioContext({ sampleRate: 48000 });
  try {
    wasm ??= loadRnnoise({ url: "/noise/rnnoise.wasm", simdUrl: "/noise/rnnoise_simd.wasm" }).catch((e) => {
      wasm = null;
      throw e;
    });
    const [binary] = await Promise.all([wasm, ctx.audioWorklet.addModule("/noise/rnnoiseWorklet.js")]);
    const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: binary });
    const src = ctx.createMediaStreamSource(new MediaStream([raw]));
    const dest = ctx.createMediaStreamDestination();
    src.connect(node).connect(dest);

    // Ses bağlamı askıda kalırsa temiz parça sessiz olur; o durumda hiç kullanmamak daha iyi.
    await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
    if (ctx.state !== "running") throw new Error("ses bağlamı başlatılamadı");
    const wake = () => void ctx.resume();
    document.addEventListener("pointerdown", wake);

    const track = dest.stream.getAudioTracks()[0];
    return {
      track,
      stop: () => {
        document.removeEventListener("pointerdown", wake);
        track.stop();
        raw.stop();
        node.destroy();
        void ctx.close();
      },
    };
  } catch (e) {
    void ctx.close();
    throw e;
  }
}
