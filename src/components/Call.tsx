"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Activity,
  Check,
  Eraser,
  HeadphoneOff,
  Headphones,
  Eye,
  EyeOff,
  Link2,
  KeyRound,
  Lock,
  LockOpen,
  Maximize,
  MessageSquare,
  MonitorPlay,
  Minimize,
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  Pencil,
  PhoneOff,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { canShareScreen, Room, type PeerStats, type RemoteView, type ShareMode, type TrackStats } from "@/lib/room";
import { sinkSupported } from "@/lib/devices";
import type { InputMode, NoiseMode } from "@/lib/noise";
import type { BlurMode } from "@/lib/blur";
import { StreamVideo } from "./Media";
import { Lobby } from "./Lobby";
import { ChatPanel } from "./Chat";
import { YouTubeStage } from "./YouTube";
import { YouTubePicker } from "./YouTubePicker";
import { InkLayer, openInkWindow, SelfInkWindow } from "./Ink";
import type { Ink } from "@/lib/ink";
import { DeviceMenu, useDevices } from "./Devices";

export function Call({ code }: { code: string }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [left, setLeft] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => () => room?.leave(), [room]);

  if (left)
    return (
      <Centered>
        <p className="text-lg font-medium">Görüşmeden çıktın</p>
        <div className="flex gap-2 mt-5">
          <button onClick={() => setLeft(false)} className="h-11 px-5 rounded-xl bg-accent text-accent-ink font-medium">
            Tekrar katıl
          </button>
          <Link href="/" className="h-11 px-5 rounded-xl bg-panel-2 border border-line grid place-items-center">
            Ana sayfa
          </Link>
        </div>
      </Centered>
    );

  if (!room)
    return (
      <Lobby
        code={code}
        notice={notice}
        onJoin={(name, stream, micOn, key) => {
          setNotice(null);
          const r = new Room(code, name, key);
          setRoom(r);
          void r.join(stream, micOn);
        }}
      />
    );

  return (
    <InCall
      room={room}
      onLeave={() => {
        room.leave();
        setRoom(null);
        setLeft(true);
      }}
      onDenied={(reason) => {
        setRoom(null);
        setNotice(reason === "sifre" ? "Şifre yanlış ya da değiştirildi." : "Oda kilitlendi, şu an yeni kimse giremiyor.");
      }}
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="min-h-full flex flex-col items-center justify-center px-4 py-12 text-center">{children}</main>;
}

// ---------- görüşme ----------

// stream yalnızca İzle'ye basıldıysa ve görüntü geldiyse dolu.
type ScreenSource = {
  key: string;
  name: string;
  stream: MediaStream | null;
  watching: boolean;
  peer: RemoteView | null; // kendi yayınında null
  self?: boolean;
  yt?: boolean; // birlikte izlenen YouTube
};

function InCall({
  room,
  onLeave,
  onDenied,
}: {
  room: Room;
  onLeave: () => void;
  onDenied: (reason: "sifre" | "kilitli") => void;
}) {
  useSyncExternalStore(room.subscribe, room.getVersion, room.getVersion);
  const denied = room.denied;
  useEffect(() => {
    if (denied) onDenied(denied);
  }, [denied, onDenied]);
  const remotes = room.remoteViews();
  const [showStats, setShowStats] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [ytOpen, setYtOpen] = useState(false);
  // Çizim önizlemesi: PiP penceresi, sayfa içi panel ("panel") ya da kapalı (null).
  const [inkWin, setInkWin] = useState<Window | "panel" | null>(null);
  // Paylaşım bitince PiP penceresi kapanır; kapanmış pencere kapalı sayılır.
  const inkOpen = inkWin !== null && !(inkWin !== "panel" && inkWin.closed);
  const ptt = room.inputMode === "ptt" && room.gateActive;

  // Bas-konuş: Boşluk tuşu (yazı alanındayken değil).
  useEffect(() => {
    if (!ptt) return;
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e.target)) return;
      e.preventDefault();
      if (!e.repeat) room.setPtt(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      room.setPtt(false);
    };
    const release = () => room.setPtt(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      room.setPtt(false);
    };
  }, [ptt, room]);
  const [pinned, setPinned] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const share = useMemo(() => canShareScreen(), []);
  const speakers = useMemo(() => sinkSupported(), []);
  const devices = useDevices(`${room.state.mic}${room.state.cam}`);
  const speaker = room.devices.speaker;

  const screens: ScreenSource[] = remotes
    .filter((r) => r.sharing)
    .map((r) => ({
      key: r.id,
      name: r.state.name,
      stream: r.screen && r.screen.getVideoTracks().length > 0 ? r.screen : null,
      watching: r.watching,
      peer: r as RemoteView | null,
    }));
  const sharing = !!room.screenStream;
  // Discord gibi: paylaşan kendi yayınını da görür (sessiz; üstüne çizim yapılabilir).
  // Başkasının yayını varsa varsayılan olarak o öne çıkar.
  if (room.screenStream)
    screens.push({ key: room.me, name: "Sen", stream: room.screenStream, watching: true, peer: null, self: true });
  // Birlikte izlenen YouTube sahnede en önde.
  if (room.party.state) screens.unshift({ key: "yt", name: "YouTube", stream: null, watching: true, peer: null, yt: true });
  const active = screens.find((s) => s.key === pinned) ?? screens[0] ?? null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  // Alt çubuktaki düğmeler; tam ekranda da aynısı görünür.
  const controls = (
    <>
        <SplitControl
          active={room.state.mic}
          onClick={() => void room.setMic(!room.state.mic)}
          label={room.state.mic ? "Mikrofonu kapat" : "Mikrofonu aç"}
          menu={
            <DeviceMenu
              label="Ses ayarları"
              footer={room.inputMode === "gate" && room.gateActive ? <GateSlider room={room} /> : undefined}
              sections={[
                {
                  title: "Mikrofon",
                  options: devices.mic,
                  value: room.currentDevice("mic"),
                  onSelect: (id) => void room.selectDevice("mic", id),
                },
                {
                  title: room.noiseMode === "strong" && !room.noiseActive && room.state.mic
                    ? "Gürültü engelleme (Lucid bu tarayıcıda çalışmadı)"
                    : "Gürültü engelleme",
                  options: [
                    { id: "strong", label: "Lucid: AI destekli gürültü engelleme" },
                    { id: "standard", label: "Standart: tarayıcının kendi" },
                    { id: "off", label: "Kapalı: müzik, enstrüman" },
                  ],
                  value: room.noiseMode,
                  onSelect: (id: string) => void room.setNoise(id as NoiseMode),
                },
                {
                  title: room.inputMode !== "always" && !room.gateActive && room.state.mic
                    ? "Giriş modu (bu tarayıcıda çalışmadı, mikrofon hep açık)"
                    : "Giriş modu",
                  options: [
                    { id: "always", label: "Her zaman açık" },
                    { id: "gate", label: "Ses etkinliği: sadece konuşunca" },
                    { id: "ptt", label: "Bas-konuş: Boşluk tuşu" },
                  ],
                  value: room.inputMode,
                  onSelect: (id: string) => void room.setInputMode(id as InputMode),
                },
                {
                  title: "Bildirim sesleri",
                  options: [
                    { id: "on", label: "Biri girince/çıkınca ses çal" },
                    { id: "off", label: "Sessiz" },
                  ],
                  value: room.soundsOn ? "on" : "off",
                  onSelect: (id: string) => room.setSounds(id === "on"),
                },
                ...(speakers
                  ? [
                      {
                        title: "Hoparlör",
                        options: devices.speaker,
                        value: room.currentDevice("speaker"),
                        onSelect: (id: string) => void room.selectDevice("speaker", id),
                      },
                    ]
                  : []),
              ]}
            />
          }
        >
          {room.state.mic ? <Mic className="size-5" /> : <MicOff className="size-5" />}
        </SplitControl>
        <RoundButton
          active={!room.deafened}
          onClick={() => void room.setDeafen(!room.deafened)}
          label={room.deafened ? "Sesi aç" : "Sesi kapat (kimseyi duyma)"}
        >
          {room.deafened ? <HeadphoneOff className="size-5" /> : <Headphones className="size-5" />}
        </RoundButton>
        <SplitControl
          active={room.state.cam}
          onClick={() => void room.setCam(!room.state.cam)}
          label={room.state.cam ? "Kamerayı kapat" : "Kamerayı aç"}
          menu={
            <DeviceMenu
              label="Kamera ayarları"
              sections={[
                {
                  title: "Kamera",
                  options: devices.cam,
                  value: room.currentDevice("cam"),
                  onSelect: (id) => void room.selectDevice("cam", id),
                },
                {
                  title: "Arka plan",
                  options: [
                    { id: "off", label: "Bulanıklaştırma kapalı" },
                    { id: "light", label: "Hafif bulanık" },
                    { id: "strong", label: "Güçlü bulanık" },
                  ],
                  value: room.blurMode,
                  onSelect: (id: string) => void room.setBlur(id as BlurMode),
                },
              ]}
            />
          }
        >
          {room.state.cam ? <Video className="size-5" /> : <VideoOff className="size-5" />}
        </SplitControl>
        {share && (
          <RoundButton
            active={!sharing}
            highlight={sharing}
            onClick={() => (sharing ? room.stopScreen() : void room.startScreen(room.screenMode))}
            label={sharing ? "Paylaşımı durdur" : "Ekranı paylaş"}
          >
            {sharing ? <MonitorX className="size-5" /> : <MonitorUp className="size-5" />}
          </RoundButton>
        )}
        <div className="relative">
          <RoundButton
            active={!chatOpen}
            highlight={chatOpen}
            onClick={() => {
              setChatOpen(!chatOpen);
              setYtOpen(false);
            }}
            label="Sohbet"
          >
            <MessageSquare className="size-5" />
          </RoundButton>
          {room.unread > 0 && !chatOpen && (
            <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-accent text-accent-ink text-[11px] font-semibold grid place-items-center pointer-events-none">
              {room.unread > 9 ? "9+" : room.unread}
            </span>
          )}
        </div>
        <button
          onClick={() => {
            setYtOpen(!ytOpen);
            setChatOpen(false);
          }}
          aria-label="Birlikte izle"
          title="YouTube'u birlikte izle"
          className={`size-11 sm:size-12 rounded-full grid place-items-center transition ${
            ytOpen || room.party.state ? "bg-red-600 text-white" : "bg-panel-2 border border-line hover:border-muted/50"
          }`}
        >
          <MonitorPlay className="size-5" />
        </button>
        <button
          onClick={onLeave}
          aria-label="Ayrıl"
          title="Ayrıl"
          className="h-11 sm:h-12 px-4 sm:px-5 rounded-full bg-danger text-white flex items-center gap-2 font-medium hover:brightness-110 transition"
        >
          <PhoneOff className="size-5" />
          <span className="hidden sm:inline">Ayrıl</span>
        </button>
    </>
  );

  // Tam ekran (odak) görünümü: tek görüntü ekranı kaplar, dokununca kontroller çıkar.
  const [focus, setFocus] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFocus(null);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const enterFocus = (key: string) => {
    setFocus(key);
    // iPhone Safari öğe tam ekranını desteklemiyor; orada görünüm yine ekranı kaplar, sadece tarayıcı çubuğu kalır.
    void rootRef.current?.requestFullscreen?.().catch(() => {});
  };
  const exitFocus = () => {
    setFocus(null);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  };
  const focused = resolveFocus(focus, room, remotes, screens);
  const closeInk = useCallback(() => setInkWin(null), []);

  // İki kişide WhatsApp düzeni: karşı taraf büyük, kendi kameran köşede küçük; dokununca yer değişir.
  const one = !active && remotes.length === 1 ? remotes[0] : null;
  const { areaRef: pipArea, swapped, pipClass, pipProps } = usePip();

  const tiles = (
    <>
      <CamTile
        name={`${room.state.name} (sen)`}
        stream={room.camStream}
        cam={room.state.cam}
        mic={room.state.mic}
        self
        mirror={room.selfMirror}
        videoKey={room.camStream.getVideoTracks()[0]?.id}
        onFocus={() => enterFocus("cam:self")}
        speaking={room.speaking.has("self")}
        deaf={room.deafened}
      />
      {remotes.map((r) => (
        <CamTile
          key={r.id}
          name={r.state.name}
          stream={r.cam}
          cam={r.state.cam}
          mic={r.state.mic}
          conn={r.conn}
          stats={showStats ? r.stats : null}
          trackId={r.cam?.getVideoTracks()[0]?.id}
          sinkId={speaker}
          onFocus={() => enterFocus(`cam:${r.id}`)}
          speaking={room.speaking.has(r.id)}
          deaf={!!r.state.deaf}
          silenced={room.deafened}
        />
      ))}
    </>
  );

  return (
    <div ref={rootRef} className="h-dvh flex flex-col bg-bg">
      {focused && <FocusView key={focus} {...focused} ink={room.ink} controls={controls} onExit={exitFocus} />}
      {chatOpen && <ChatPanel room={room} onClose={() => setChatOpen(false)} />}
      {ytOpen && <YouTubePicker room={room} onClose={() => setYtOpen(false)} />}
      {ptt && room.state.mic && (
        <button
          onPointerDown={(e) => {
            room.setPtt(true);
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {}
          }}
          onPointerUp={() => room.setPtt(false)}
          onPointerCancel={() => room.setPtt(false)}
          onContextMenu={(e) => e.preventDefault()}
          className={`fixed z-30 left-1/2 -translate-x-1/2 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] h-12 px-6 rounded-full border text-sm font-medium select-none touch-none transition ${
            room.pttHeld
              ? "bg-[#23a55a] border-[#23a55a] text-white shadow-[0_0_24px_rgba(35,165,90,0.6)]"
              : "bg-panel-2/95 border-line backdrop-blur"
          }`}
        >
          {room.pttHeld ? "Konuşuyorsun" : "Basılı tut, konuş (Boşluk)"}
        </button>
      )}
      <header className="h-14 shrink-0 px-4 flex items-center gap-3 border-b border-line">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          Pencere
        </Link>
        <span className="text-muted">/</span>
        <span className="font-mono text-sm truncate">{room.code}</span>
        <span className="text-xs text-muted ml-1 shrink-0">{remotes.length + 1} kişi</span>
        <div className="ml-auto" />
        <button
          onClick={() => setShowStats(!showStats)}
          aria-label="Bağlantı bilgisi"
          title="Bağlantı bilgisi: çözünürlük, fps, hız"
          className={`h-9 w-9 shrink-0 rounded-lg border grid place-items-center ${
            showStats ? "bg-accent/15 border-accent/40 text-accent" : "bg-panel-2 border-line"
          }`}
        >
          <Activity className="size-4" />
        </button>
        <RoomLock room={room} />
        <button
          onClick={copy}
          className="h-9 px-3 rounded-lg bg-panel-2 border border-line text-sm flex items-center gap-2 shrink-0"
        >
          {copied ? <Check className="size-4 text-accent" /> : <Link2 className="size-4" />}
          <span className="hidden sm:inline">{copied ? "Kopyalandı" : "Linki kopyala"}</span>
        </button>
      </header>

      {room.netError && (
        <div className="px-4 py-2 text-sm bg-danger/10 text-red-300 border-b border-danger/20">{room.netError}</div>
      )}
      {room.mediaError && (
        <div className="px-4 py-2 text-sm bg-danger/10 text-red-300 border-b border-danger/20 flex items-center gap-3">
          <span className="flex-1">{room.mediaError}</span>
          <button onClick={() => room.dismissMediaError()} aria-label="Kapat" className="shrink-0 opacity-80 hover:opacity-100">
            <X className="size-4" />
          </button>
        </div>
      )}

      {sharing && (
        <SharingBar
          room={room}
          showStats={showStats}
          stats={remotes.map((r) => ({ name: r.state.name, s: r.stats }))}
          inkOpen={inkOpen}
          onInk={() => {
            if (inkOpen && inkWin) {
              if (inkWin !== "panel") inkWin.close();
              setInkWin(null);
              return;
            }
            // Tıklamanın içinde aç: Chrome başka türlü pencereyi engeller.
            void openInkWindow(closeInk).then((w) => setInkWin(w ?? "panel"));
          }}
        />
      )}
      {sharing && inkOpen && room.screenStream && (
        <SelfInkWindow
          ink={room.ink}
          owner={room.me}
          stream={room.screenStream}
          win={inkWin === "panel" ? null : inkWin}
          onClose={closeInk}
        />
      )}

      <main className="flex-1 min-h-0 p-2 sm:p-3">
        {active ? (
          <div className="h-full flex flex-col lg:flex-row gap-2 sm:gap-3">
            <div className="flex-1 min-h-0 min-w-0 flex flex-col gap-2">
              {screens.length > 1 && (
                <div className="flex gap-1.5 overflow-x-auto">
                  {screens.map((s) => (
                    <button
                      key={s.key}
                      onClick={() => setPinned(s.key)}
                      className={`h-8 px-3 rounded-lg text-xs border shrink-0 ${
                        s.key === active.key ? "bg-accent/15 border-accent/40 text-accent" : "bg-panel border-line"
                      }`}
                    >
                      {s.yt ? "YouTube" : s.self ? "Senin yayının" : `${s.name} ekranı${s.watching ? "" : " · izlemiyorsun"}`}
                    </button>
                  ))}
                </div>
              )}
              <div className="relative flex-1 min-h-0">
                {/* Seçili olmayan ekranlar da DOM'da kalır ki sesleri kesilmesin. */}
                {screens.map((s) =>
                  s.yt ? (
                    <YouTubeStage
                      key="yt"
                      party={room.party}
                      hidden={s.key !== active.key}
                      silenced={room.deafened}
                      onStop={() => room.party.stop()}
                    />
                  ) : s.watching && s.stream ? (
                    <ScreenStage
                      key={s.key}
                      source={{ ...s, stream: s.stream }}
                      hidden={s.key !== active.key}
                      stats={showStats && s.peer ? s.peer.stats : null}
                      sinkId={speaker}
                      onFocus={() => enterFocus(`screen:${s.key}`)}
                      onStopWatching={s.self ? undefined : () => room.watch(s.key, false)}
                      silenced={room.deafened}
                      ink={room.ink}
                    />
                  ) : (
                    <ScreenInvite
                      key={s.key}
                      name={s.name}
                      waiting={s.watching}
                      hidden={s.key !== active.key}
                      onWatch={() => room.watch(s.key, true)}
                      onCancel={() => room.watch(s.key, false)}
                    />
                  ),
                )}
              </div>
            </div>
            <div className="shrink-0 flex lg:flex-col gap-2 overflow-auto lg:w-64 h-28 sm:h-36 lg:h-auto [&>*]:shrink-0 [&>*]:aspect-video [&>*]:h-full lg:[&>*]:h-auto lg:[&>*]:w-full">
              {tiles}
            </div>
          </div>
        ) : one ? (
          <div ref={pipArea} className="relative h-full">
            {/* İki kutu hep aynı sırada çizilir, yer değişince sadece sınıfları değişir:
                video öğesi yeniden kurulmaz, ses kesilmez. */}
            <CamTile
              key="self"
              name={`${room.state.name} (sen)`}
              stream={room.camStream}
              cam={room.state.cam}
              mic={room.state.mic}
              self
              mirror={room.selfMirror}
              videoKey={room.camStream.getVideoTracks()[0]?.id}
              onFocus={() => enterFocus("cam:self")}
              speaking={room.speaking.has("self")}
        deaf={room.deafened}
              variant={swapped ? "main" : "pip"}
              className={swapped ? "inset-0" : pipClass}
              boxProps={swapped ? undefined : pipProps}
            />
            <CamTile
              key={one.id}
              name={one.state.name}
              stream={one.cam}
              cam={one.state.cam}
              mic={one.state.mic}
              conn={one.conn}
              stats={showStats ? one.stats : null}
              trackId={one.cam?.getVideoTracks()[0]?.id}
              sinkId={speaker}
              onFocus={() => enterFocus(`cam:${one.id}`)}
              speaking={room.speaking.has(one.id)}
              deaf={!!one.state.deaf}
              silenced={room.deafened}
              variant={swapped ? "pip" : "main"}
              className={swapped ? pipClass : "inset-0"}
              boxProps={swapped ? pipProps : undefined}
            />
          </div>
        ) : (
          <div className={`h-full grid gap-2 sm:gap-3 ${gridFor(remotes.length + 1)}`}>
            {tiles}
            {remotes.length === 0 && <EmptyHint onCopy={copy} copied={copied} />}
          </div>
        )}
      </main>

      <footer className="shrink-0 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex items-center justify-center gap-1.5 sm:gap-2">
        {controls}
      </footer>
    </div>
  );
}

function gridFor(n: number) {
  if (n <= 1) return "grid-cols-1 sm:grid-cols-2";
  if (n === 2) return "grid-cols-1 grid-rows-2 sm:grid-cols-2 sm:grid-rows-1";
  return "grid-cols-2 grid-rows-2";
}

function EmptyHint({ onCopy, copied }: { onCopy: () => void; copied: boolean }) {
  return (
    <div className="rounded-2xl border border-dashed border-line flex flex-col items-center justify-center text-center p-6 gap-3">
      <p className="text-muted text-sm">Odada şimdilik sadece sen varsın.</p>
      <button onClick={onCopy} className="h-10 px-4 rounded-xl bg-accent text-accent-ink text-sm font-medium flex items-center gap-2">
        {copied ? <Check className="size-4" /> : <Link2 className="size-4" />}
        {copied ? "Kopyalandı" : "Davet linkini kopyala"}
      </button>
    </div>
  );
}

function RoundButton({
  active,
  highlight = false,
  onClick,
  label,
  children,
}: {
  active: boolean;
  highlight?: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  const cls = highlight
    ? "bg-accent text-accent-ink"
    : active
      ? "bg-panel-2 border border-line hover:border-muted/50"
      : "bg-danger/15 border border-danger/30 text-red-300";
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`size-11 sm:size-12 rounded-full grid place-items-center transition ${cls}`}
    >
      {children}
    </button>
  );
}

// Meet'teki gibi: solda cihaz menüsünü açan ok, sağda aç/kapa düğmesi.
function SplitControl({
  active,
  onClick,
  label,
  menu,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  menu: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex items-center rounded-full pl-0.5 border transition ${
        active ? "bg-panel-2 border-line" : "bg-danger/15 border-danger/30 text-red-300"
      }`}
    >
      {menu}
      <button
        onClick={onClick}
        aria-label={label}
        title={label}
        className={`size-11 sm:size-12 -my-px -mr-px rounded-full grid place-items-center transition ${
          active ? "bg-white/5 hover:bg-white/10" : "bg-danger text-white"
        }`}
      >
        {children}
      </button>
    </div>
  );
}

// ---------- kutular ----------

// Discord'daki konuşuyor ışığı.
const SPEAK_RING = "shadow-[0_0_0_2px_#23a55a,0_0_18px_rgba(35,165,90,0.45)] border-transparent";
const SPEAK_AVATAR = "shadow-[0_0_0_3px_#23a55a,0_0_16px_rgba(35,165,90,0.5)]";

function CamTile({
  name,
  stream,
  cam,
  mic,
  self = false,
  mirror = false,
  videoKey,
  conn,
  stats,
  trackId,
  sinkId,
  onFocus,
  variant = "grid",
  className = "",
  boxProps,
  speaking = false,
  deaf = false,
  silenced = false,
}: {
  name: string;
  stream: MediaStream | null;
  cam: boolean;
  mic: boolean;
  self?: boolean;
  mirror?: boolean;
  videoKey?: string;
  sinkId?: string;
  onFocus: () => void;
  conn?: RTCPeerConnectionState;
  stats?: PeerStats | null;
  trackId?: string;
  variant?: "grid" | "main" | "pip";
  speaking?: boolean;
  deaf?: boolean; // bu kişi sesi kapattı (kimseyi duymuyor)
  silenced?: boolean; // ben sesi kapattım: bu kutunun sesi çalmasın
  className?: string;
  boxProps?: React.HTMLAttributes<HTMLDivElement>;
}) {
  const pip = variant === "pip";
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const connecting = conn && conn !== "connected";
  const t = trackId ? stats?.inbound[trackId] : undefined;

  return (
    <div
      ref={box}
      onDoubleClick={pip ? undefined : onFocus}
      {...boxProps}
      // Izgarada kendi yerinde (relative); büyük ve küçük pencerede konumu üst düzen verir (absolute).
      className={`group overflow-hidden min-h-0 ${variant === "grid" ? "relative" : "absolute"} ${
        pip
          ? "rounded-xl border border-white/20 bg-panel-2 shadow-xl shadow-black/50"
          : variant === "main"
            ? "rounded-2xl bg-black border border-line"
            : "rounded-2xl bg-panel border border-line"
      } ${speaking ? SPEAK_RING : ""} transition-shadow duration-150 ${className}`}
    >
      <StreamVideo
        key={videoKey}
        stream={stream}
        muted={self || silenced}
        mirror={self && mirror}
        sinkId={sinkId}
        videoRef={video}
        // Büyük görüntü telefonda ekranı doldurur, geniş ekranda kırpılmasın diye sığdırılır.
        fit={variant === "main" ? "responsive" : "cover"}
        className={`absolute inset-0 size-full pointer-events-none ${cam ? "" : "opacity-0"}`}
      />
      {!cam && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <div
            className={`rounded-full bg-panel-2 border border-line grid place-items-center font-medium text-muted transition-shadow duration-150 ${
              pip ? "size-10 text-base" : "size-16 text-2xl"
            } ${speaking ? SPEAK_AVATAR : ""}`}
          >
            {(name.trim()[0] ?? "?").toLocaleUpperCase("tr")}
          </div>
        </div>
      )}
      {pip ? (
        (deaf || !mic) && (
          <div className="absolute left-1.5 bottom-1.5 h-6 px-1.5 rounded-full bg-black/60 flex items-center gap-1 pointer-events-none">
            {deaf && <HeadphoneOff className="size-3.5 text-red-300" />}
            {!mic && <MicOff className="size-3.5 text-red-300" />}
          </div>
        )
      ) : (
        <div className="absolute left-2 bottom-2 max-w-[calc(100%-1rem)] h-7 px-2.5 rounded-lg bg-black/60 backdrop-blur text-xs flex items-center gap-1.5 pointer-events-none">
          {deaf ? (
            <HeadphoneOff className="size-3.5 text-red-300 shrink-0" />
          ) : (
            !mic && <MicOff className="size-3.5 text-red-300 shrink-0" />
          )}
          <span className="truncate">{name}</span>
          {deaf && <span className="text-red-300 shrink-0">· duymuyor</span>}
          {connecting && <span className="text-muted shrink-0">· {connLabel(conn)}</span>}
        </div>
      )}
      {!pip && (
      <button
        onClick={onFocus}
        aria-label="Tam ekran"
        title="Tam ekran"
        className="absolute right-2 bottom-2 size-8 rounded-lg bg-black/60 backdrop-blur grid place-items-center opacity-0 group-hover:opacity-90 focus-visible:opacity-90 [@media(hover:none)]:opacity-80 transition"
      >
        <Maximize className="size-4" />
      </button>
      )}
      {stats && !pip && (
        <StatsBadge
          className="absolute right-2 top-2"
          lines={[t ? fmtTrack(t) : null, routeLine(stats)].filter(Boolean) as string[]}
        />
      )}
    </div>
  );
}

function ScreenStage({
  source,
  hidden,
  stats,
  sinkId,
  onFocus,
  onStopWatching,
  ink,
  silenced = false,
}: {
  source: ScreenSource & { stream: MediaStream };
  silenced?: boolean;
  hidden: boolean;
  stats: PeerStats | null;
  sinkId?: string;
  onFocus: () => void;
  onStopWatching?: () => void;
  ink: Ink;
}) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [drawing, setDrawing] = useState(false);
  const t = stats?.inbound[source.stream.getVideoTracks()[0]?.id ?? ""];

  return (
    <div ref={box} className={`absolute inset-0 rounded-2xl overflow-hidden bg-black border border-line group ${hidden ? "invisible" : ""}`}>
      <StreamVideo
        stream={source.stream}
        fit="contain"
        // Kendi yayınının sesi sende çalmasın (yankı olur).
        muted={!!source.self || silenced}
        sinkId={sinkId}
        videoRef={video}
        className="absolute inset-0 size-full"
        onDoubleClick={onFocus}
      />
      <InkLayer ink={ink} owner={source.key} videoRef={video} drawing={drawing} />
      <div className="absolute left-2 top-2 h-7 px-2.5 rounded-lg bg-black/60 backdrop-blur text-xs flex items-center gap-1.5 pointer-events-none">
        <MonitorUp className="size-3.5 text-accent" />
        {source.self ? "Senin yayının (karşı taraf böyle görüyor)" : `${source.name} ekranı`}
      </div>
      <div className="absolute right-2 bottom-2 flex gap-1.5">
        {onStopWatching && (
          <button
            onClick={onStopWatching}
            title="İzlemeyi bırak: görüntü sana gelmez, internetin ve işlemcin rahatlar"
            className="h-9 px-2.5 rounded-lg bg-black/60 backdrop-blur flex items-center gap-1.5 text-xs opacity-80 hover:opacity-100"
          >
            <EyeOff className="size-4" />
            <span className="hidden sm:inline">İzlemeyi bırak</span>
          </button>
        )}
        <DrawButtons ink={ink} owner={source.key} drawing={drawing} onToggle={() => setDrawing(!drawing)} />
        <button
          onClick={onFocus}
          aria-label="Tam ekran"
          title="Tam ekran (çift tıkla da olur)"
          className="size-9 rounded-lg bg-black/60 backdrop-blur grid place-items-center opacity-80 hover:opacity-100"
        >
          <Maximize className="size-4" />
        </button>
      </div>
      {stats && (
        <StatsBadge className="absolute right-2 top-2" lines={[t ? fmtTrack(t) : "görüntü bekleniyor", routeLine(stats)].filter(Boolean) as string[]} />
      )}
    </div>
  );
}

// Biri ekran paylaşıyor ama izlemiyorsun: görüntü gelmez, İzle'ye basınca başlar (Discord gibi).
function ScreenInvite({
  name,
  waiting,
  hidden,
  onWatch,
  onCancel,
}: {
  name: string;
  waiting: boolean;
  hidden: boolean;
  onWatch: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className={`absolute inset-0 rounded-2xl border border-line bg-panel flex flex-col items-center justify-center gap-4 p-6 text-center ${
        hidden ? "invisible" : ""
      }`}
    >
      <div className="size-14 rounded-2xl bg-accent/15 text-accent grid place-items-center">
        <MonitorUp className="size-7" />
      </div>
      <div>
        <p className="font-medium">{name} ekranını paylaşıyor</p>
        <p className="text-xs text-muted mt-1">İzlemeye başlamadıkça görüntü sana gönderilmez.</p>
      </div>
      {waiting ? (
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted">Bağlanıyor…</span>
          <button onClick={onCancel} className="h-9 px-3 rounded-lg bg-panel-2 border border-line text-xs">
            Vazgeç
          </button>
        </div>
      ) : (
        <button
          onClick={onWatch}
          className="h-11 px-6 rounded-full bg-accent text-accent-ink font-medium flex items-center gap-2 hover:brightness-110"
        >
          <Eye className="size-5" />
          Yayını izle
        </button>
      )}
    </div>
  );
}

function DrawButtons({ ink, owner, drawing, onToggle }: { ink: Ink; owner: string; drawing: boolean; onToggle: () => void }) {
  return (
    <>
      {drawing && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            ink.clear(owner);
          }}
          aria-label="Çizimleri temizle"
          title="Çizimleri temizle"
          className="size-9 rounded-lg bg-black/60 backdrop-blur grid place-items-center opacity-80 hover:opacity-100"
        >
          <Eraser className="size-4" />
        </button>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        aria-label={drawing ? "Çizimi bitir" : "Ekrana çiz"}
        aria-pressed={drawing}
        title={drawing ? "Çizimi bitir" : "Ekrana çiz: karşı taraf görür, birkaç saniyede silinir"}
        className={`h-9 px-2.5 rounded-lg backdrop-blur flex items-center gap-1.5 text-xs ${
          drawing ? "text-accent-ink" : "bg-black/60 opacity-80 hover:opacity-100"
        }`}
        style={drawing ? { background: ink.myColor } : undefined}
      >
        <Pencil className="size-4" />
        <span className="hidden sm:inline">{drawing ? "Çiziyorsun" : "Çiz"}</span>
      </button>
    </>
  );
}

function SharingBar({
  room,
  showStats,
  stats,
  inkOpen,
  onInk,
}: {
  room: Room;
  showStats: boolean;
  stats: { name: string; s: PeerStats | null }[];
  inkOpen: boolean;
  onInk: () => void;
}) {
  const notice = room.ink.notice;
  const fresh = !!notice;
  const modes: { k: ShareMode; label: string; hint: string }[] = [
    { k: "detail", label: "Yazı", hint: "Kod, belge, site: 60 fps, internet daralırsa önce akıcılıktan kısar, yazı keskin kalır" },
    { k: "motion", label: "Hareket", hint: "Video, oyun: 60 fps, internet daralırsa önce çözünürlükten kısar, akıcılık korunur" },
  ];
  const audio = room.screenAudio;
  return (
    <div className="px-4 py-2 border-b border-line bg-accent/[0.06] flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <span className="flex items-center gap-2 text-accent">
        <span className="size-2 rounded-full bg-accent animate-pulse" />
        Ekranını paylaşıyorsun
      </span>
      <span className="text-xs text-muted flex items-center gap-1.5" title="Yalnızca İzle'ye basanlara gönderiliyor">
        <Eye className="size-3.5" />
        {room.watcherCount ? `${room.watcherCount} kişi izliyor` : "Henüz izleyen yok"}
      </span>
      <div className="flex rounded-lg border border-line overflow-hidden">
        {modes.map((m) => (
          <button
            key={m.k}
            title={m.hint}
            onClick={() => room.setScreenMode(m.k)}
            className={`h-8 px-3 text-xs ${room.screenMode === m.k ? "bg-accent text-accent-ink" : "bg-panel hover:bg-panel-2"}`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <button
        onClick={onInk}
        title="Karşı tarafın ekranına çizdiklerini her zaman üstte duran küçük bir pencerede gör"
        className={`h-8 px-3 rounded-lg border text-xs flex items-center gap-1.5 ${
          inkOpen
            ? "bg-accent text-accent-ink border-accent"
            : fresh
              ? "bg-amber-400/20 border-amber-400/50 text-amber-100 animate-pulse"
              : "bg-panel border-line hover:bg-panel-2"
        }`}
      >
        <Pencil className="size-3.5" />
        {inkOpen ? "Çizimler açık" : fresh ? `${notice!.name} ekranına çiziyor, göster` : "Çizimleri gör"}
      </button>
      {audio && (
        <button
          onClick={() => room.setScreenAudio(!audio.on)}
          title={audio.on ? "Paylaşılan ekran sesini kapat" : "Paylaşılan ekran sesini aç"}
          className={`h-8 px-3 rounded-lg border text-xs flex items-center gap-1.5 ${
            audio.on ? "bg-panel border-line hover:bg-panel-2" : "bg-danger/15 border-danger/30 text-red-300"
          }`}
        >
          {audio.on ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
          Ekran sesi {audio.on ? "açık" : "kapalı"}
        </button>
      )}
      {audio?.on && !audio.filtered && (
        <span className="text-xs text-amber-200">
          Bu tarayıcı karşı tarafın sesini paylaşımdan ayıramıyor, sesini geri duyabilir. Kulaklık tak ya da ekran
          sesini kapat.
        </span>
      )}
      {showStats &&
        stats.map(({ name, s }) =>
          s?.outScreen ? (
            <span key={name} className="text-xs text-muted font-mono">
              → {name}: {fmtTrack(s.outScreen)}
              {s.outScreen.limit !== "none" ? ` · sınır: ${limitLabel(s.outScreen.limit)}` : ""}
            </span>
          ) : null,
        )}
    </div>
  );
}

function StatsBadge({ lines, className = "" }: { lines: string[]; className?: string }) {
  return (
    <div className={`rounded-lg bg-black/70 backdrop-blur px-2 py-1 text-[11px] leading-snug font-mono text-right ${className}`}>
      {lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
    </div>
  );
}

function fmtTrack(t: TrackStats) {
  const mbps = t.kbps >= 1000 ? `${(t.kbps / 1000).toFixed(1)} Mbps` : `${t.kbps} kbps`;
  return `${t.width}×${t.height} · ${t.fps} fps · ${mbps}`;
}

function routeLine(s: PeerStats) {
  if (!s.route) return null;
  return `${s.route === "direct" ? "doğrudan" : "TURN aktarma"}${s.rttMs !== null ? ` · ${s.rttMs} ms` : ""}`;
}

function connLabel(c?: RTCPeerConnectionState) {
  switch (c) {
    case "new":
    case "connecting":
      return "bağlanıyor";
    case "disconnected":
      return "bağlantı koptu, bekleniyor";
    case "failed":
      return "bağlanamadı, tekrar deneniyor";
    case "closed":
      return "kapandı";
    default:
      return "";
  }
}

function limitLabel(l: string) {
  return l === "bandwidth" ? "bant genişliği" : l === "cpu" ? "işlemci" : l;
}

// ---------- tam ekran (odak) ----------

type Focused = {
  inkOwner?: string;
  title: string;
  stream: MediaStream | null;
  mirror: boolean;
  camOff: boolean;
  initial: string;
};

function resolveFocus(focus: string | null, room: Room, remotes: RemoteView[], screens: ScreenSource[]): Focused | null {
  if (!focus) return null;
  const [kind, id] = focus.split(":");
  if (kind === "screen") {
    const s = screens.find((x) => x.key === id);
    return s?.stream
      ? {
          inkOwner: s.key,
          title: s.self ? "Senin yayının" : `${s.name} ekranı`,
          stream: s.stream,
          mirror: false,
          camOff: false,
          initial: "",
        }
      : null;
  }
  if (id === "self")
    return {
      title: `${room.state.name} (sen)`,
      stream: room.camStream,
      mirror: room.selfMirror,
      camOff: !room.state.cam,
      initial: room.state.name.trim()[0] ?? "?",
    };
  const r = remotes.find((x) => x.id === id);
  // Kişi ayrıldıysa ya da paylaşım bittiyse odak kendiliğinden düşer, normal düzen görünür.
  return r ? { title: r.state.name, stream: r.cam, mirror: false, camOff: !r.state.cam, initial: r.state.name.trim()[0] ?? "?" } : null;
}

const HIDE_MS = 3500;

function FocusView({
  inkOwner,
  ink,
  title,
  stream,
  mirror,
  camOff,
  initial,
  controls,
  onExit,
}: Focused & { ink: Ink; controls: React.ReactNode; onExit: () => void }) {
  const [shown, setShown] = useState(true);
  const [drawing, setDrawing] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const arm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(false), HIDE_MS);
  };
  const poke = () => {
    setShown(true);
    arm();
  };
  useEffect(() => {
    timer.current = setTimeout(() => setShown(false), HIDE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const bar = `transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0 pointer-events-none"}`;

  return (
    <div
      className={`fixed inset-0 z-40 bg-black select-none ${shown ? "" : "cursor-none"}`}
      onClick={() => {
        if (drawing) return;
        if (shown) setShown(false);
        else poke();
      }}
      onPointerMove={(e) => e.pointerType === "mouse" && poke()}
    >
      {/* Ses alttaki kutulardan çalmaya devam eder; burada sessiz, yoksa iki kez duyulur. */}
      <StreamVideo
        key={stream?.getVideoTracks()[0]?.id}
        stream={stream}
        muted
        mirror={mirror}
        fit="contain"
        videoRef={video}
        className={`absolute inset-0 size-full ${camOff ? "opacity-0" : ""}`}
      />
      {inkOwner && <InkLayer ink={ink} owner={inkOwner} videoRef={video} drawing={drawing} />}
      {camOff && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="size-28 rounded-full bg-panel-2 border border-line grid place-items-center text-5xl font-medium text-muted">
            {initial.toLocaleUpperCase("tr")}
          </div>
        </div>
      )}

      <div
        className={`absolute inset-x-0 top-0 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent ${bar}`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={arm}
      >
        <span className="text-sm truncate">{title}</span>
        <div className="ml-auto" />
        {inkOwner && <DrawButtons ink={ink} owner={inkOwner} drawing={drawing} onToggle={() => setDrawing(!drawing)} />}
        <button
          onClick={onExit}
          aria-label="Tam ekrandan çık"
          title="Tam ekrandan çık (Esc)"
          className="size-10 shrink-0 rounded-full bg-black/50 border border-white/20 grid place-items-center hover:bg-black/70"
        >
          <Minimize className="size-4" />
        </button>
      </div>

      <div
        className={`absolute inset-x-0 bottom-0 px-3 pt-10 pb-[max(1rem,env(safe-area-inset-bottom))] flex items-center justify-center gap-2 bg-gradient-to-t from-black/75 to-transparent ${bar}`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={arm}
      >
        {controls}
      </div>
    </div>
  );
}

// ---------- küçük pencere (PiP) ----------

type Corner = "tl" | "tr" | "bl" | "br";
const CORNER: Record<Corner, string> = {
  tl: "top-3 left-3",
  tr: "top-3 right-3",
  bl: "bottom-3 left-3",
  br: "bottom-3 right-3",
};
const PIP_KEY = "pencere:pip";

// Sürükle bırak, en yakın köşeye otur; sürüklemeden dokunursan büyük ve küçük yer değiştirir.
function usePip() {
  const areaRef = useRef<HTMLDivElement>(null);
  const [corner, setCorner] = useState<Corner>(() => {
    try {
      const c = localStorage.getItem(PIP_KEY) as Corner | null;
      return c && c in CORNER ? c : "tr";
    } catch {
      return "tr";
    }
  });
  const [swapped, setSwapped] = useState(false);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const pipProps: React.HTMLAttributes<HTMLDivElement> = {
    onPointerDown: (e) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = { x: e.clientX, y: e.clientY, moved: false };
    },
    onPointerMove: (e) => {
      const st = start.current;
      if (!st) return;
      const dx = e.clientX - st.x;
      const dy = e.clientY - st.y;
      if (!st.moved && Math.hypot(dx, dy) < 6) return;
      st.moved = true;
      setDrag({ dx, dy });
    },
    onPointerUp: (e) => {
      const st = start.current;
      start.current = null;
      setDrag(null);
      if (!st) return;
      if (!st.moved) {
        setSwapped((v) => !v);
        return;
      }
      const area = areaRef.current?.getBoundingClientRect();
      if (!area) return;
      const right = e.clientX > area.left + area.width / 2;
      const bottom = e.clientY > area.top + area.height / 2;
      const next: Corner = `${bottom ? "b" : "t"}${right ? "r" : "l"}` as Corner;
      setCorner(next);
      try {
        localStorage.setItem(PIP_KEY, next);
      } catch {}
    },
    onPointerCancel: () => {
      start.current = null;
      setDrag(null);
    },
    style: {
      transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
      transition: drag ? "none" : undefined,
      touchAction: "none",
    },
    title: "Sürükle: köşe değiştir · Dokun: büyüt",
  };

  const pipClass = `z-10 ${CORNER[corner]} w-28 aspect-[3/4] sm:w-56 sm:aspect-video cursor-grab active:cursor-grabbing transition-[top,left,right,bottom,transform] duration-200`;

  return { areaRef, swapped, pipClass, pipProps };
}

// ---------- oda kilidi ve şifre ----------

function RoomLock({ room }: { room: Room }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { locked, password } = room.room;

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

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };

  return (
    <div ref={box} className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        aria-label="Oda güvenliği"
        title={locked ? "Oda kilitli" : password ? "Oda şifreli" : "Oda güvenliği"}
        className={`h-9 px-3 rounded-lg border text-sm flex items-center gap-2 ${
          locked || password ? "bg-accent/15 border-accent/40 text-accent" : "bg-panel-2 border-line"
        }`}
      >
        {locked ? <Lock className="size-4" /> : password ? <KeyRound className="size-4" /> : <LockOpen className="size-4" />}
        <span className="hidden sm:inline">{locked ? "Kilitli" : password ? "Şifreli" : "Güvenlik"}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-30 w-[min(20rem,calc(100vw-1.5rem))] rounded-2xl border border-line bg-panel-2 shadow-2xl shadow-black/50 p-3 text-sm">
          <button
            disabled={busy}
            onClick={() => run(() => room.setLock(!locked))}
            className="w-full flex items-start gap-3 rounded-xl p-2 text-left hover:bg-white/5 disabled:opacity-60"
          >
            {locked ? <Lock className="size-4 mt-0.5 text-accent" /> : <LockOpen className="size-4 mt-0.5" />}
            <span className="flex-1">
              <span className="block">{locked ? "Kilidi aç" : "Odayı kilitle"}</span>
              <span className="block text-xs text-muted mt-0.5">
                {locked ? "Şu an yeni kimse giremiyor." : "İçeridekiler kalır, yeni kimse giremez. Herkes çıkınca kilit açılır."}
              </span>
            </span>
          </button>

          <div className="h-px bg-line my-2" />

          {password ? (
            <div className="p-2">
              <p className="flex items-center gap-2">
                <KeyRound className="size-4 text-accent" /> Şifre açık
              </p>
              <p className="text-xs text-muted mt-1">Yeni girenler şifreyi yazmak zorunda.</p>
              <button
                disabled={busy}
                onClick={() => run(() => room.setPassword(null))}
                className="mt-3 h-9 px-3 rounded-lg bg-panel border border-line text-xs disabled:opacity-60"
              >
                Şifreyi kaldır
              </button>
            </div>
          ) : (
            <form
              className="p-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (pw.trim().length >= 4)
                  void run(async () => {
                    await room.setPassword(pw.trim());
                    setPw("");
                  });
              }}
            >
              <label className="flex items-center gap-2" htmlFor="room-pw">
                <KeyRound className="size-4" /> Şifre koy
              </label>
              <p className="text-xs text-muted mt-1">Linki bilen biri şifreyi de bilmeden giremez.</p>
              <div className="flex gap-2 mt-3">
                <input
                  id="room-pw"
                  type="password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  minLength={4}
                  maxLength={100}
                  placeholder="En az 4 karakter"
                  autoComplete="new-password"
                  className="flex-1 min-w-0 h-9 rounded-lg bg-panel border border-line px-3 outline-none focus:border-accent/60 placeholder:text-muted/60"
                />
                <button
                  disabled={busy || pw.trim().length < 4}
                  className="h-9 px-3 rounded-lg bg-accent text-accent-ink text-xs font-medium disabled:opacity-50"
                >
                  Koy
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

// Ses etkinliği hassasiyeti: canlı seviye çubuğu + eşik kaydırıcısı (Discord'daki gibi).
function GateSlider({ room }: { room: Room }) {
  const [level, setLevel] = useState(-100);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 50) return;
      last = now;
      setLevel(room.micLevelDb());
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [room]);
  const min = -90;
  const max = -10;
  const pct = (v: number) => `${Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100))}%`;
  const open = level > room.gateDb;
  return (
    <div className="px-3 pt-2 pb-3 mt-1 border-t border-line">
      <p className="text-[11px] uppercase tracking-wide text-muted pb-2">Hassasiyet</p>
      <div className="relative h-2 rounded-full bg-black/40 overflow-hidden">
        <div className={`h-full transition-[width] duration-75 ${open ? "bg-[#23a55a]" : "bg-muted/60"}`} style={{ width: pct(level) }} />
        <div className="absolute top-0 bottom-0 w-0.5 bg-white" style={{ left: pct(room.gateDb) }} />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={room.gateDb}
        onChange={(e) => room.setGateDb(Number(e.target.value))}
        aria-label="Ses etkinliği eşiği"
        className="w-full mt-2 accent-[#7cc4ff]"
      />
      <p className="text-[11px] text-muted leading-relaxed">
        Konuşunca çubuk yeşile dönmeli, sessizken gri kalmalı. Beyaz çizgiyi ona göre kaydır.
      </p>
    </div>
  );
}
