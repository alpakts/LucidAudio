// Arka plan bulanıklaştırma: MediaPipe kişi ayırma modeli her karede kişiyi arka plandan ayırır,
// arka plan bulanıklaşır, kişi net kalır. İşlem cihazda (mümkünse ekran kartında) yapılır.

import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";

export type BlurMode = "off" | "light" | "strong";

// Google'ın resmi kişi ayırma modeli (256x256, ~250 KB); tarayıcı önbelleğe alır.
const MODEL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

let segmenter: Promise<ImageSegmenter> | null = null;
function getSegmenter() {
  return (segmenter ??= (async () => {
    const files = await FilesetResolver.forVisionTasks("/mediapipe");
    const make = (delegate: "GPU" | "CPU") =>
      ImageSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: "VIDEO",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    return make("GPU").catch(() => make("CPU"));
  })().catch((e) => {
    segmenter = null;
    throw e;
  }));
}

export type BlurChain = {
  track: MediaStreamTrack;
  setMode: (mode: BlurMode) => void;
  stop: () => void; // hattı kapatır; ham parçaya dokunmaz
};

type Painter = {
  paint: (frame: CanvasImageSource, w: number, h: number, ts: number) => void;
  canvas: OffscreenCanvas | HTMLCanvasElement;
};

// Bir kareyi bulanık arka planla çizen ortak boru. Kişi maskesi iki karede bir yenilenir.
function makePainter(seg: ImageSegmenter, mode: () => BlurMode, canvas: OffscreenCanvas | HTMLCanvasElement): Painter {
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const maskCanvas = new OffscreenCanvas(1, 1);
  const maskCtx = maskCanvas.getContext("2d")!;
  let maskData: ImageData | null = null;
  let n = 0;
  let lastTs = 0;

  return {
    canvas,
    paint(frame, w, h, ts) {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      // Model zaman damgalarının artmasını ister.
      const t = Math.max(ts, lastTs + 1);
      lastTs = t;
      if (n++ % 2 === 0) {
        const res = seg.segmentForVideo(frame as TexImageSource, t);
        const mask = res.confidenceMasks?.[0];
        if (mask) {
          if (maskCanvas.width !== mask.width || maskCanvas.height !== mask.height) {
            maskCanvas.width = mask.width;
            maskCanvas.height = mask.height;
            maskData = null;
          }
          maskData ??= maskCtx.createImageData(mask.width, mask.height);
          const conf = mask.getAsFloat32Array();
          const px = maskData.data;
          for (let i = 0; i < conf.length; i++) px[i * 4 + 3] = conf[i] * 255;
          maskCtx.putImageData(maskData, 0, 0);
        }
        res.close();
      }
      const blurPx = Math.round((mode() === "strong" ? 18 : 8) * (w / 1280));
      ctx.save();
      // 1) kişi maskesi (kenarları yumuşak), 2) kişiyi maskenin içine, 3) bulanık kareyi arkasına
      ctx.globalCompositeOperation = "copy";
      ctx.filter = "blur(3px)";
      ctx.drawImage(maskCanvas, 0, 0, w, h);
      ctx.filter = "none";
      ctx.globalCompositeOperation = "source-in";
      ctx.drawImage(frame, 0, 0, w, h);
      ctx.globalCompositeOperation = "destination-over";
      ctx.filter = `blur(${Math.max(2, blurPx)}px)`;
      // Bulanığın kenarları kararmasın diye biraz taşırarak çiz.
      const pad = blurPx * 2;
      ctx.drawImage(frame, -pad, -pad, w + pad * 2, h + pad * 2);
      ctx.restore();
    },
  };
}

type TrackProcessor = { readable: ReadableStream<VideoFrame> };
type TrackGenerator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type ProcessorCtor = new (o: { track: MediaStreamTrack }) => TrackProcessor;
type GeneratorCtor = new (o: { kind: "video" }) => TrackGenerator;

export async function createBlurChain(raw: MediaStreamTrack, initial: BlurMode): Promise<BlurChain> {
  const seg = await getSegmenter();
  let mode = initial;
  let stopped = false;
  const w = window as unknown as { MediaStreamTrackProcessor?: ProcessorCtor; MediaStreamTrackGenerator?: GeneratorCtor };

  // Chrome: kareler akış olarak işlenir; sekme arka plandayken de yavaşlamaz
  // (ekran paylaşırken başka uygulamaya geçince kamera donmasın).
  if (w.MediaStreamTrackProcessor && w.MediaStreamTrackGenerator) {
    const processor = new w.MediaStreamTrackProcessor({ track: raw });
    const generator = new w.MediaStreamTrackGenerator({ kind: "video" });
    const reader = processor.readable.getReader();
    const writer = generator.writable.getWriter();
    const painter = makePainter(seg, () => mode, new OffscreenCanvas(1, 1));
    void (async () => {
      try {
        while (!stopped) {
          const { value: frame, done } = await reader.read();
          if (done || !frame) break;
          try {
            painter.paint(frame, frame.displayWidth, frame.displayHeight, frame.timestamp / 1000);
            const out = new VideoFrame(painter.canvas as OffscreenCanvas, { timestamp: frame.timestamp });
            frame.close();
            await writer.write(out);
          } catch (e) {
            frame.close();
            throw e;
          }
        }
      } catch (e) {
        if (!stopped) console.warn("bulanıklaştırma durdu", e);
      }
    })();
    return {
      track: generator,
      setMode: (m) => (mode = m),
      stop: () => {
        stopped = true;
        void reader.cancel().catch(() => {});
        void writer.close().catch(() => {});
        generator.stop();
      },
    };
  }

  // Diğer tarayıcılar: gizli video + tuval. Sekme arka plandayken yavaşlayabilir.
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([raw]);
  await video.play();
  const canvas = document.createElement("canvas");
  const painter = makePainter(seg, () => mode, canvas);
  const out = canvas.captureStream(30).getVideoTracks()[0];
  const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
  const tick = () => {
    if (stopped) return;
    if (video.videoWidth) painter.paint(video, video.videoWidth, video.videoHeight, performance.now());
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick);
    else setTimeout(tick, 33);
  };
  tick();
  return {
    track: out,
    setMode: (m) => (mode = m),
    stop: () => {
      stopped = true;
      out.stop();
      video.srcObject = null;
    },
  };
}
