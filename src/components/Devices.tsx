"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronUp } from "lucide-react";

export type DeviceKind = "mic" | "cam" | "speaker";
const MEDIA_KIND: Record<DeviceKind, MediaDeviceKind> = { mic: "audioinput", cam: "videoinput", speaker: "audiooutput" };
const FALLBACK: Record<DeviceKind, string> = { mic: "Mikrofon", cam: "Kamera", speaker: "Hoparlör" };

export type DeviceOption = { id: string; label: string };

// Cihaz listesi; takılıp çıkarılınca ve izin verilince (etiketler o zaman dolar) yenilenir.
export function useDevices(refreshKey: unknown) {
  const [all, setAll] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.enumerateDevices) return;
    let alive = true;
    const load = () =>
      md
        .enumerateDevices()
        .then((list) => alive && setAll(list))
        .catch(() => {});
    void load();
    md.addEventListener("devicechange", load);
    return () => {
      alive = false;
      md.removeEventListener("devicechange", load);
    };
  }, [refreshKey]);

  const of = (kind: DeviceKind): DeviceOption[] =>
    all
      .filter((d) => d.kind === MEDIA_KIND[kind] && d.deviceId)
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${FALLBACK[kind]} ${i + 1}` }));
  return { mic: of("mic"), cam: of("cam"), speaker: of("speaker"), labeled: all.some((d) => d.label) };
}

// Mikrofon seviyesi 0..1. Konuşunca kıpırdayan çubuklar için.
export function useAudioLevel(track: MediaStreamTrack | null | undefined) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!track || track.readyState === "ended") return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 80) return;
      last = now;
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
    };
    raf = requestAnimationFrame(tick);
    // Dokunuş olmadan açılan AudioContext askıda başlar; ilk dokunuşta uyandır.
    const wake = () => void ctx.resume();
    window.addEventListener("pointerdown", wake, { once: true });
    void ctx.resume();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointerdown", wake);
      void ctx.close();
      setLevel(0);
    };
  }, [track]);
  return level;
}

export function LevelBars({ level, className = "" }: { level: number; className?: string }) {
  const h = [0.55, 1, 0.55].map((k) => Math.max(0.18, Math.min(1, level * k * 1.6)));
  return (
    <span className={`inline-flex items-center gap-[2px] h-3.5 ${className}`} aria-hidden>
      {h.map((v, i) => (
        <span key={i} className="w-[3px] rounded-full bg-accent transition-[height] duration-75" style={{ height: `${v * 100}%` }} />
      ))}
    </span>
  );
}

// Giriş ekranındaki seçim kutusu.
export function DeviceSelect({
  label,
  icon: Icon,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  options: DeviceOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const known = options.some((o) => o.id === value);
  return (
    <label className="flex items-center gap-2 min-w-0 h-10 px-3 rounded-full border border-line bg-panel text-sm text-muted focus-within:border-accent/60">
      <Icon className="size-4 shrink-0" />
      <span className="sr-only">{label}</span>
      <select
        value={known ? value : ""}
        disabled={disabled || options.length === 0}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-text outline-none truncate disabled:text-muted [&>option]:bg-panel"
      >
        {!known && <option value="">{options.length ? "Varsayılan" : `${label} yok`}</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// Görüşme içindeki düğmenin yanındaki ok ve açılan liste (Meet'teki gibi).
export function DeviceMenu({
  sections,
  label,
  footer,
}: {
  label: string;
  sections: { title: string; options: DeviceOption[]; value: string; onSelect: (id: string) => void }[];
  footer?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={label}
        aria-expanded={open}
        title={label}
        className="h-11 sm:h-12 w-6 sm:w-7 grid place-items-center text-muted hover:text-text"
      >
        <ChevronUp className={`size-4 transition ${open ? "" : "rotate-180"}`} />
      </button>
      {open && (
        <div className="absolute bottom-14 left-1/2 -translate-x-1/2 sm:left-0 sm:translate-x-0 w-[min(20rem,calc(100vw-1.5rem))] max-h-[60vh] overflow-auto rounded-2xl border border-line bg-panel-2 shadow-2xl shadow-black/50 p-1.5 z-30">
          {sections.map((sec) => (
            <div key={sec.title} className="py-1">
              <p className="px-3 pt-1 pb-1.5 text-[11px] uppercase tracking-wide text-muted">{sec.title}</p>
              {sec.options.length === 0 && <p className="px-3 py-2 text-sm text-muted">Cihaz bulunamadı</p>}
              {sec.options.map((o) => {
                const on = o.id === sec.value;
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => {
                      sec.onSelect(o.id);
                      setOpen(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left text-sm hover:bg-white/5 ${on ? "text-accent" : ""}`}
                  >
                    <Check className={`size-4 shrink-0 ${on ? "" : "invisible"}`} />
                    <span className="truncate">{o.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {footer}
        </div>
      )}
    </div>
  );
}
