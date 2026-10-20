"use client";

import { useEffect, useRef, useState } from "react";
import { Hand, X } from "lucide-react";
import type { WatchParty } from "@/lib/party";

// YouTube IFrame API'nin kullandığımız kısmı.
type YTPlayer = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  loadVideoById(o: { videoId: string; startSeconds?: number }): void;
  cueVideoById(o: { videoId: string; startSeconds?: number }): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  getVideoData?(): { video_id?: string };
  destroy(): void;
};
type YTNamespace = {
  Player: new (
    el: HTMLElement,
    o: {
      videoId: string;
      width?: string;
      height?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
};

const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;
const ENDED = 0;
const DRIFT = 0.6; // saniye: bundan fazla kayma varsa doğru yere atla

let apiLoad: Promise<YTNamespace> | null = null;
function loadYouTubeApi() {
  return (apiLoad ??= new Promise<YTNamespace>((resolve, reject) => {
    const w = window as unknown as { YT?: YTNamespace & { loaded?: number }; onYouTubeIframeAPIReady?: () => void };
    if (w.YT?.Player) return resolve(w.YT);
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(w.YT!);
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.async = true;
    s.onerror = () => {
      apiLoad = null;
      reject(new Error("YouTube yüklenemedi"));
    };
    document.head.appendChild(s);
  }));
}

function errorText(code: number) {
  if (code === 101 || code === 150 || code === 153)
    return "Bu videoyu sahibi başka sitelerde oynatmaya kapatmış. Ekran paylaşımıyla birlikte izleyebilirsiniz.";
  if (code === 100) return "Video bulunamadı (silinmiş ya da gizli).";
  if (code === 2) return "Geçersiz video bağlantısı.";
  return `Video oynatılamadı (hata ${code}).`;
}

export function YouTubeStage({ party, hidden, onStop }: { party: WatchParty; hidden: boolean; onStop: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const ready = useRef(false);
  // Uzaktan gelen komutu uygularken oynatıcının ürettiği olayları "kullanıcı yaptı" sanmamak için.
  const quietUntil = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [needTap, setNeedTap] = useState(false);
  const videoId = party.state?.videoId ?? null;

  // Oynatıcıyı bir kez kur.
  useEffect(() => {
    let disposed = false;
    const el = host.current;
    if (!el || !party.state) return;
    const first = party.state;
    const mount = document.createElement("div");
    el.appendChild(mount);

    const quiet = (ms = 900) => (quietUntil.current = performance.now() + ms);

    // Durumu oynatıcıya uygula.
    const apply = () => {
      const p = player.current;
      const s = party.state;
      if (!p || !ready.current || !s) return;
      const current = p.getVideoData?.().video_id;
      const want = party.expected();
      if (current && current !== s.videoId) {
        quiet(1500);
        if (s.playing) p.loadVideoById({ videoId: s.videoId, startSeconds: want });
        else p.cueVideoById({ videoId: s.videoId, startSeconds: want });
        setError(null);
        return;
      }
      const state = p.getPlayerState();
      if (Math.abs(p.getCurrentTime() - want) > DRIFT) {
        quiet();
        p.seekTo(want, true);
      }
      if (s.playing && state !== PLAYING && state !== BUFFERING) {
        quiet();
        p.playVideo();
        // Telefon sesli başlatmayı engellediyse dokunma iste.
        setTimeout(() => {
          const now = player.current?.getPlayerState();
          if (party.state?.playing && now !== PLAYING && now !== BUFFERING) setNeedTap(true);
        }, 1500);
      } else if (!s.playing && state === PLAYING) {
        quiet();
        p.pauseVideo();
      }
    };

    let lastPos = 0;
    let lastAt = performance.now();
    let primed = false; // ilk ölçüm yalnızca başlangıç değeri: açılıştaki atlama "ileri sarma" sayılmasın
    let poll: ReturnType<typeof setInterval> | null = null;

    void loadYouTubeApi()
      .then((YT) => {
        if (disposed) return;
        player.current = new YT.Player(mount, {
          videoId: first.videoId,
          width: "100%",
          height: "100%",
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1, start: Math.floor(party.expected()) },
          events: {
            onReady: () => {
              ready.current = true;
              party.positionOf = () => (ready.current ? (player.current?.getCurrentTime() ?? null) : null);
              apply();
            },
            onStateChange: (e) => {
              if (e.data === PLAYING) setNeedTap(false);
              const s = party.state;
              const p = player.current;
              if (!s || !p || performance.now() < quietUntil.current) return;
              // Kullanıcı YouTube'un kendi düğmeleriyle oynattı/durdurdu: herkese duyur.
              if (e.data === PLAYING && !s.playing) party.play(p.getCurrentTime());
              else if ((e.data === PAUSED || e.data === ENDED) && s.playing) party.pause(p.getCurrentTime());
            },
            onError: (e) => setError(errorText(e.data)),
          },
        });
        // İleri/geri sarmanın olayı yok: konumdaki sıçramayı yakala.
        poll = setInterval(() => {
          const p = player.current;
          const s = party.state;
          if (!p || !ready.current || !s) return;
          const now = performance.now();
          const pos = p.getCurrentTime();
          const playing = p.getPlayerState() === PLAYING;
          const state = p.getPlayerState();
          const predicted = lastPos + (playing ? (now - lastAt) / 1000 : 0);
          const settled = state === PLAYING || state === PAUSED;
          if (primed && settled && now > quietUntil.current && Math.abs(pos - predicted) > 1.5) party.seek(pos, s.playing);
          primed = settled;
          lastPos = pos;
          lastAt = now;
        }, 500);
      })
      .catch(() => setError("YouTube yüklenemedi. İnternet bağlantını ya da reklam engelleyiciyi kontrol et."));

    const unsub = party.subscribe(apply);
    return () => {
      disposed = true;
      unsub();
      if (poll) clearInterval(poll);
      party.positionOf = null;
      ready.current = false;
      player.current?.destroy();
      player.current = null;
      mount.remove();
    };
    // Oynatıcı oturum boyunca bir kez kurulur; video değişimi apply() ile yapılır.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party, videoId === null]);

  return (
    <div className={`absolute inset-0 rounded-2xl overflow-hidden bg-black border border-line ${hidden ? "invisible" : ""}`}>
      <div ref={host} className="absolute inset-0 [&>div]:size-full [&_iframe]:size-full" />
      <div className="absolute left-2 top-2 h-7 px-2.5 rounded-lg bg-black/70 backdrop-blur text-xs flex items-center gap-1.5 pointer-events-none">
        <span className="size-2 rounded-full bg-red-500" />
        Birlikte izleniyor{party.state?.by ? ` · ${party.state.by} başlattı` : ""}
      </div>
      <button
        onClick={onStop}
        title="Herkes için birlikte izlemeyi bitir"
        className="absolute right-2 top-2 h-8 px-2.5 rounded-lg bg-black/70 backdrop-blur text-xs flex items-center gap-1.5 hover:bg-black/85"
      >
        <X className="size-3.5" />
        Bitir
      </button>
      {needTap && !error && (
        <button
          onClick={() => {
            setNeedTap(false);
            player.current?.playVideo();
          }}
          className="absolute inset-0 grid place-items-center bg-black/60 text-center"
        >
          <span className="flex flex-col items-center gap-3">
            <Hand className="size-8" />
            <span className="font-medium">İzlemek için dokun</span>
            <span className="text-xs text-muted">Tarayıcın sesli videoyu dokunmadan başlatmıyor.</span>
          </span>
        </button>
      )}
      {error && (
        <div className="absolute inset-0 grid place-items-center bg-black/85 p-6 text-center">
          <p className="max-w-sm text-sm leading-relaxed">{error}</p>
        </div>
      )}
    </div>
  );
}
