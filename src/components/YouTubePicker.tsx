"use client";

import { useState } from "react";
import { MonitorPlay, Play, Search, X } from "lucide-react";
import type { Room } from "@/lib/room";
import { parseYouTube } from "@/lib/party";

type YtItem = { id: string; title: string; channel: string; thumb: string; duration: string | null };

// "Birlikte izle" paneli: YouTube'da ara ya da bağlantı yapıştır; seçilen video herkes için başlar.
export function YouTubePicker({ room, onClose }: { room: Room; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<YtItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const isLink = !!parseYouTube(query);
  const ready = room.chatReady;
  const playing = room.party.state;

  const watch = (url: string) => {
    const v = parseYouTube(url);
    if (!v) {
      setError("Bu bir YouTube bağlantısı değil.");
      return;
    }
    room.party.start(v.id, v.start);
    onClose();
  };

  // Kota dostu olsun diye yazarken değil, Ara'ya basınca arar.
  const search = async (q: string) => {
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(`/api/youtube?q=${encodeURIComponent(q)}`);
      const data = (await res.json()) as { items?: YtItem[]; error?: string };
      if (!res.ok) {
        setResults(null);
        setError(
          data.error === "anahtar"
            ? "Arama henüz açık değil (YouTube anahtarı eklenmemiş). Şimdilik bağlantı yapıştırabilirsin."
            : data.error === "kota"
              ? "Bugünkü YouTube arama hakkı doldu, yarın yenilenir. Bağlantı yapıştırarak devam edebilirsin."
              : "YouTube'a ulaşılamadı, biraz sonra tekrar dene.",
        );
      } else {
        setResults(data.items ?? []);
        if (!data.items?.length) setError("Sonuç bulunamadı.");
      }
    } catch {
      setError("YouTube'a ulaşılamadı, biraz sonra tekrar dene.");
    }
    setSearching(false);
  };

  return (
    <aside className="fixed z-50 inset-0 sm:inset-auto sm:right-3 sm:top-16 sm:bottom-20 sm:w-[24rem] flex flex-col bg-panel sm:rounded-2xl sm:border border-line shadow-2xl shadow-black/50">
      <header className="h-12 shrink-0 px-4 flex items-center gap-2 border-b border-line pt-[env(safe-area-inset-top)] box-content">
        <MonitorPlay className="size-4 text-red-500" />
        <p className="font-medium text-sm">Birlikte izle</p>
        <button onClick={onClose} aria-label="Kapat" className="ml-auto size-9 -mr-2 rounded-lg grid place-items-center hover:bg-white/5">
          <X className="size-4" />
        </button>
      </header>

      <form
        className="shrink-0 p-3 border-b border-line"
        onSubmit={(e) => {
          e.preventDefault();
          if (isLink) watch(query);
          else if (query.trim().length >= 2) void search(query.trim());
        }}
      >
        <div className="flex gap-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="YouTube'da ara ya da bağlantı yapıştır"
            type="search"
            enterKeyHint="search"
            disabled={!ready}
            className="flex-1 min-w-0 h-10 rounded-xl bg-panel-2 border border-line px-3 text-sm outline-none focus:border-accent/60 placeholder:text-muted/60 disabled:opacity-50"
          />
          <button
            disabled={!ready || !query.trim() || searching}
            className="h-10 px-3.5 rounded-xl bg-red-600 text-white text-sm font-medium flex items-center gap-1.5 disabled:opacity-40"
          >
            {isLink ? <Play className="size-4" /> : <Search className="size-4" />}
            {isLink ? "Başlat" : searching ? "Aranıyor…" : "Ara"}
          </button>
        </div>
        <p className="text-[11px] text-muted mt-2 leading-relaxed">
          {ready
            ? "Video herkesin cihazında YouTube'dan oynar; oynatma, durdurma ve sarma herkeste aynı olur."
            : "Birlikte izlemek için odada başka biri olmalı."}
        </p>
        {playing && <p className="text-[11px] text-amber-200 mt-1">Seçtiğin video şu an izlenenin yerine geçer.</p>}
        {error && <p className="text-xs text-red-300 mt-2">{error}</p>}
      </form>

      <ul className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
        {results?.map((v) => (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => watch(`https://youtu.be/${v.id}`)}
              className="w-full flex gap-3 p-1.5 rounded-xl text-left hover:bg-white/5"
            >
              <span className="relative shrink-0 w-32 aspect-video rounded-lg overflow-hidden bg-black">
                {/* eslint-disable-next-line @next/next/no-img-element -- YouTube kapak resmi, dış kaynak */}
                <img src={v.thumb} alt="" loading="lazy" className="size-full object-cover" />
                {v.duration && (
                  <span className="absolute right-1 bottom-1 px-1 rounded bg-black/80 text-[10px] font-mono">{v.duration}</span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm leading-snug line-clamp-2">{v.title}</span>
                <span className="block text-[11px] text-muted mt-1 truncate">{v.channel}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
