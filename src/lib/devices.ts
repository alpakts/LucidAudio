// Kamera, mikrofon ve hoparlör: kısıtlar, seçim tercihleri, hata metinleri.

import type { InputMode, NoiseMode } from "./noise";
import type { BlurMode } from "./blur";

// Güçlü modda tarayıcının kendi gürültü engellemesi kapalı: RNNoise ile üst üste binince ses boğuklaşıyor.
// Kapalı modda otomatik ses seviyesi de kapanır (müzik, enstrüman için).
function micConstraints(noise: NoiseMode): MediaTrackConstraints {
  return { echoCancellation: true, noiseSuppression: noise === "standard", autoGainControl: noise !== "off" };
}
const CAM: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };

export type DevicePrefs = {
  mic?: string;
  cam?: string;
  speaker?: string;
  noise?: NoiseMode;
  input?: InputMode;
  gateDb?: number; // ses etkinliği eşiği (dBFS)
  blur?: BlurMode;
};
const PREF_KEY = "pencere:devices";

export function loadDevicePrefs(): DevicePrefs {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}") as DevicePrefs;
  } catch {
    return {};
  }
}

export function saveDevicePrefs(p: DevicePrefs) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {}
}

export function constraintsFor(kind: "audio" | "video", deviceId?: string): MediaTrackConstraints {
  if (kind === "audio") {
    const base = micConstraints(loadDevicePrefs().noise ?? "strong");
    return deviceId ? { ...base, deviceId: { exact: deviceId } } : base;
  }
  return deviceId ? { ...CAM, deviceId: { exact: deviceId } } : { ...CAM, facingMode: "user" };
}

// Seçili cihaz takılı değilse (çıkarılmış kulaklık, başka bilgisayar) varsayılana düş.
export async function acquireTrack(kind: "audio" | "video", deviceId?: string): Promise<MediaStreamTrack> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ [kind]: constraintsFor(kind, deviceId) });
    return kind === "audio" ? s.getAudioTracks()[0] : s.getVideoTracks()[0];
  } catch (e) {
    const name = (e as Error).name;
    if (!deviceId || (name !== "OverconstrainedError" && name !== "NotFoundError")) throw e;
    const s = await navigator.mediaDevices.getUserMedia({ [kind]: constraintsFor(kind) });
    return kind === "audio" ? s.getAudioTracks()[0] : s.getVideoTracks()[0];
  }
}

export function sinkSupported() {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

// Arka kamera aynalanmaz; ön kamera ve masaüstü kameraları aynalanır (Meet gibi).
export function shouldMirror(track: MediaStreamTrack | undefined) {
  return track?.getSettings().facingMode !== "environment";
}

// Instagram, Facebook, TikTok gibi uygulamaların kendi içindeki tarayıcılar çoğu zaman kamera/mikrofon vermez.
export function inAppBrowser(): string | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  if (/Instagram/i.test(ua)) return "Instagram";
  if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua)) return "Facebook";
  if (/musical_ly|BytedanceWebview|TikTok/i.test(ua)) return "TikTok";
  if (/Snapchat/i.test(ua)) return "Snapchat";
  if (/Line\//i.test(ua)) return "LINE";
  if (/Telegram/i.test(ua)) return "Telegram";
  if (/Android.*; wv\)/.test(ua)) return "Bu uygulama";
  // iOS'ta Safari, Chrome (CriOS), Firefox (FxiOS), Edge (EdgiOS) dışındaki gömülü görünüm
  if (/iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)) return "Bu uygulama";
  return null;
}

export function mediaErrorText(e: unknown, what: string) {
  const text = mediaErrorRaw(e, what);
  return text[0].toLocaleUpperCase("tr") + text.slice(1);
}

function mediaErrorRaw(e: unknown, what: string) {
  const name = (e as Error)?.name;
  const ios = typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);
  const android = typeof navigator !== "undefined" && /Android/.test(navigator.userAgent);
  const app = inAppBrowser();
  if (name === "Unsupported" || name === "SecurityError" || name === "TypeError")
    return app
      ? `${app} içindeki tarayıcı ${what} vermiyor. Sağ üstteki menüden "Tarayıcıda aç" / "Chrome'da aç" / "Safari'de aç" seç.`
      : `Bu tarayıcı ${what} desteklemiyor. Chrome ya da Safari ile aç.`;
  if (name === "NotAllowedError")
    return ios
      ? `${what} izni verilmedi. Safari'de adres çubuğundaki "aA" → Web Sitesi Ayarları → Kamera ve Mikrofon: İzin Ver, sonra sayfayı yenile.`
      : android
        ? `${what} izni verilmedi. Adres çubuğunun solundaki simge → İzinler → Kamera ve Mikrofon'u aç, sonra sayfayı yenile. Açıksa telefonun Ayarlar → Uygulamalar → Chrome → İzinler kısmına bak.`
        : `${what} izni verilmedi. Adres çubuğundaki kilit simgesinden izin verip sayfayı yenile.`;
  if (name === "NotFoundError" || name === "OverconstrainedError") return `Bu cihazda ${what} bulunamadı.`;
  if (name === "NotReadableError" || name === "AbortError")
    return `${what} başka bir uygulama kullanıyor (açık bir WhatsApp/Meet araması olabilir). Onu kapatıp tekrar dene.`;
  return `${what} açılamadı: ${(e as Error)?.message ?? e}`;
}

// Mikrofon ve kamerayı tek istemle iste. Bir dokunuşun hemen ardından, araya bekleme girmeden
// çağrılmalı: bazı telefon tarayıcıları dokunuştan kopan istekte izin penceresini göstermiyor.
export async function getLocalMedia(mic: boolean, cam: boolean): Promise<{ stream: MediaStream | null; error: string | null }> {
  if (!mic && !cam) return { stream: null, error: null };
  const what = mic && cam ? "kamera ve mikrofon" : mic ? "mikrofon" : "kamera";
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia)
    return { stream: null, error: mediaErrorText({ name: "Unsupported" }, what) };
  const prefs = loadDevicePrefs();
  const ask = (usePrefs: boolean) =>
    navigator.mediaDevices.getUserMedia({
      audio: mic && constraintsFor("audio", usePrefs ? prefs.mic : undefined),
      video: cam && constraintsFor("video", usePrefs ? prefs.cam : undefined),
    });
  try {
    try {
      return { stream: await ask(true), error: null };
    } catch (e) {
      const name = (e as Error).name;
      if ((prefs.mic || prefs.cam) && (name === "OverconstrainedError" || name === "NotFoundError"))
        return { stream: await ask(false), error: null };
      throw e;
    }
  } catch (e) {
    const name = (e as Error).name;
    // Kamera yok ya da meşgulse en azından sesle katılabilsin.
    if (mic && cam && ["NotFoundError", "NotReadableError", "OverconstrainedError", "AbortError"].includes(name)) {
      try {
        const track = await acquireTrack("audio", prefs.mic);
        return { stream: new MediaStream([track]), error: mediaErrorText(e, "kamera") };
      } catch {}
    }
    return { stream: null, error: mediaErrorText(e, what) };
  }
}
