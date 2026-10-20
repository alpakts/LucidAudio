// Tarayıcıya verilecek STUN/TURN listesi.
// TURN, iki taraf doğrudan bağlanamadığında (mobil operatör CGNAT'ı vb.) görüntüyü taşır.
//   Cloudflare:  CF_TURN_KEY_ID + CF_TURN_API_TOKEN  (kısa ömürlü kimlik üretir)
//   Genel:       TURN_URLS (virgülle) + TURN_USERNAME + TURN_CREDENTIAL

export const dynamic = "force-dynamic";

type IceServer = { urls: string | string[]; username?: string; credential?: string };

const STUN: IceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];

async function cloudflare(): Promise<IceServer[]> {
  const id = process.env.CF_TURN_KEY_ID;
  const token = process.env.CF_TURN_API_TOKEN;
  if (!id || !token) return [];
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: 6 * 3600 }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`cloudflare turn ${res.status}`);
  const data = (await res.json()) as { iceServers: IceServer | IceServer[] };
  const list = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
  // 53 numaralı port bazı tarayıcılarda engelli, gereksiz deneme yapmasın.
  return list.map((s) => ({
    ...s,
    urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !u.includes(":53")),
  }));
}

function generic(): IceServer[] {
  const urls = process.env.TURN_URLS;
  if (!urls) return [];
  return [{ urls: urls.split(",").map((u) => u.trim()), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }];
}

export async function GET() {
  let turn: IceServer[] = [];
  try {
    turn = [...(await cloudflare()), ...generic()];
  } catch (e) {
    console.error(e);
    turn = generic();
  }
  return Response.json({ iceServers: [...STUN, ...turn], turn: turn.length > 0 }, { headers: { "Cache-Control": "no-store" } });
}
