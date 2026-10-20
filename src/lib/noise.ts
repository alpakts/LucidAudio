// Mikrofon hattı: ham ses → (Lucid: RNNoise ile gürültü engelleme) → seviye ölçer → kapı → giden ses.
// Lucid, Discord/Krisp tarzı yapay zekâ gürültü engellemesi; kapı ise ses etkinliği ve bas-konuş için.
// İşlem tamamen cihazda yapılır.

import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";

export type NoiseMode = "strong" | "standard" | "off";
export type InputMode = "always" | "gate" | "ptt";

let wasm: Promise<ArrayBuffer> | null = null;

export type MicChain = {
  track: MediaStreamTrack; // gönderilen parça
  lucid: boolean; // RNNoise gerçekten devrede mi
  setOpen: (open: boolean) => void; // kapı
  levelDb: () => number; // kapıdan önceki seviye (dBFS)
  stop: () => void; // hattı kapatır; ham parçaya dokunmaz
};

// Desteklenmezse (ses bağlamı başlatılamadı vb.) hata fırlatır; çağıran ham parçaya döner.
export async function createMicChain(raw: MediaStreamTrack, opts: { lucid: boolean }): Promise<MicChain> {
  // RNNoise 48 kHz bekliyor.
  const ctx = new AudioContext({ sampleRate: 48000 });
  try {
    const src = ctx.createMediaStreamSource(new MediaStream([raw]));
    let node: RnnoiseWorkletNode | null = null;
    if (opts.lucid) {
      wasm ??= loadRnnoise({ url: "/noise/rnnoise.wasm", simdUrl: "/noise/rnnoise_simd.wasm" }).catch((e) => {
        wasm = null;
        throw e;
      });
      const [binary] = await Promise.all([wasm, ctx.audioWorklet.addModule("/noise/rnnoiseWorklet.js")]);
      node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: binary });
    }
    const meter = ctx.createAnalyser();
    meter.fftSize = 1024;
    const gate = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();
    (node ? src.connect(node) : src).connect(meter);
    meter.connect(gate).connect(dest);

    // Ses bağlamı askıda kalırsa giden ses sessiz olur; o durumda hiç kullanmamak daha iyi.
    await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
    if (ctx.state !== "running") throw new Error("ses bağlamı başlatılamadı");
    const wake = () => void ctx.resume();
    document.addEventListener("pointerdown", wake);

    const buf = new Float32Array(meter.fftSize);
    const track = dest.stream.getAudioTracks()[0];
    return {
      track,
      lucid: !!node,
      // Açılış hızlı (kelimenin başı kesilmesin), kapanış yumuşak (tık sesi olmasın).
      setOpen: (open) => gate.gain.setTargetAtTime(open ? 1 : 0, ctx.currentTime, open ? 0.004 : 0.04),
      levelDb: () => {
        meter.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const x of buf) sum += x * x;
        const rms = Math.sqrt(sum / buf.length);
        return rms > 0 ? 20 * Math.log10(rms) : -100;
      },
      stop: () => {
        document.removeEventListener("pointerdown", wake);
        track.stop();
        node?.destroy();
        void ctx.close();
      },
    };
  } catch (e) {
    void ctx.close();
    throw e;
  }
}
