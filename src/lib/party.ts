// Senkron YouTube (birlikte izle): video herkesin cihazında doğrudan YouTube'dan oynar;
// veri kanalından yalnızca "hangi video, oynuyor mu, kaçıncı saniye" bilgisi gider.

export type PartyState = {
  videoId: string;
  playing: boolean;
  pos: number; // saniye; `at` anındaki konum
  at: number; // performance.now()
  leader: string; // son işlemi yapan: belirli aralıkla konumu o yayar
  by: string; // başlatanın adı
};

export type PartyMsg =
  | { t: "yt"; a: "state"; v: string; pos: number; playing: boolean; leader: string; by: string }
  | { t: "yt"; a: "stop" }
  | { t: "yt"; a: "ask" };

const SYNC_MS = 5000;

// youtube.com/watch?v=, youtu.be/, /shorts/, /live/, /embed/ ve m./music. alt alan adları.
export function parseYouTube(input: string): { id: string; start: number } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return /^[A-Za-z0-9_-]{11}$/.test(input.trim()) ? { id: input.trim(), start: 0 } : null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = url.searchParams.get("v") ?? url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)?.[1] ?? null;
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  // t=90, t=1m30s, start=90
  const t = url.searchParams.get("t") ?? url.searchParams.get("start") ?? "";
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  const start = m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
  return { id, start };
}

export class WatchParty {
  state: PartyState | null = null;
  private listeners = new Set<() => void>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  // Oynatıcının gerçek konumu (bileşen bağlar); lider periyodik olarak bunu yayar.
  positionOf: (() => number | null) | null = null;

  constructor(
    private readonly me: string,
    private readonly name: () => string,
    private readonly send: (msg: PartyMsg) => void,
    private readonly present: () => string[], // odadaki diğer kişilerin kimlikleri
    private readonly latencyOf: (from: string) => number, // saniye (tek yön)
    private readonly onChange: () => void,
  ) {}

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
    this.onChange();
  }

  // Şu an olması gereken konum.
  expected(now = performance.now()) {
    const s = this.state;
    if (!s) return 0;
    return s.pos + (s.playing ? (now - s.at) / 1000 : 0);
  }

  private broadcast() {
    const s = this.state;
    if (!s) return;
    this.send({ t: "yt", a: "state", v: s.videoId, pos: this.expected(), playing: s.playing, leader: s.leader, by: s.by });
  }

  private set(next: PartyState | null, announce: boolean) {
    this.state = next;
    if (announce) this.broadcast();
    this.ensureTimer();
    this.changed();
  }

  // ----- yerel işlemler (bu kişi yaptı, herkese duyur) -----

  start(videoId: string, startAt = 0) {
    this.set({ videoId, playing: true, pos: startAt, at: performance.now(), leader: this.me, by: this.name() }, true);
  }

  play(pos: number) {
    if (!this.state) return;
    this.set({ ...this.state, playing: true, pos, at: performance.now(), leader: this.me }, true);
  }

  pause(pos: number) {
    if (!this.state) return;
    this.set({ ...this.state, playing: false, pos, at: performance.now(), leader: this.me }, true);
  }

  seek(pos: number, playing: boolean) {
    if (!this.state) return;
    this.set({ ...this.state, playing, pos, at: performance.now(), leader: this.me }, true);
  }

  stop() {
    this.send({ t: "yt", a: "stop" });
    this.set(null, false);
  }

  // Odaya yeni bağlanan biri için durumu doğrudan yolla.
  stateFor(): PartyMsg | null {
    const s = this.state;
    return s ? { t: "yt", a: "state", v: s.videoId, pos: this.expected(), playing: s.playing, leader: s.leader, by: s.by } : null;
  }

  // ----- karşıdan gelen -----

  receive(from: string, msg: PartyMsg) {
    if (msg.a === "stop") {
      this.set(null, false);
      return;
    }
    if (msg.a === "ask") {
      const s = this.stateFor();
      if (s) this.send(s);
      return;
    }
    if (typeof msg.v !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(msg.v) || !Number.isFinite(msg.pos)) return;
    const lat = msg.playing ? this.latencyOf(from) : 0;
    this.set(
      {
        videoId: msg.v,
        playing: !!msg.playing,
        pos: Math.max(0, msg.pos + lat),
        at: performance.now(),
        leader: typeof msg.leader === "string" ? msg.leader : from,
        by: String(msg.by ?? "").slice(0, 40),
      },
      false,
    );
  }

  // Lider oynarken her 5 sn'de gerçek konumunu yayar; lider ayrıldıysa en küçük kimlik devralır.
  private ensureTimer() {
    if (this.state && !this.syncTimer) {
      this.syncTimer = setInterval(() => {
        const s = this.state;
        if (!s) return;
        const others = this.present();
        if (s.leader !== this.me && !others.includes(s.leader)) {
          if ([this.me, ...others].sort()[0] === this.me) s.leader = this.me;
        }
        if (s.leader !== this.me || !s.playing) return;
        const real = this.positionOf?.();
        if (real !== null && real !== undefined) {
          s.pos = real;
          s.at = performance.now();
        }
        this.broadcast();
      }, SYNC_MS);
    } else if (!this.state && this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  dispose() {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
  }
}
