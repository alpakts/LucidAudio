"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Download, Share } from "lucide-react";

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const noSubscribe = () => () => {};
const standalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
const iosSafari = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && /Safari\//.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);

// "Uygulama olarak yükle": Chrome/Edge/Android tarayıcının kendi istemini açar; iPhone'da yol tarifi verir.
// Zaten uygulama olarak açıldıysa hiçbir şey göstermez.
export function InstallApp() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [iosHelp, setIosHelp] = useState(false);
  const installed = useSyncExternalStore(noSubscribe, standalone, () => true);
  const ios = useSyncExternalStore(noSubscribe, iosSafari, () => false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPrompt);
    };
    const onInstalled = () => setPrompt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed || (!prompt && !ios)) return null;

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={async () => {
          if (prompt) {
            await prompt.prompt();
            await prompt.userChoice.catch(() => {});
            setPrompt(null);
          } else setIosHelp(!iosHelp);
        }}
        className="w-full h-11 rounded-xl bg-panel border border-line text-sm flex items-center justify-center gap-2 hover:border-accent/60 transition"
      >
        <Download className="size-4" />
        Uygulama olarak yükle
      </button>
      {iosHelp && (
        <p className="mt-3 text-xs leading-relaxed text-muted flex gap-2">
          <Share className="size-4 shrink-0 mt-0.5" />
          Safari&apos;de alttaki Paylaş düğmesine dokun, sonra &quot;Ana Ekrana Ekle&quot;yi seç. Pencere ana ekranda kendi
          simgesiyle, tarayıcı çubuğu olmadan açılır.
        </p>
      )}
    </div>
  );
}
