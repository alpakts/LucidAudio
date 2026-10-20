import { getStore } from "@/lib/store";

// Protokol (Android uygulaması da aynısını konuşur), hepsi POST JSON:
//   { t: "info" }                          -> { locked, password }          (girmeden önce)
//   { t: "check", key }                    -> { ok }                        (şifre doğru mu)
//   { t: "poll",  me, name, after, key? }  -> { peers: [{id,name}], msgs: [{id,from,body}], last, room: {locked,password} }
//                                             ya da 403 { denied: "sifre" | "kilitli" | "uye" }
//   { t: "send",  me, to, body }           -> { ok: true }   (to = "*" herkese; odada değilsen 403)
//   { t: "config", me, locked?, password? } -> { room }       (password: null kaldırır)
//   { t: "leave", me }                     -> { ok: true }

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
  const store = getStore();
  const key = typeof b.key === "string" ? b.key.slice(0, 200) : "";

  if (b.t === "info") return Response.json(await store.info(kod));
  if (b.t === "check") return Response.json({ ok: await store.checkKey(kod, key) });

  const me = String(b.me ?? "");
  if (!ID.test(me)) return Response.json({ error: "me" }, { status: 400 });

  switch (b.t) {
    case "poll": {
      const name = String(b.name ?? "").slice(0, 40) || "Misafir";
      const after = typeof b.after === "number" ? b.after : null;
      const res = await store.poll(kod, me, name, after, key);
      return Response.json(res, { status: "denied" in res ? 403 : 200 });
    }
    case "send": {
      const to = String(b.to ?? "");
      if (to !== "*" && !ID.test(to)) return Response.json({ error: "to" }, { status: 400 });
      const body = JSON.stringify(b.body ?? null);
      if (body.length > 64_000) return Response.json({ error: "büyük" }, { status: 413 });
      const ok = await store.send(kod, me, to, b.body);
      return Response.json({ ok }, { status: ok ? 200 : 403 });
    }
    case "config": {
      const change: { locked?: boolean; password?: string | null } = {};
      if (typeof b.locked === "boolean") change.locked = b.locked;
      if (b.password === null) change.password = null;
      else if (typeof b.password === "string") {
        const pw = b.password.trim();
        if (pw.length < 4 || pw.length > 100) return Response.json({ error: "şifre 4-100 karakter" }, { status: 400 });
        change.password = pw;
      }
      const room = await store.configure(kod, me, change);
      return room ? Response.json({ room }) : Response.json({ denied: "uye" }, { status: 403 });
    }
    case "leave":
      await store.leave(kod, me);
      return Response.json({ ok: true });
    default:
      return Response.json({ error: "t" }, { status: 400 });
  }
}
