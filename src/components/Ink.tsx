"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { strokeAlpha, type Ink } from "@/lib/ink";
import { StreamVideo } from "./Media";

// object-contain videoda görüntünün kutu içindeki gerçek alanı (siyah şeritler hariç).
function contentRect(video: HTMLVideoElement | null, w: number, h: number) {
  const vw = video?.videoWidth || 16;
  const vh = video?.videoHeight || 9;
  const scale = Math.min(w / vw, h / vh);
  const cw = vw * scale;
  const ch = vh * scale;
  return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch };
}

// Bir ekran görüntüsünün üstündeki çizim katmanı. `drawing` açıkken fareyle/parmakla çizilir.
// Pencere arka planda olsa da (paylaşan kişinin önizleme penceresi) kendi penceresinin
// requestAnimationFrame'ini kullanır.
export function InkLayer({
  ink,
  owner,
  videoRef,
  drawing,
}: {
  ink: Ink;
  owner: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  drawing: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef<string | null>(null);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const win = cv.ownerDocument.defaultView ?? window;
    const ctx = cv.getContext("2d")!;
    let raf = 0;
    let running = false;

    const frame = () => {
      raf = 0;
      const dpr = win.devicePixelRatio || 1;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const r = contentRect(videoRef.current, w, h);
      const now = performance.now();
      const strokes = ink.strokes(owner);
      for (const s of strokes) {
        const a = strokeAlpha(s, now);
        if (a <= 0 || s.pts.length < 2) continue;
        ctx.globalAlpha = a;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = Math.max(3, r.w / 320);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.shadowColor = s.color;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(r.x + s.pts[0] * r.w, r.y + s.pts[1] * r.h);
        if (s.pts.length === 2) ctx.lineTo(r.x + s.pts[0] * r.w + 0.1, r.y + s.pts[1] * r.h);
        for (let i = 2; i < s.pts.length; i += 2) ctx.lineTo(r.x + s.pts[i] * r.w, r.y + s.pts[i + 1] * r.h);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Solmakta olan çizgi varken çizmeye devam et, yoksa bir sonraki değişikliğe kadar dur.
      running = strokes.length > 0;
      if (running) raf = win.requestAnimationFrame(frame);
    };
    const wake = () => {
      if (!raf) raf = win.requestAnimationFrame(frame);
    };
    const unsub = ink.subscribe(wake);
    const RO = (win as typeof window).ResizeObserver ?? ResizeObserver;
    const ro = new RO(wake);
    ro.observe(cv);
    wake();
    return () => {
      unsub();
      ro.disconnect();
      if (raf) win.cancelAnimationFrame(raf);
    };
  }, [ink, owner, videoRef]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const r = contentRect(videoRef.current, box.width, box.height);
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return [clamp((e.clientX - box.left - r.x) / r.w), clamp((e.clientY - box.top - r.y) / r.h)] as const;
  };

  return (
    <canvas
      ref={canvas}
      className={`absolute inset-0 size-full ${drawing ? "cursor-crosshair touch-none" : "pointer-events-none"}`}
      onClick={(e) => drawing && e.stopPropagation()}
      onDoubleClick={(e) => drawing && e.stopPropagation()}
      onPointerDown={(e) => {
        if (!drawing) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const [x, y] = point(e);
        current.current = ink.begin(owner, x, y);
      }}
      onPointerMove={(e) => {
        if (!drawing || !current.current) return;
        const [x, y] = point(e);
        ink.move(owner, current.current, x, y);
      }}
      onPointerUp={() => {
        if (current.current) ink.end(owner, current.current);
        current.current = null;
      }}
      onPointerCancel={() => {
        if (current.current) ink.end(owner, current.current);
        current.current = null;
      }}
    />
  );
}

// Paylaşan kişinin kendi ekranı + üzerindeki çizimler (yalnızca görüntü).
function SelfInkView({ ink, owner, stream }: { ink: Ink; owner: string; stream: MediaStream }) {
  const video = useRef<HTMLVideoElement>(null);
  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "#000" }}>
      <StreamVideo stream={stream} muted fit="contain" videoRef={video} className="absolute inset-0 size-full" />
      <InkLayer ink={ink} owner={owner} videoRef={video} drawing={false} />
    </div>
  );
}

type PipApi = { requestWindow: (o: { width: number; height: number }) => Promise<Window> };
const pipApi = () => (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture;

// Her zaman üstte duran küçük pencere (Chrome'un belge PiP'i): paylaşan kişi başka uygulamadayken de
// çizimleri görür. Desteklenmeyen tarayıcıda sayfa içinde yüzen bir panel olarak açılır.
export function SelfInkWindow({
  ink,
  owner,
  stream,
  onClose,
}: {
  ink: Ink;
  owner: string;
  stream: MediaStream;
  onClose: () => void;
}) {
  const [pip, setPip] = useState<Window | null>(null);
  // PiP desteklenmiyorsa baştan sayfa içi panel.
  const [fallback, setFallback] = useState(() => !pipApi());
  const opened = useRef(false);
  const winRef = useRef<Window | null>(null);

  // Bileşen kalkınca pencereyi de kapat.
  useEffect(() => () => winRef.current?.close(), []);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const api = pipApi();
    if (!api) return;
    // Bu bileşen bir düğmeye basınca kurulur: kullanıcı hareketi hâlâ geçerli.
    api
      .requestWindow({ width: 480, height: 300 })
      .then((w) => {
        winRef.current = w;
        // Sayfanın stillerini PiP penceresine taşı.
        for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]'))
          w.document.head.appendChild(node.cloneNode(true));
        w.document.body.style.margin = "0";
        w.document.body.style.background = "#000";
        w.document.title = "Pencere: çizimler";
        w.addEventListener("pagehide", onClose, { once: true });
        setPip(w);
      })
      .catch(() => setFallback(true));
  }, [onClose]);

  if (pip) return createPortal(<SelfInkView ink={ink} owner={owner} stream={stream} />, pip.document.body);
  if (!fallback) return null;
  return (
    <div className="fixed z-40 left-3 bottom-24 w-[min(22rem,calc(100vw-1.5rem))] aspect-video rounded-xl overflow-hidden border border-line shadow-2xl shadow-black/60 bg-black">
      <SelfInkView ink={ink} owner={owner} stream={stream} />
      <button
        onClick={onClose}
        aria-label="Önizlemeyi kapat"
        className="absolute right-1.5 top-1.5 size-7 rounded-lg bg-black/60 grid place-items-center"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
