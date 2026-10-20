// YouTube araması (Birlikte izle kutusu için). Anahtar sunucuda kalır, tarayıcıya gitmez.
//   GET /api/youtube?q=...  ->  { items: [{ id, title, channel, thumb, duration }] }
//                               503 { error: "anahtar" }  YOUTUBE_API_KEY tanımlı değilse
// Günlük ücretsiz kota ~100 arama: aynı sorgu CDN'de 1 saat önbellekte tutulur.

export const dynamic = "force-dynamic";

type Item = { id: string; title: string; channel: string; thumb: string; duration: string | null };

// API başlıkları HTML kaçışlı döndürür (&#39; &amp; ...).
function decode(s: string) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// PT1H2M3S -> 1:02:03
function fmtDuration(iso: string | undefined) {
  const m = iso?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [h, mm, ss] = [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(mm)}:${two(ss)}` : `${mm}:${two(ss)}`;
}

export async function GET(req: Request) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return Response.json({ error: "anahtar" }, { status: 503 });
  const q = new URL(req.url).searchParams.get("q")?.trim().slice(0, 100) ?? "";
  if (q.length < 2) return Response.json({ items: [] });

  const search = new URL("https://www.googleapis.com/youtube/v3/search");
  search.search = new URLSearchParams({
    part: "snippet",
    type: "video",
    videoEmbeddable: "true", // yalnızca başka sitede oynatılabilenler
    maxResults: "12",
    regionCode: "TR",
    relevanceLanguage: "tr",
    q,
    key,
  }).toString();
  const res = await fetch(search, { cache: "no-store" });
  if (!res.ok) {
    const quota = res.status === 403;
    console.error("youtube arama", res.status, await res.text().catch(() => ""));
    return Response.json({ error: quota ? "kota" : "youtube" }, { status: 502 });
  }
  const data = (await res.json()) as {
    items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url: string }> } }[];
  };
  const found = (data.items ?? []).filter((i) => i.id?.videoId);

  // Süreler ayrı bir çağrıda (1 birim, aramanın yanında önemsiz).
  const durations = new Map<string, string | null>();
  if (found.length) {
    const vids = new URL("https://www.googleapis.com/youtube/v3/videos");
    vids.search = new URLSearchParams({ part: "contentDetails", id: found.map((i) => i.id!.videoId!).join(","), key }).toString();
    const vr = await fetch(vids, { cache: "no-store" }).catch(() => null);
    if (vr?.ok) {
      const vd = (await vr.json()) as { items?: { id: string; contentDetails?: { duration?: string } }[] };
      for (const v of vd.items ?? []) durations.set(v.id, fmtDuration(v.contentDetails?.duration));
    }
  }

  const items: Item[] = found.map((i) => {
    const s = i.snippet ?? {};
    const id = i.id!.videoId!;
    return {
      id,
      title: decode(s.title ?? ""),
      channel: decode(s.channelTitle ?? ""),
      thumb: s.thumbnails?.medium?.url ?? s.thumbnails?.default?.url ?? `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      duration: durations.get(id) ?? null,
    };
  });
  return Response.json({ items }, { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } });
}
