"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Download, File as FileIcon, Paperclip, Play, SendHorizontal, X } from "lucide-react";
import type { ChatItem, Room } from "@/lib/room";
import { parseYouTube } from "@/lib/party";

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(at: number) {
  return new Date(at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
}

// Metindeki http(s) bağlantılarını tıklanabilir yap; geri kalan düz metin (HTML olarak işlenmez).
// YouTube bağlantılarının yanında "Birlikte izle" düğmesi çıkar.
function Linkified({ text, onWatch }: { text: string; onWatch: (url: string) => void }) {
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <Fragment key={i}>
            <a href={p} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 break-all">
              {p}
            </a>
            {parseYouTube(p) && (
              <button
                type="button"
                onClick={() => onWatch(p)}
                className="ml-1.5 inline-flex items-center gap-1 align-middle h-6 px-2 rounded-full bg-red-600 text-white text-[11px] font-medium"
              >
                <Play className="size-3" /> Birlikte izle
              </button>
            )}
          </Fragment>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

function FileCard({ item, mine }: { item: ChatItem; mine: boolean }) {
  const f = item.file!;
  const image = f.mime.startsWith("image/") && f.url;
  const pct = Math.round(f.progress * 100);
  return (
    <div className="min-w-0">
      {image && (
        <a href={f.url!} target="_blank" rel="noopener noreferrer" className="block mb-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- yerel nesne URL'si, Next görsel optimizasyonu uygulanamaz */}
          <img src={f.url!} alt={f.name} className="max-h-56 max-w-full rounded-lg object-contain bg-black/30" />
        </a>
      )}
      <div className="flex items-center gap-2.5">
        <FileIcon className="size-5 shrink-0 opacity-80" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{f.name}</p>
          <p className="text-[11px] opacity-70">
            {fmtSize(f.size)}
            {f.failed ? " · gönderilemedi" : f.progress < 1 ? ` · ${mine ? "gönderiliyor" : "alınıyor"} %${pct}` : ""}
          </p>
        </div>
        {f.url && !f.failed && (
          <a
            href={f.url}
            download={f.name}
            aria-label={`${f.name} indir`}
            className="size-8 shrink-0 rounded-lg grid place-items-center bg-black/20 hover:bg-black/30"
          >
            <Download className="size-4" />
          </a>
        )}
      </div>
      {f.progress < 1 && !f.failed && (
        <div className="mt-2 h-1 rounded-full bg-black/25 overflow-hidden">
          <div className="h-full bg-current transition-[width] duration-150" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export function ChatPanel({ room, onClose }: { room: Room; onClose: () => void }) {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const items = room.chat;
  const ready = room.chatReady;

  useEffect(() => {
    room.setChatVisible(true);
    input.current?.focus();
    return () => room.setChatVisible(false);
  }, [room]);

  // Yeni mesajda en alta kaydır.
  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  // Sohbetteki YouTube linkinin yanındaki düğme: herkes için başlat.
  const watch = (url: string) => {
    const v = parseYouTube(url);
    if (v) room.party.start(v.id, v.start);
  };

  const send = () => {
    if (!text.trim()) return;
    room.sendText(text);
    setText("");
  };
  const sendFiles = (files: FileList | File[] | null) => {
    for (const f of Array.from(files ?? [])) room.sendFile(f);
  };

  return (
    <aside
      className="fixed z-50 inset-0 sm:inset-auto sm:right-3 sm:top-16 sm:bottom-20 sm:w-[22rem] flex flex-col bg-panel sm:rounded-2xl sm:border border-line shadow-2xl shadow-black/50"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        sendFiles(e.dataTransfer.files);
      }}
    >
      <header className="h-12 shrink-0 px-4 flex items-center border-b border-line pt-[env(safe-area-inset-top)] box-content">
        <p className="font-medium text-sm">Sohbet</p>
        <button onClick={onClose} aria-label="Sohbeti kapat" className="ml-auto size-9 -mr-2 rounded-lg grid place-items-center hover:bg-white/5">
          <X className="size-4" />
        </button>
      </header>

      <div ref={list} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2.5">
        {items.length === 0 && (
          <p className="text-xs text-muted text-center mt-8 px-4 leading-relaxed">
            Mesajlar ve dosyalar doğrudan odadakilere gider, hiçbir yerde saklanmaz. Sonradan gelen eskileri görmez.
          </p>
        )}
        {items.map((m, i) => {
          const mine = m.from === "self";
          const showName = !mine && items[i - 1]?.from !== m.from;
          return (
            <div key={m.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
              {showName && <span className="text-[11px] text-muted mb-1 px-1">{m.name}</span>}
              <div
                className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                  mine ? "bg-accent text-accent-ink rounded-br-md" : "bg-panel-2 border border-line rounded-bl-md"
                }`}
              >
                {m.file ? <FileCard item={m} mine={mine} /> : <Linkified text={m.text ?? ""} onWatch={watch} />}
                <span className={`block text-[10px] mt-1 text-right ${mine ? "text-accent-ink/60" : "text-muted"}`}>
                  {fmtTime(m.at)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <form
        className="shrink-0 p-2 border-t border-line flex items-end gap-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            sendFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={!ready}
          onClick={() => fileInput.current?.click()}
          aria-label="Dosya gönder"
          title="Dosya gönder (sürükle bırak ya da yapıştır da olur)"
          className="size-10 shrink-0 rounded-xl grid place-items-center hover:bg-white/5 disabled:opacity-40"
        >
          <Paperclip className="size-5" />
        </button>
        <textarea
          ref={input}
          rows={1}
          value={text}
          disabled={!ready}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              sendFiles(e.clipboardData.files);
            }
          }}
          placeholder={ready ? "Mesaj yaz…" : "Odada başka kimse yok"}
          className="flex-1 min-w-0 resize-none max-h-36 rounded-xl bg-panel-2 border border-line px-3 py-2.5 text-sm outline-none focus:border-accent/60 placeholder:text-muted/60 disabled:opacity-60"
        />
        <button
          disabled={!ready || !text.trim()}
          aria-label="Gönder"
          className="size-10 shrink-0 rounded-xl grid place-items-center bg-accent text-accent-ink disabled:opacity-40"
        >
          <SendHorizontal className="size-4" />
        </button>
      </form>

      {dragging && (
        <div className="absolute inset-0 sm:rounded-2xl bg-accent/15 border-2 border-dashed border-accent grid place-items-center pointer-events-none">
          <p className="text-accent font-medium">Göndermek için bırak</p>
        </div>
      )}
    </aside>
  );
}
