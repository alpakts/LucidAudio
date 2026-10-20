// Oda istemcisi: herkes herkese doğrudan bağlanır (2-4 kişi için yeterli).
// Sinyal /api/oda/[kod] üzerinden yoklamayla taşınır, görüntü ve ses tarayıcılar arasında akar.
// Çakışan teklifler "perfect negotiation" kalıbıyla çözülür.

import { acquireTrack, loadDevicePrefs, mediaErrorText, saveDevicePrefs, type DevicePrefs } from "./devices";
import { suppressNoise, type NoiseMode } from "./noise";

export type ShareMode = "detail" | "motion";

// Her katılımcının odaya duyurduğu durum.
export type PeerState = {
  name: string;
  mic: boolean;
  cam: boolean;
  camStream: string | null;
  screenStream: string | null;
  screenMode: ShareMode | null;
};

export type TrackStats = { width: number; height: number; fps: number; kbps: number };
export type PeerStats = {
  route: "direct" | "relay" | null;
  rttMs: number | null;
  inbound: Record<string, TrackStats>; // uzak track id -> alınan
  outScreen: (TrackStats & { limit: string }) | null; // bu kişiye giden ekran görüntüsü
};

export type RemoteView = {
  id: string;
  state: PeerState;
  conn: RTCPeerConnectionState;
  cam: MediaStream | null;
  screen: MediaStream | null;
  stats: PeerStats | null;
};

type Body =
  | { k: "desc"; d: RTCSessionDescriptionInit }
  | { k: "ice"; c: RTCIceCandidateInit | null }
  | { k: "state"; s: PeerState }
  | { k: "bye" };

type Remote = {
  id: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingIce: RTCIceCandidateInit[];
  queue: Promise<void>;
  state: PeerState;
  streams: Map<string, MediaStream>;
  missing: number;
  stats: PeerStats | null;
  prevBytes: Map<string, { bytes: number; at: number }>;
};

const POLL_MS = 700;
const SPEAK_POLL_MS = 120;
const SPEAK_HOLD_MS = 350;
// Konuşma eşiği (doğrusal 0..1). Sessiz oda ~0.005, normal konuşma 0.05+.
const SPEAK_LEVEL = 0.02;

function newId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}

// Opus'a stereo ve yüksek bit hızı izni ver: ekran sesi (müzik, video) düz mono olmasın.
function boostOpus(sdp: string) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!m) return sdp;
  const pt = m[1];
  return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`, "g"), (line, params: string) => {
    let p = params;
    if (!/stereo=/.test(p)) p += ";stereo=1";
    if (!/sprop-stereo=/.test(p)) p += ";sprop-stereo=1";
    if (!/maxaveragebitrate=/.test(p)) p += ";maxaveragebitrate=128000";
    return `a=fmtp:${pt} ${p}`;
  });
}

export function canShareScreen() {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices && "getDisplayMedia" in navigator.mediaDevices;
}

export class Room {
  readonly me = newId();
  readonly camStream = new MediaStream();
  screenStream: MediaStream | null = null;
  screenMode: ShareMode = "detail";
  state: PeerState;
  turn = false;
  // Sunucu hatası yoklama düzelince kendiliğinden kalkar; medya hatası kullanıcı kapatana kadar durur.
  netError: string | null = null;
  mediaError: string | null = null;
  devices: DevicePrefs = loadDevicePrefs();

  private remotes = new Map<string, Remote>();
  private iceServers: RTCIceServer[] = [];
  private after: number | null = null;
  private floor = 0; // katılmadan önceki mesajlar bize ait değil
  private seen = new Set<number>();
  private sendChain: Promise<unknown> = Promise.resolve();
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private speakTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private failures = 0;

  constructor(
    readonly code: string,
    name: string,
  ) {
    this.state = { name, mic: false, cam: false, camStream: this.camStream.id, screenStream: null, screenMode: null };
  }

  // ---------- React bağlantısı ----------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  remoteViews(): RemoteView[] {
    return [...this.remotes.values()].map((r) => ({
      id: r.id,
      state: r.state,
      conn: r.pc.connectionState,
      cam: (r.state.camStream && r.streams.get(r.state.camStream)) || null,
      screen: (r.state.screenStream && r.streams.get(r.state.screenStream)) || null,
      stats: r.stats,
    }));
  }

  // ---------- yaşam döngüsü ----------

  // Kamera/mikrofon girişte alındı; ağ beklemesinden önce bağla. Mikrofon kapalı girildiyse
  // parça susturulmuş olarak kalır ki açınca yeniden izin/pazarlık gerekmesin.
  async join(stream: MediaStream | null, micOn = true) {
    for (const t of stream?.getVideoTracks() ?? []) {
      t.contentHint = "motion";
      this.camStream.addTrack(t);
    }
    const rawMic = stream?.getAudioTracks()[0];
    if (rawMic) await this.installMic(rawMic, micOn);
    this.state = {
      ...this.state,
      mic: micOn && this.camStream.getAudioTracks().length > 0,
      cam: this.camStream.getVideoTracks().length > 0,
    };
    try {
      const res = await fetch("/api/ice", { cache: "no-store" });
      const data = (await res.json()) as { iceServers: RTCIceServer[]; turn: boolean };
      this.iceServers = data.iceServers;
      this.turn = data.turn;
    } catch {
      this.iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
    }
    this.running = true;
    this.statsTimer = setInterval(() => void this.collectStats(), 2000);
    this.speakTimer = setInterval(() => this.checkSpeaking(), SPEAK_POLL_MS);
    window.addEventListener("pagehide", this.onPageHide);
    void this.poll();
    this.emit();
  }

  leave() {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.speakTimer) clearInterval(this.speakTimer);
    this.selfMeter?.ctx.close().catch(() => {});
    this.selfMeter = null;
    window.removeEventListener("pagehide", this.onPageHide);
    this.signal("*", { k: "bye" });
    void this.sendChain.then(() => this.api({ t: "leave" }).catch(() => {}));
    for (const r of this.remotes.values()) r.pc.close();
    this.remotes.clear();
    for (const t of this.camStream.getTracks()) t.stop();
    this.micStop?.();
    this.micStop = null;
    for (const t of this.screenStream?.getTracks() ?? []) t.stop();
    this.emit();
  }

  private onPageHide = () => {
    // Sekme kapanırken fetch iptal olabilir; sendBeacon garanti ulaşır.
    const url = `/api/oda/${this.code}`;
    navigator.sendBeacon(url, new Blob([JSON.stringify({ t: "send", me: this.me, to: "*", body: { k: "bye" } })], { type: "application/json" }));
    navigator.sendBeacon(url, new Blob([JSON.stringify({ t: "leave", me: this.me })], { type: "application/json" }));
  };

  // ---------- sinyal ----------

  private async api(body: Record<string, unknown>) {
    const res = await fetch(`/api/oda/${this.code}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ me: this.me, ...body }),
    });
    if (!res.ok) throw new Error(`sinyal ${res.status}`);
    return res.json();
  }

  // Gönderimleri sıraya koy: açıklama, ondan sonra üretilen ICE adaylarından önce ulaşsın.
  private signal(to: string, body: Body) {
    this.sendChain = this.sendChain.then(() => this.api({ t: "send", to, body }).catch((e) => console.warn(e)));
  }

  private async poll() {
    if (!this.running) return;
    try {
      const after = this.after === null ? null : Math.max(0, this.after - 50);
      const res = (await this.api({ t: "poll", name: this.state.name, after })) as {
        peers: { id: string; name: string }[];
        msgs: { id: number; from: string; body: Body }[];
        last: number | null;
      };
      if (!this.running) return;
      this.failures = 0;
      if (this.netError) {
        this.netError = null;
        this.emit();
      }
      if (res.last !== null) this.after = this.floor = res.last;
      this.syncPeers(res.peers);
      for (const m of res.msgs) {
        if (m.id <= this.floor || this.seen.has(m.id)) continue;
        this.seen.add(m.id);
        this.after = Math.max(this.after ?? 0, m.id);
        this.onMessage(m.from, m.body);
      }
      if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-500));
    } catch (e) {
      console.warn(e);
      if (++this.failures >= 3 && !this.netError) {
        this.netError = "Sunucuya ulaşılamıyor, yeniden deneniyor…";
        this.emit();
      }
    }
    this.pollTimer = setTimeout(() => void this.poll(), this.failures ? 2000 : POLL_MS);
  }

  private syncPeers(peers: { id: string; name: string }[]) {
    const present = new Set(peers.map((p) => p.id));
    for (const p of peers) {
      const r = this.remotes.get(p.id) ?? this.createRemote(p.id, p.name);
      r.missing = 0;
    }
    for (const r of this.remotes.values()) {
      // İki ardışık yoklamada yoksa gitmiştir (sunucu 10 sn sessizlikte düşürür).
      if (!present.has(r.id) && ++r.missing >= 2) this.dropRemote(r.id);
    }
  }

  private onMessage(from: string, body: Body) {
    if (body.k === "bye") {
      this.dropRemote(from);
      return;
    }
    const r = this.remotes.get(from) ?? this.createRemote(from, "");
    // Aynı kişiden gelen mesajları sırayla işle.
    r.queue = r.queue.then(() => this.handle(r, body)).catch((e) => console.warn("sinyal işleme", e));
  }

  private async handle(r: Remote, body: Body) {
    const pc = r.pc;
    if (pc.signalingState === "closed") return;
    if (body.k === "state") {
      r.state = body.s;
      this.applyParams(r);
      this.emit();
      return;
    }
    if (body.k === "desc") {
      const d = { type: body.d.type, sdp: boostOpus(body.d.sdp ?? "") } as RTCSessionDescriptionInit;
      const collision = d.type === "offer" && (r.makingOffer || pc.signalingState !== "stable");
      r.ignoreOffer = !r.polite && collision;
      if (r.ignoreOffer) return;
      await pc.setRemoteDescription(d);
      for (const c of r.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (d.type === "offer") {
        await pc.setLocalDescription();
        this.signal(r.id, { k: "desc", d: pc.localDescription!.toJSON() });
      }
      return;
    }
    if (body.k === "ice") {
      if (!body.c) return;
      if (!pc.remoteDescription) {
        r.pendingIce.push(body.c);
        return;
      }
      try {
        await pc.addIceCandidate(body.c);
      } catch (e) {
        if (!r.ignoreOffer) console.warn("ice", e);
      }
    }
  }

  // ---------- bağlantılar ----------

  private createRemote(id: string, name: string): Remote {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: "max-bundle" });
    const r: Remote = {
      id,
      pc,
      polite: this.me > id,
      makingOffer: false,
      ignoreOffer: false,
      pendingIce: [],
      queue: Promise.resolve(),
      state: { name: name || "…", mic: false, cam: false, camStream: null, screenStream: null, screenMode: null },
      streams: new Map(),
      missing: 0,
      stats: null,
      prevBytes: new Map(),
    };
    this.remotes.set(id, r);

    pc.onnegotiationneeded = async () => {
      try {
        r.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(id, { k: "desc", d: pc.localDescription!.toJSON() });
      } catch (e) {
        console.warn("teklif", e);
      } finally {
        r.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signal(id, { k: "ice", c: candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      const s = e.streams[0] ?? new MediaStream([e.track]);
      r.streams.set(s.id, s);
      const update = () => this.emit();
      e.track.addEventListener("unmute", update);
      e.track.addEventListener("ended", update);
      s.addEventListener("removetrack", update);
      s.addEventListener("addtrack", update);
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") pc.restartIce();
      this.emit();
    };
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === "stable") this.applyParams(r);
    };

    for (const t of this.camStream.getTracks()) pc.addTrack(t, this.camStream);
    this.markCamSenders();
    for (const t of this.screenStream?.getTracks() ?? []) pc.addTrack(t, this.screenStream!);
    // Yeni gelen bizim durumumuzu bilmiyor.
    this.signal(id, { k: "state", s: this.state });
    this.emit();
    return r;
  }

  private dropRemote(id: string) {
    const r = this.remotes.get(id);
    if (!r) return;
    r.pc.close();
    this.remotes.delete(id);
    this.applyAllParams();
    this.emit();
  }

  // ---------- kalite ----------

  // Herkese ayrı yükleme yapıldığı için kişi sayısı arttıkça bit hızı paylaştırılır.
  private budget() {
    const n = Math.max(1, this.remotes.size);
    // İki mod da 60 fps; hareketli içerik kare başına daha çok bit ister.
    const screen = this.screenMode === "motion" ? 10_000_000 : 6_000_000;
    return {
      screen: n === 1 ? screen : Math.round(screen / Math.min(n, 2.5)),
      cam: n === 1 ? 1_500_000 : 800_000,
      mic: 64_000,
      screenAudio: 160_000,
    };
  }

  private applyAllParams() {
    for (const r of this.remotes.values()) this.applyParams(r);
  }

  private applyParams(r: Remote) {
    if (r.pc.signalingState === "closed") return;
    const b = this.budget();
    for (const sender of r.pc.getSenders()) {
      const t = sender.track;
      if (!t) continue;
      const isScreen = !!this.screenStream?.getTrackById(t.id);
      const configure = (withDegradation: boolean) => {
        const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
        if (!params.encodings?.length) return null;
        const enc = params.encodings[0];
        if (t.kind === "video" && isScreen) {
          enc.maxBitrate = b.screen;
          enc.maxFramerate = 60;
          enc.scaleResolutionDownBy = 1;
          if (withDegradation)
            params.degradationPreference = this.screenMode === "motion" ? "maintain-framerate" : "maintain-resolution";
        } else if (t.kind === "video") {
          enc.maxBitrate = b.cam;
          enc.maxFramerate = 30;
        } else {
          enc.maxBitrate = isScreen ? b.screenAudio : b.mic;
        }
        return params;
      };
      const full = configure(true);
      if (!full) continue;
      // degradationPreference'ı desteklemeyen tarayıcı bütün çağrıyı reddeder; bit hızı yine de uygulansın.
      sender.setParameters(full).catch(() => {
        const plain = configure(false);
        if (plain) sender.setParameters(plain).catch(() => {});
      });
    }
  }

  // ---------- yerel medya ----------

  private broadcastState() {
    this.signal("*", { k: "state", s: this.state });
    this.emit();
  }

  private addTrackEverywhere(track: MediaStreamTrack, stream: MediaStream) {
    for (const r of this.remotes.values()) r.pc.addTrack(track, stream);
  }

  private replaceOrAdd(kind: "audio" | "video", track: MediaStreamTrack) {
    for (const r of this.remotes.values()) {
      const sender = r.pc
        .getTransceivers()
        .find((tr) => tr.sender.track === null && tr.receiver.track.kind === kind && this.isCamSender(tr))?.sender;
      if (sender) void sender.replaceTrack(track);
      else r.pc.addTrack(track, this.camStream);
    }
  }

  // Kamera/mikrofon için kullandığımız gönderici mi (ekranınki değil)?
  private camSenders = new WeakSet<RTCRtpSender>();
  private isCamSender(tr: RTCRtpTransceiver) {
    return this.camSenders.has(tr.sender);
  }

  async setMic(on: boolean) {
    const cur = this.camStream.getAudioTracks()[0];
    if (cur) {
      cur.enabled = on;
    } else if (on) {
      let t: MediaStreamTrack | undefined;
      try {
        t = await acquireTrack("audio", this.devices.mic);
      } catch (e) {
        console.warn("mikrofon", e);
        this.mediaError = mediaErrorText(e, "mikrofon");
      }
      if (t) await this.installMic(t, true);
      else on = false;
    }
    this.state = { ...this.state, mic: on };
    this.broadcastState();
  }

  async setCam(on: boolean) {
    const cur = this.camStream.getVideoTracks()[0];
    if (!on) {
      if (cur) {
        cur.stop();
        this.camStream.removeTrack(cur);
        // Göndericiyi sakla, sonra replaceTrack ile yeniden kullanılır: tekrar pazarlık gerekmez.
        for (const r of this.remotes.values())
          for (const s of r.pc.getSenders()) if (s.track === cur) void s.replaceTrack(null);
      }
      this.state = { ...this.state, cam: false };
      this.broadcastState();
      return;
    }
    if (cur) return;
    let t: MediaStreamTrack | undefined;
    try {
      t = await acquireTrack("video", this.devices.cam);
    } catch (e) {
      console.warn("kamera", e);
      this.mediaError = mediaErrorText(e, "kamera");
    }
    if (t) {
      t.contentHint = "motion";
      this.camStream.addTrack(t);
      this.replaceOrAdd("video", t);
      this.markCamSenders();
    }
    this.state = { ...this.state, cam: !!t };
    this.broadcastState();
  }

  // ---------- cihaz seçimi ----------

  currentDevice(kind: "mic" | "cam" | "speaker"): string {
    if (kind === "speaker") return this.devices.speaker ?? "";
    // Gönderilen ses parçası işlenmiş olabilir; cihaz bilgisi ham parçada.
    const t = kind === "mic" ? this.micRaw : this.camStream.getVideoTracks()[0];
    return t?.getSettings().deviceId ?? this.devices[kind] ?? "";
  }

  get selfMirror() {
    return this.camStream.getVideoTracks()[0]?.getSettings().facingMode !== "environment";
  }

  async selectDevice(kind: "mic" | "cam" | "speaker", deviceId: string) {
    this.devices = { ...this.devices, [kind]: deviceId };
    saveDevicePrefs(this.devices);
    if (kind === "speaker") {
      this.emit();
      return;
    }
    if (kind === "mic") {
      if (!this.micRaw) {
        this.emit();
        return;
      }
      let raw: MediaStreamTrack;
      try {
        raw = await acquireTrack("audio", deviceId);
      } catch (e) {
        // Eski mikrofon çalışmaya devam eder.
        console.warn("mikrofon değişimi", e);
        this.mediaError = mediaErrorText(e, "mikrofon");
        this.emit();
        return;
      }
      await this.installMic(raw, this.state.mic);
      this.broadcastState();
      return;
    }
    const cur = this.camStream.getVideoTracks()[0];
    // Kapalı kamera için sadece tercih kaydedilir, açılınca bu cihaz kullanılır.
    if (!cur) {
      this.emit();
      return;
    }
    // Telefonlar iki kamerayı aynı anda açamıyor: önce eskisini bırak.
    cur.stop();
    this.camStream.removeTrack(cur);
    let next: MediaStreamTrack | undefined;
    try {
      next = await acquireTrack("video", deviceId);
    } catch (e) {
      console.warn("kamera değişimi", e);
      this.mediaError = mediaErrorText(e, "kamera");
      try {
        next = await acquireTrack("video");
      } catch {}
    }
    if (next) {
      next.contentHint = "motion";
      this.camStream.addTrack(next);
    }
    for (const r of this.remotes.values())
      for (const s of r.pc.getSenders()) if (s.track === cur) void s.replaceTrack(next ?? null);
    this.state = { ...this.state, cam: !!next };
    this.broadcastState();
  }

  // ---------- mikrofon hattı (gürültü engelleme) ----------

  private micRaw: MediaStreamTrack | null = null;
  private micStop: (() => void) | null = null;
  // Güçlü mod seçili ama bu tarayıcıda çalıştırılamadıysa false (ham ses gider).
  noiseActive = false;

  get noiseMode(): NoiseMode {
    return this.devices.noise ?? "strong";
  }

  async setNoise(mode: NoiseMode) {
    this.devices = { ...this.devices, noise: mode };
    saveDevicePrefs(this.devices);
    if (!this.micRaw) {
      this.emit();
      return;
    }
    // Kısıtlar (tarayıcının gürültü engellemesi açık/kapalı) değiştiği için mikrofon yeniden açılır.
    let raw: MediaStreamTrack | undefined;
    try {
      raw = await acquireTrack("audio", this.devices.mic);
    } catch {
      // Bazı telefonlar aynı mikrofonu iki kez açamıyor: eskisini bırakıp yeniden dene.
      this.micStop?.();
      this.micStop = null;
      try {
        raw = await acquireTrack("audio", this.devices.mic);
      } catch (e) {
        this.mediaError = mediaErrorText(e, "mikrofon");
        this.state = { ...this.state, mic: false };
        this.broadcastState();
        return;
      }
    }
    await this.installMic(raw, this.state.mic);
    this.broadcastState();
  }

  // Ham mikrofonu seçili gürültü ayarına göre işleyip gönderilen parça yapar ve eskisinin yerine koyar.
  // Göndericide replaceTrack kullanılır: bağlantı yeniden kurulmaz.
  private async installMic(raw: MediaStreamTrack, enabled: boolean) {
    let out = raw;
    let stop = () => raw.stop();
    this.noiseActive = false;
    if (this.noiseMode === "strong") {
      try {
        const clean = await suppressNoise(raw);
        out = clean.track;
        stop = clean.stop;
        this.noiseActive = true;
      } catch (e) {
        console.warn("gürültü engelleme çalışmadı, ham ses gidiyor", e);
      }
    }
    out.enabled = enabled;
    const old = this.camStream.getAudioTracks()[0];
    const oldStop = this.micStop;
    this.micRaw = raw;
    this.micStop = stop;
    if (old) {
      this.camStream.removeTrack(old);
      this.camStream.addTrack(out);
      for (const r of this.remotes.values())
        for (const s of r.pc.getSenders()) if (s.track === old) void s.replaceTrack(out);
    } else {
      this.camStream.addTrack(out);
      this.addTrackEverywhere(out, this.camStream);
      this.markCamSenders();
    }
    if (oldStop) oldStop();
    else old?.stop();
  }

  private markCamSenders() {
    const ids = new Set(this.camStream.getTracks().map((t) => t.id));
    for (const r of this.remotes.values())
      for (const s of r.pc.getSenders()) if (s.track && ids.has(s.track.id)) this.camSenders.add(s);
  }

  async startScreen(mode: ShareMode) {
    if (this.screenStream) return;
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { max: 2560 },
          height: { max: 1440 },
          frameRate: { ideal: 60, max: 60 },
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          // Bu sekmenin çaldığı sesi (karşı tarafın konuşması) paylaşılan sistem sesinden çıkar;
          // yoksa karşı taraf kendi sesini yankı olarak geri duyar.
          restrictOwnAudio: true,
        } as MediaTrackConstraints,
        // Chrome'a özgü: sistem sesini teklif et, bu sekmeyi listeden çıkar.
        systemAudio: "include",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
      } as DisplayMediaStreamOptions);
    } catch (e) {
      if ((e as Error).name !== "NotAllowedError") this.mediaError = `Ekran paylaşılamadı: ${(e as Error).message}`;
      this.emit();
      return;
    }
    this.screenStream = s;
    this.screenMode = mode;
    const v = s.getVideoTracks()[0];
    // "detail" ipucu Chrome'u ekran paylaşımı kipine sokup kare hızını 30'un altına kısıyor;
    // iki modda da "motion" verip farkı degradationPreference ile kuruyoruz (applyParams).
    v.contentHint = "motion";
    v.addEventListener("ended", () => this.stopScreen());
    for (const t of s.getTracks()) this.addTrackEverywhere(t, s);
    this.state = { ...this.state, screenStream: s.id, screenMode: mode };
    this.applyAllParams();
    this.broadcastState();
  }

  // Paylaşımda ses var mı, açık mı, karşı tarafın sesi süzülüyor mu (tarayıcı destekliyorsa).
  get screenAudio(): { on: boolean; filtered: boolean } | null {
    const t = this.screenStream?.getAudioTracks()[0];
    if (!t) return null;
    const settings = t.getSettings() as MediaTrackSettings & { restrictOwnAudio?: boolean };
    return { on: t.enabled, filtered: settings.restrictOwnAudio === true };
  }

  setScreenAudio(on: boolean) {
    for (const t of this.screenStream?.getAudioTracks() ?? []) t.enabled = on;
    this.emit();
  }

  dismissMediaError() {
    this.mediaError = null;
    this.emit();
  }

  setScreenMode(mode: ShareMode) {
    this.screenMode = mode;
    this.state = { ...this.state, screenMode: this.screenStream ? mode : null };
    this.applyAllParams();
    this.broadcastState();
  }

  stopScreen() {
    const s = this.screenStream;
    if (!s) return;
    this.screenStream = null;
    const ids = new Set(s.getTracks().map((t) => t.id));
    for (const t of s.getTracks()) t.stop();
    for (const r of this.remotes.values())
      for (const sender of r.pc.getSenders()) if (sender.track && ids.has(sender.track.id)) r.pc.removeTrack(sender);
    this.state = { ...this.state, screenStream: null, screenMode: null };
    this.broadcastState();
  }

  // ---------- konuşan kişi (Discord'daki yeşil ışık) ----------

  // "self" ya da karşı tarafın kimliği.
  speaking = new Set<string>();
  private lastLoud = new Map<string, number>();
  private selfMeter: { track: MediaStreamTrack; ctx: AudioContext; an: AnalyserNode; buf: Float32Array<ArrayBuffer> } | null =
    null;

  // Gönderilen mikrofon parçasının seviyesi (Lucid açıksa temizlenmiş ses: klavye/fan ışığı yakmaz).
  private selfLevel(track: MediaStreamTrack) {
    if (this.selfMeter?.track !== track) {
      this.selfMeter?.ctx.close().catch(() => {});
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(new MediaStream([track])).connect(an);
      void ctx.resume();
      this.selfMeter = { track, ctx, an, buf: new Float32Array(an.fftSize) };
    }
    const m = this.selfMeter;
    if (m.ctx.state !== "running") {
      void m.ctx.resume();
      return 0;
    }
    m.an.getFloatTimeDomainData(m.buf);
    let sum = 0;
    for (const x of m.buf) sum += x * x;
    return Math.sqrt(sum / m.buf.length);
  }

  private checkSpeaking() {
    const now = performance.now();
    const mark = (id: string, level: number) => {
      if (level > SPEAK_LEVEL) this.lastLoud.set(id, now);
    };

    const mic = this.camStream.getAudioTracks()[0];
    if (this.state.mic && mic?.readyState === "live") mark("self", this.selfLevel(mic));

    for (const r of this.remotes.values()) {
      if (!r.state.mic) continue;
      // Ekran paylaşımının sesi değil, kişinin mikrofonu: kamera akışındaki ses parçası.
      const cam = r.state.camStream ? r.streams.get(r.state.camStream) : null;
      const track = cam?.getAudioTracks()[0];
      const receiver = track && r.pc.getReceivers().find((x) => x.track === track);
      // Tarayıcının çözdüğü sesin anlık seviyesi (0..1); ek ses işleme gerektirmez.
      mark(r.id, receiver?.getSynchronizationSources()[0]?.audioLevel ?? 0);
    }

    // Kelime aralarında yanıp sönmesin diye kısa bir süre yanık kalır.
    const next = new Set([...this.lastLoud].filter(([, t]) => now - t < SPEAK_HOLD_MS).map(([id]) => id));
    if (!this.state.mic) next.delete("self");
    for (const id of next) if (id !== "self" && !this.remotes.get(id)?.state.mic) next.delete(id);
    if (next.size !== this.speaking.size || [...next].some((id) => !this.speaking.has(id))) {
      this.speaking = next;
      this.emit();
    }
  }

  // ---------- istatistik ----------

  private async collectStats() {
    for (const r of this.remotes.values()) {
      if (r.pc.connectionState !== "connected") continue;
      try {
        const report = await r.pc.getStats();
        const now = performance.now();
        const stats: PeerStats = { route: null, rttMs: null, inbound: {}, outScreen: null };
        const byId = new Map<string, Record<string, unknown>>();
        report.forEach((s) => byId.set(s.id, s as Record<string, unknown>));
        const screenIds = new Set(this.screenStream?.getVideoTracks().map((t) => t.id) ?? []);

        const kbps = (key: string, bytes: number) => {
          const prev = r.prevBytes.get(key);
          r.prevBytes.set(key, { bytes, at: now });
          return prev ? Math.round(((bytes - prev.bytes) * 8) / (now - prev.at)) : 0;
        };

        for (const s of byId.values()) {
          if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") {
            const local = byId.get(s.localCandidateId as string);
            const remote = byId.get(s.remoteCandidateId as string);
            stats.route = local?.candidateType === "relay" || remote?.candidateType === "relay" ? "relay" : "direct";
            if (typeof s.currentRoundTripTime === "number") stats.rttMs = Math.round(s.currentRoundTripTime * 1000);
          }
          if (s.type === "inbound-rtp" && s.kind === "video" && typeof s.trackIdentifier === "string") {
            stats.inbound[s.trackIdentifier] = {
              width: (s.frameWidth as number) ?? 0,
              height: (s.frameHeight as number) ?? 0,
              fps: Math.round((s.framesPerSecond as number) ?? 0),
              kbps: kbps(s.id as string, (s.bytesReceived as number) ?? 0),
            };
          }
          if (s.type === "outbound-rtp" && s.kind === "video") {
            const src = byId.get(s.mediaSourceId as string);
            if (src && screenIds.has(src.trackIdentifier as string)) {
              stats.outScreen = {
                width: (s.frameWidth as number) ?? 0,
                height: (s.frameHeight as number) ?? 0,
                fps: Math.round((s.framesPerSecond as number) ?? 0),
                kbps: kbps(s.id as string, (s.bytesSent as number) ?? 0),
                limit: (s.qualityLimitationReason as string) ?? "none",
              };
            }
          }
        }
        r.stats = stats;
      } catch {
        /* bağlantı kapanıyor olabilir */
      }
    }
    this.emit();
  }
}
