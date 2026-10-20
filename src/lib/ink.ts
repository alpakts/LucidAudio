// Paylaşılan ekran üzerine çizim. Çizgiler veri kanalıyla herkese gider ve lazer işaretçi gibi
// birkaç saniye sonra solar. Koordinatlar ekran görüntüsüne göre 0..1 aralığında: her boyutta aynı yere düşer.

export type Stroke = {
  id: string;
  by: string;
  name: string;
  color: string;
  pts: number[]; // x0, y0, x1, y1, ...
  done: number | null; // bittiği an (performance.now)
};

export type InkMsg =
  | { t: "ink"; owner: string; id: string; color: string; pts: number[]; done: boolean }
  | { t: "ink-clear"; owner: string };

const LIFE_MS = 4500;
const FADE_MS = 900;
const FLUSH_MS = 40;
const PALETTE = ["#ff5c5c", "#ffd166", "#06d6a0", "#7cc4ff", "#c77dff", "#ff9f1c"];

function colorFor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function strokeAlpha(s: Stroke, now: number) {
  if (s.done === null) return 1;
  const age = now - s.done;
  if (age >= LIFE_MS) return 0;
  return age > LIFE_MS - FADE_MS ? (LIFE_MS - age) / FADE_MS : 1;
}

export class Ink {
  // ekran sahibinin kimliği -> çizgiler
  private byOwner = new Map<string, Map<string, Stroke>>();
  private listeners = new Set<() => void>();
  private pending = new Map<string, { owner: string; from: number }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  // Paylaşan kişiye: "biri ekranına çiziyor" bildirimi.
  // Son çizimden 6 sn sonra kendiliğinden düşer.
  notice: { name: string } | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  readonly myColor: string;

  constructor(
    private readonly me: string,
    private readonly name: () => string,
    private readonly send: (msg: InkMsg) => void,
    private readonly onNotice: () => void,
  ) {
    this.myColor = colorFor(me);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  strokes(owner: string): Stroke[] {
    const map = this.byOwner.get(owner);
    if (!map) return [];
    const now = performance.now();
    for (const [id, s] of map) if (strokeAlpha(s, now) === 0) map.delete(id);
    return [...map.values()];
  }

  private stroke(owner: string, id: string, init: () => Stroke) {
    let map = this.byOwner.get(owner);
    if (!map) this.byOwner.set(owner, (map = new Map()));
    let s = map.get(id);
    if (!s) map.set(id, (s = init()));
    return s;
  }

  begin(owner: string, x: number, y: number) {
    const id = `${this.me}-${Math.random().toString(36).slice(2, 9)}`;
    const s = this.stroke(owner, id, () => ({ id, by: this.me, name: this.name(), color: this.myColor, pts: [], done: null }));
    s.pts.push(x, y);
    this.pending.set(id, { owner, from: 0 });
    this.schedule();
    this.changed();
    return id;
  }

  move(owner: string, id: string, x: number, y: number) {
    const s = this.byOwner.get(owner)?.get(id);
    if (!s || s.done !== null) return;
    s.pts.push(x, y);
    if (!this.pending.has(id)) this.pending.set(id, { owner, from: s.pts.length - 2 });
    this.schedule();
    this.changed();
  }

  end(owner: string, id: string) {
    const s = this.byOwner.get(owner)?.get(id);
    if (!s) return;
    s.done = performance.now();
    this.flush(id, true);
    this.changed();
  }

  clear(owner: string) {
    this.byOwner.delete(owner);
    this.send({ t: "ink-clear", owner });
    this.changed();
  }

  private schedule() {
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      for (const id of [...this.pending.keys()]) this.flush(id, false);
    }, FLUSH_MS);
  }

  private flush(id: string, done: boolean) {
    const p = this.pending.get(id);
    const s = p && this.byOwner.get(p.owner)?.get(id);
    if (!p || !s) {
      if (done) {
        // Her şey zaten gitmişse yalnızca "bitti" işaretini yolla.
        const owner = [...this.byOwner].find(([, m]) => m.has(id))?.[0];
        if (owner) this.send({ t: "ink", owner, id, color: this.myColor, pts: [], done: true });
      }
      return;
    }
    // Ağ yükünü azaltmak için 4 basamağa yuvarla.
    const pts = s.pts.slice(p.from).map((v) => Math.round(v * 1e4) / 1e4);
    this.pending.delete(id);
    this.send({ t: "ink", owner: p.owner, id, color: s.color, pts, done });
  }

  receive(from: string, fromName: string, msg: InkMsg) {
    if (msg.t === "ink-clear") {
      this.byOwner.delete(msg.owner);
      this.changed();
      return;
    }
    if (!Array.isArray(msg.pts) || msg.pts.length > 4000) return;
    const s = this.stroke(msg.owner, msg.id, () => ({
      id: msg.id,
      by: from,
      name: fromName,
      color: typeof msg.color === "string" && /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : colorFor(from),
      pts: [],
      done: null,
    }));
    for (const v of msg.pts) if (typeof v === "number" && v >= -0.1 && v <= 1.1) s.pts.push(v);
    if (msg.done) s.done = performance.now();
    if (msg.owner === this.me) {
      if (this.notice?.name !== fromName) {
        this.notice = { name: fromName };
        this.onNotice();
      }
      if (this.noticeTimer) clearTimeout(this.noticeTimer);
      this.noticeTimer = setTimeout(() => {
        this.notice = null;
        this.onNotice();
      }, 6000);
    }
    this.changed();
  }
}
