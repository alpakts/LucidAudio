"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MonitorUp, Video, ArrowRight } from "lucide-react";
import { Version } from "@/components/Version";

const RENK = ["mavi", "kirmizi", "yesil", "sari", "mor", "turuncu", "gri", "pembe", "lacivert", "bordo"];
const HAYVAN = ["kedi", "kartal", "balina", "tilki", "baykus", "ceylan", "yunus", "kaplan", "sincap", "kirpi"];

function newRoomCode() {
  const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  return `${pick(RENK)}-${pick(HAYVAN)}-${Math.floor(10 + Math.random() * 90)}`;
}

function toCode(input: string) {
  const s = input.trim();
  const fromUrl = s.match(/\/([a-z0-9-]{3,40})\/?$/i);
  return (fromUrl ? fromUrl[1] : s)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export default function Home() {
  const router = useRouter();
  const [join, setJoin] = useState("");
  const code = toCode(join);

  return (
    <main className="relative min-h-full flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-8">
          <div className="size-10 rounded-xl bg-accent/15 text-accent grid place-items-center">
            <MonitorUp className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Pencere</h1>
            <p className="text-sm text-muted">Linkle açılan görüşme ve net ekran paylaşımı</p>
          </div>
        </div>

        <button
          onClick={() => router.push(`/${newRoomCode()}`)}
          className="w-full h-12 rounded-xl bg-accent text-accent-ink font-medium flex items-center justify-center gap-2 hover:brightness-110 active:brightness-95 transition"
        >
          <Video className="size-5" />
          Yeni oda aç
        </button>

        <div className="flex items-center gap-3 my-6 text-xs text-muted">
          <div className="h-px flex-1 bg-line" />
          ya da odaya katıl
          <div className="h-px flex-1 bg-line" />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length >= 3) router.push(`/${code}`);
          }}
          className="flex gap-2"
        >
          <input
            value={join}
            onChange={(e) => setJoin(e.target.value)}
            placeholder="Oda kodu ya da link"
            className="flex-1 min-w-0 h-12 rounded-xl bg-panel border border-line px-4 outline-none focus:border-accent/60 placeholder:text-muted/70"
          />
          <button
            disabled={code.length < 3}
            className="h-12 w-12 shrink-0 rounded-xl bg-panel-2 border border-line grid place-items-center disabled:opacity-40 hover:border-accent/60 transition"
            aria-label="Katıl"
          >
            <ArrowRight className="size-5" />
          </button>
        </form>

        <p className="mt-10 text-xs leading-relaxed text-muted">
          Görüntü sunucudan geçmez, katılımcılar arasında doğrudan akar. En iyi sonuç 2-4 kişide. Ekran paylaşımı
          bilgisayar tarayıcısından yapılır; telefondan katılıp izlemek ve kamerayla konuşmak mümkün.
        </p>
      </div>
      <Version />
    </main>
  );
}
