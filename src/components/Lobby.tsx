"use client";

import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { KeyRound, Lock, Mic, MicOff, Smartphone, Video, VideoOff, Volume2 } from "lucide-react";
import { canShareScreen } from "@/lib/room";
import {
  acquireTrack,
  getLocalMedia,
  inAppBrowser,
  loadDevicePrefs,
  saveDevicePrefs,
  shouldMirror,
  sinkSupported,
  type DevicePrefs,
} from "@/lib/devices";
import { StreamVideo } from "./Media";
import { DeviceSelect, LevelBars, useAudioLevel, useDevices, type DeviceKind } from "./Devices";
import { Version } from "@/components/Version";

const NAME_KEY = "pencere:name";
const noSubscribe = () => () => {};

function readName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

async function permissionsGranted() {
  try {
    const q = (name: string) => navigator.permissions.query({ name: name as PermissionName }).then((r) => r.state);
    const [c, m] = await Promise.all([q("camera"), q("microphone")]);
    return c === "granted" && m === "granted";
  } catch {
    return false; // Safari'nin eski sürümleri bu sorguyu desteklemiyor
  }
}

// Meet'teki gibi: önizleme, üstünde mikrofon/kamera düğmeleri, altında cihaz seçimi.
type Gate = { locked: boolean; password: boolean };

async function roomApi(code: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/oda/${code}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export function Lobby({
  code,
  notice,
  onJoin,
}: {
  code: string;
  notice?: string | null;
  onJoin: (name: string, stream: MediaStream | null, micOn: boolean, key: string) => void;
}) {
  const [name, setName] = useState(readName);
  // Oda kilitli mi, şifreli mi: girmeden önce sorulur.
  const [gate, setGate] = useState<Gate | null>(null);
  const [key, setKey] = useState("");
  const [gateError, setGateError] = useState<string | null>(notice ?? null);
  const refreshGate = () =>
    roomApi(code, { t: "info" })
      .then((g: Gate) => setGate(g))
      .catch(() => setGate({ locked: false, password: false }));
  useEffect(() => {
    void refreshGate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefs] = useState<DevicePrefs>(loadDevicePrefs);
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const previewRef = useRef<MediaStream | null>(null);
  const handedOff = useRef(false);

  const share = useSyncExternalStore(noSubscribe, canShareScreen, () => true);
  const app = useSyncExternalStore(noSubscribe, inAppBrowser, () => null);
  const speakers = useSyncExternalStore(noSubscribe, sinkSupported, () => false);
  const devices = useDevices(version);

  const audioTrack = preview?.getAudioTracks()[0];
  const videoTrack = preview?.getVideoTracks()[0];
  const level = useAudioLevel(mic ? audioTrack : null);

  const setStream = (s: MediaStream | null) => {
    previewRef.current = s;
    setPreview(s);
    bump();
  };

  // Daha önce izin verildiyse önizlemeyi kendiliğinden aç; verilmediyse kullanıcı dokunana kadar bekle.
  useEffect(() => {
    let alive = true;
    void permissionsGranted().then(async (ok) => {
      if (!ok || !alive || previewRef.current) return;
      const res = await getLocalMedia(true, true);
      if (!alive) {
        for (const t of res.stream?.getTracks() ?? []) t.stop();
        return;
      }
      setStream(res.stream);
      setError(res.error);
    });
    return () => {
      alive = false;
      if (!handedOff.current) for (const t of previewRef.current?.getTracks() ?? []) t.stop();
    };
  }, []);

  const askPermission = async () => {
    for (const t of previewRef.current?.getTracks() ?? []) t.stop();
    setError(null);
    setBusy(true);
    // Mikrofon kapalı girilse bile izni şimdi al, parça susturulmuş bekler (Meet gibi).
    const res = await getLocalMedia(true, cam);
    for (const t of res.stream?.getAudioTracks() ?? []) t.enabled = mic;
    setBusy(false);
    setStream(res.stream);
    setError(res.error);
    return res;
  };

  const ensureStream = () => {
    if (!previewRef.current) setStream(new MediaStream());
    return previewRef.current!;
  };

  const toggleMic = async () => {
    const next = !mic;
    setMic(next);
    const live = previewRef.current?.getAudioTracks()[0];
    if (live) live.enabled = next;
    else if (next && previewRef.current) {
      try {
        const t = await acquireTrack("audio", prefs.mic);
        ensureStream().addTrack(t);
        bump();
      } catch {}
    }
  };

  const toggleCam = async () => {
    const next = !cam;
    setCam(next);
    const s = previewRef.current;
    const live = s?.getVideoTracks()[0];
    if (!next && s && live) {
      live.stop();
      s.removeTrack(live);
      bump();
    } else if (next && s) {
      try {
        const t = await acquireTrack("video", prefs.cam);
        ensureStream().addTrack(t);
        bump();
      } catch {}
    }
  };

  const pick = async (kind: DeviceKind, id: string) => {
    const p = { ...prefs, [kind]: id };
    setPrefs(p);
    saveDevicePrefs(p);
    const s = previewRef.current;
    if (kind === "speaker" || !s) return;
    const old = kind === "mic" ? s.getAudioTracks()[0] : s.getVideoTracks()[0];
    if (!old) return;
    old.stop();
    s.removeTrack(old);
    try {
      const t = await acquireTrack(kind === "mic" ? "audio" : "video", id);
      if (kind === "mic") t.enabled = mic;
      s.addTrack(t);
    } catch {}
    bump();
  };

  const join = async () => {
    const finalName = name.trim() || "Misafir";
    try {
      localStorage.setItem(NAME_KEY, finalName);
    } catch {}
    let stream = previewRef.current;
    // İzin henüz istenmediyse şimdi iste: Katıl'a dokunuşun hemen ardından (başka beklemeden önce).
    if (!stream && (mic || cam)) {
      const res = await askPermission();
      if (res.error) return;
      stream = res.stream;
    }
    setGateError(null);
    const g: Gate = await roomApi(code, { t: "info" }).catch(() => gate ?? { locked: false, password: false });
    setGate(g);
    if (g.locked) {
      setGateError("Oda kilitli: içeriden biri kilidi açana kadar yeni kimse giremiyor.");
      return;
    }
    if (g.password) {
      const ok = key && (await roomApi(code, { t: "check", key }).then((r: { ok: boolean }) => r.ok).catch(() => false));
      if (!ok) {
        setGateError(key ? "Şifre yanlış." : "Bu oda şifreli, şifreyi yaz.");
        return;
      }
    }
    handedOff.current = true;
    onJoin(finalName, stream, mic, key);
  };

  const current = (kind: "mic" | "cam") => {
    const t = kind === "mic" ? audioTrack : videoTrack;
    return t?.getSettings().deviceId ?? prefs[kind] ?? "";
  };

  return (
    <main className="relative min-h-full flex items-center justify-center px-4 pt-8 pb-12 sm:py-12">
      <div className="w-full max-w-5xl grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] items-center">
        <section>
          <div className="relative aspect-[4/5] max-h-[60dvh] w-full sm:aspect-video sm:max-h-none rounded-3xl overflow-hidden bg-panel border border-line">
            {videoTrack && cam ? (
              <StreamVideo
                key={videoTrack.id}
                stream={preview}
                muted
                mirror={shouldMirror(videoTrack)}
                className="absolute inset-0 size-full"
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center p-6 pb-24 text-center">
                {preview || !cam ? (
                  <p className="text-muted">Kamera kapalı</p>
                ) : (
                  <div>
                    <p className="text-muted text-sm mb-4">Kendini görmek için kamera ve mikrofon izni ver.</p>
                    <button
                      type="button"
                      onClick={askPermission}
                      disabled={busy}
                      className="h-10 px-4 rounded-full bg-accent text-accent-ink text-sm font-medium disabled:opacity-60"
                    >
                      {busy ? "İzin bekleniyor…" : "İzin ver"}
                    </button>
                  </div>
                )}
              </div>
            )}
            {name.trim() && (
              <span className="absolute left-4 top-3 text-sm drop-shadow-[0_1px_2px_rgba(0,0,0,.8)]">{name.trim()}</span>
            )}
            <div className="absolute inset-x-0 bottom-4 flex justify-center gap-3">
              <PreviewButton on={mic} onClick={toggleMic} label={mic ? "Mikrofonu kapat" : "Mikrofonu aç"}>
                {mic ? <Mic className="size-5" /> : <MicOff className="size-5" />}
              </PreviewButton>
              <PreviewButton on={cam} onClick={toggleCam} label={cam ? "Kamerayı kapat" : "Kamerayı aç"}>
                {cam ? <Video className="size-5" /> : <VideoOff className="size-5" />}
              </PreviewButton>
            </div>
            {mic && audioTrack && <LevelBars level={level} className="absolute right-4 bottom-6" />}
          </div>

          {devices.labeled && (
            <div className={`grid gap-2 mt-3 ${speakers ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
              <DeviceSelect label="Mikrofon" icon={Mic} options={devices.mic} value={current("mic")} onChange={(id) => pick("mic", id)} />
              {speakers && (
                <DeviceSelect
                  label="Hoparlör"
                  icon={Volume2}
                  options={devices.speaker}
                  value={prefs.speaker ?? ""}
                  onChange={(id) => pick("speaker", id)}
                />
              )}
              <DeviceSelect label="Kamera" icon={Video} options={devices.cam} value={current("cam")} onChange={(id) => pick("cam", id)} />
            </div>
          )}
        </section>

        <form
          className="w-full max-w-sm mx-auto lg:mx-0"
          onSubmit={(e) => {
            e.preventDefault();
            void join();
          }}
        >
          <h1 className="text-2xl font-semibold tracking-tight">Katılmaya hazır mısın?</h1>
          <p className="text-sm text-muted mt-1 mb-6">
            Oda <span className="font-mono text-text">{code}</span>
          </p>

          <label className="block text-sm text-muted mb-2" htmlFor="name">
            Adın
          </label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="Alper"
            className="w-full h-12 rounded-xl bg-panel border border-line px-4 outline-none focus:border-accent/60 placeholder:text-muted/60"
          />

          {gate?.password && (
            <>
              <label className="flex items-center gap-2 text-sm text-muted mb-2 mt-4" htmlFor="key">
                <KeyRound className="size-4" /> Oda şifresi
              </label>
              <input
                id="key"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                maxLength={100}
                autoComplete="off"
                className="w-full h-12 rounded-xl bg-panel border border-line px-4 outline-none focus:border-accent/60"
              />
            </>
          )}

          <button
            disabled={busy}
            className="w-full h-12 mt-4 rounded-full bg-accent text-accent-ink font-medium hover:brightness-110 disabled:opacity-60 transition"
          >
            {busy ? "İzin bekleniyor…" : "Katıl"}
          </button>

          {(gateError || gate?.locked) && (
            <div role="alert" className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100 flex gap-2">
              <Lock className="size-4 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p>{gateError ?? "Oda kilitli: içeriden biri kilidi açana kadar yeni kimse giremiyor."}</p>
                {gate?.locked && (
                  <button type="button" onClick={() => void refreshGate()} className="mt-2 text-xs underline underline-offset-2">
                    Tekrar kontrol et
                  </button>
                )}
              </div>
            </div>
          )}

          {error && (
            <div role="alert" className="mt-4 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-red-200">
              <p className="leading-relaxed">{error}</p>
              <p className="mt-2 text-xs text-red-200/80">
                {audioTrack ? "Katıl dersen sadece sesle girersin." : "Katıl dersen kamerasız ve mikrofonsuz girersin."}
              </p>
              <button
                type="button"
                onClick={askPermission}
                className="mt-3 h-9 px-3 rounded-lg bg-panel-2 border border-line text-xs text-text"
              >
                Tekrar dene
              </button>
            </div>
          )}

          {app && !error && (
            <p className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 text-amber-200 text-xs leading-relaxed p-3">
              {app} içindeki tarayıcıdasın. Kamera ve mikrofon burada çalışmayabilir; sorun olursa sağ üstteki menüden
              &quot;Tarayıcıda aç&quot; seç.
            </p>
          )}

          {!share && (
            <p className="mt-6 flex gap-2 text-xs leading-relaxed text-muted">
              <Smartphone className="size-4 shrink-0 mt-0.5" />
              Bu tarayıcı ekran paylaşamıyor (telefon tarayıcıları desteklemiyor). Katılıp izleyebilir, kamerayla
              konuşabilirsin.
            </p>
          )}
        </form>
      </div>
      <Version />
    </main>
  );
}

function PreviewButton({
  on,
  onClick,
  label,
  children,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`size-12 rounded-full grid place-items-center border transition ${
        on ? "bg-black/40 border-white/30 backdrop-blur hover:bg-black/55" : "bg-danger border-danger text-white"
      }`}
    >
      {children}
    </button>
  );
}
