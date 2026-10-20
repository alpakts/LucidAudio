"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";

// Oda tamamen tarayıcıya bağlı (kamera, cihazlar, kayıtlı ad); sunucuda çizmek eşleşmezlik üretir.
const Call = dynamic(() => import("@/components/Call").then((m) => m.Call), {
  ssr: false,
  loading: () => <main className="min-h-full" />,
});

export default function RoomPage() {
  const { kod } = useParams<{ kod: string }>();
  const code = decodeURIComponent(kod).toLowerCase();
  if (!/^[a-z0-9-]{3,40}$/.test(code))
    return (
      <main className="min-h-full grid place-items-center px-4 text-center">
        <div>
          <p className="text-lg font-medium">Geçersiz oda kodu</p>
          <Link href="/" className="text-accent text-sm mt-2 inline-block">
            Ana sayfaya dön
          </Link>
        </div>
      </main>
    );
  return <Call key={code} code={code} />;
}
