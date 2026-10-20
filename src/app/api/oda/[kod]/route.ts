import { getStore } from "@/lib/store";

// Protokol (Android uygulaması da aynısını konuşur), hepsi POST JSON:
//   { t: "poll",  me, name, after }  -> { peers: [{id,name}], msgs: [{id,from,body}], last }
//   { t: "send",  me, to, body }     -> { ok: true }   (to = "*" herkese)
//   { t: "leave", me }               -> { ok: true }

const ROOM = /^[a-z0-9-]{3,40}$/;
const ID = /^[A-Za-z0-9_-]{6,40}$/;

export async function POST(req: Request, ctx: RouteContext<"/api/oda/[kod]">) {
  const { kod } = await ctx.params;
  if (!ROOM.test(kod)) return Response.json({ error: "oda" }, { status: 400 });

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return Response.json({ error: "json" }, { status: 400 });
  }
  const me = String(b.me ?? "");
  if (!ID.test(me)) return Response.json({ error: "me" }, { status: 400 });

  const store = getStore();
  switch (b.t) {
    case "poll": {
      const name = String(b.name ?? "").slice(0, 40) || "Misafir";
      const after = typeof b.after === "number" ? b.after : null;
      return Response.json(await store.poll(kod, me, name, after));
    }
    case "send": {
      const to = String(b.to ?? "");
      if (to !== "*" && !ID.test(to)) return Response.json({ error: "to" }, { status: 400 });
      const body = JSON.stringify(b.body ?? null);
      if (body.length > 64_000) return Response.json({ error: "büyük" }, { status: 413 });
      await store.send(kod, me, to, b.body);
      return Response.json({ ok: true });
    }
    case "leave":
      await store.leave(kod, me);
      return Response.json({ ok: true });
    default:
      return Response.json({ error: "t" }, { status: 400 });
  }
}
