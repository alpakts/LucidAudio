// Discord gibi giriş/çıkış bildirim sesleri. Dosya yok: kısa tınılar tarayıcıda üretilir.
// Her çağrı "pencere:sound" olayı da yayar (sesler kapalıyken bile); arayüz/test bunu dinleyebilir.

export type SoundKind = "join" | "leave";

let ctx: AudioContext | null = null;

function context(sinkId?: string) {
  ctx ??= new AudioContext();
  const c = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };
  // Seçili hoparlörden çalsın (destekleyen tarayıcıda).
  if (c.setSinkId && sinkId !== undefined && c.sinkId !== sinkId) void c.setSinkId(sinkId).catch(() => {});
  void c.resume();
  return c;
}

// Yükselen iki nota: biri geldi. Alçalan iki nota: biri gitti.
const NOTES: Record<SoundKind, number[]> = {
  join: [659.25, 987.77], // E5 → B5
  leave: [987.77, 587.33], // B5 → D5
};

export function playSound(kind: SoundKind, opts: { enabled: boolean; sinkId?: string }) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("pencere:sound", { detail: kind }));
  if (!opts.enabled) return;
  try {
    const c = context(opts.sinkId);
    const start = c.currentTime + 0.02;
    NOTES[kind].forEach((freq, i) => {
      const t = start + i * 0.11;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      // Yumuşak giriş ve sönüm: tık sesi olmasın, kulak tırmalamasın.
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain).connect(c.destination);
      osc.start(t);
      osc.stop(t + 0.25);
    });
  } catch {
    /* ses çalınamazsa sessizce geç */
  }
}
