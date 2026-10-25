// Sinyal kutusu: oda katılımcıları, aralarındaki kısa ömürlü mesajlar ve oda ayarları (kilit, şifre).
// Canlıda Neon Postgres, yerel geliştirmede bellek içi (bkz. getStore).

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";

export type Peer = { id: string; name: string };
export type Msg = { id: number; from: string; body: unknown };
export type RoomInfo = { locked: boolean; password: boolean };
// `last` yalnızca ilk yoklamada (after = null) döner: istemci oradan saymaya başlar.
// Sonraki yoklamalarda istemci geriye doğru biraz pay bırakır ve kimliğe göre tekilleştirir;
// böylece aynı anda yazılıp geç görünür olan mesajlar kaçmaz.
export type PollResult = { peers: Peer[]; msgs: Msg[]; last: number | null; room: RoomInfo };
// sifre: şifre gerekli/yanlış · kilitli: oda kilitli · uye: odada kaydın yok (yeniden katıl)
export type Denied = { denied: "sifre" | "kilitli" | "uye" };

// Bu süre boyunca yoklama gelmeyen katılımcı odadan düşmüş sayılır.
const PRESENCE_MS = 10_000;

interface Store {
  info(room: string): Promise<RoomInfo>;
  checkKey(room: string, key: string): Promise<boolean>;
  poll(room: string, me: string, name: string, after: number | null, key: string): Promise<PollResult | Denied>;
  send(room: string, from: string, to: string, body: unknown): Promise<boolean>;
  configure(room: string, me: string, change: { locked?: boolean; password?: string | null }): Promise<RoomInfo | null>;
  leave(room: string, me: string): Promise<void>;
}

// ---------- şifre ----------

function hashKey(key: string) {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(key, salt, 32).toString("hex")}`;
}

function keyMatches(stored: string | null, key: string) {
  if (!stored) return true;
  const [salt, hash] = stored.split(":");
  const got = scryptSync(key, Buffer.from(salt, "hex"), 32);
  return timingSafeEqual(got, Buffer.from(hash, "hex"));
}

// Yeni gelen biri girebilir mi? Kilit, oda boşaldıysa kendiliğinden düşer.
function admit(settings: { locked: boolean; pass: string | null }, othersPresent: number, key: string): Denied | null {
  if (settings.locked && othersPresent > 0) return { denied: "kilitli" };
  if (!keyMatches(settings.pass, key)) return { denied: "sifre" };
  return null;
}

// ---------- bellek içi ----------

type MemRoom = {
  peers: Map<string, { name: string; seen: number }>;
  msgs: (Msg & { to: string; at: number })[];
  locked: boolean;
  pass: string | null;
};

function memoryStore(): Store {
  const g = globalThis as unknown as { __pencere?: { rooms: Map<string, MemRoom>; seq: number } };
  g.__pencere ??= { rooms: new Map(), seq: 0 };
  const db = g.__pencere;

  const room = (code: string) => {
    let r = db.rooms.get(code);
    if (!r) db.rooms.set(code, (r = { peers: new Map(), msgs: [], locked: false, pass: null }));
    return r;
  };
  const present = (r: MemRoom, except: string) =>
    [...r.peers].filter(([id, p]) => id !== except && Date.now() - p.seen < PRESENCE_MS).length;
  const infoOf = (r: MemRoom): RoomInfo => ({ locked: r.locked && present(r, "") > 0, password: !!r.pass });

  return {
    async info(code) {
      return infoOf(room(code));
    },
    async checkKey(code, key) {
      return keyMatches(room(code).pass, key);
    },
    async poll(code, me, name, after, key) {
      const r = room(code);
      const now = Date.now();
      if (!r.peers.has(me)) {
        if (after !== null) return { denied: "uye" };
        const others = present(r, me);
        if (others === 0) r.locked = false;
        const no = admit(r, others, key);
        if (no) return no;
      }
      r.peers.set(me, { name, seen: now });
      r.msgs = r.msgs.filter((m) => now - m.at < 10 * 60_000);
      const peers = [...r.peers]
        .filter(([id, p]) => id !== me && now - p.seen < PRESENCE_MS)
        .map(([id, p]) => ({ id, name: p.name }));
      if (after === null) return { peers, msgs: [], last: db.seq, room: infoOf(r) };
      const msgs = r.msgs
        .filter((m) => m.id > after && m.from !== me && (m.to === me || m.to === "*"))
        .map(({ id, from, body }) => ({ id, from, body }));
      return { peers, msgs, last: null, room: infoOf(r) };
    },
    async send(code, from, to, body) {
      const r = room(code);
      if (!r.peers.has(from)) return false;
      r.msgs.push({ id: ++db.seq, from, to, body, at: Date.now() });
      return true;
    },
    async configure(code, me, change) {
      const r = room(code);
      if (!r.peers.has(me)) return null;
      if (change.locked !== undefined) r.locked = change.locked;
      if (change.password !== undefined) r.pass = change.password ? hashKey(change.password) : null;
      return infoOf(r);
    },
    async leave(code, me) {
      room(code).peers.delete(me);
    },
  };
}

// ---------- Neon ----------

function neonStore(url: string): Store {
  const sql = neon(url);
  let ready: Promise<unknown> | null = null;
  const ensure = () =>
    (ready ??= sql.transaction([
      sql`create table if not exists sig_peers (
            room text not null, id text not null, name text not null,
            seen timestamptz not null default now(), primary key (room, id))`,
      sql`create table if not exists sig_msgs (
            id bigserial primary key, room text not null, sender text not null,
            target text not null, body jsonb not null, at timestamptz not null default now())`,
      sql`create index if not exists sig_msgs_room_id on sig_msgs (room, id)`,
      sql`create table if not exists sig_rooms (
            room text primary key, locked boolean not null default false, pass text,
            updated timestamptz not null default now())`,
    ]).catch((e) => {
      ready = null;
      throw e;
    }));
  const presence = `${PRESENCE_MS / 1000} seconds`;

  type Settings = { locked: boolean; pass: string | null };
  const settingsOf = (rows: unknown[]): Settings => (rows[0] as Settings | undefined) ?? { locked: false, pass: null };

  // Kilidin anlamı "içeride biri varken yeni giriş yok": oda boşsa kilitli sayılmaz.
  const roomInfo = async (room: string): Promise<RoomInfo> => {
    const [rows, count] = await sql.transaction([
      sql`select locked, pass from sig_rooms where room = ${room}`,
      sql`select count(*)::int as n from sig_peers where room = ${room} and seen > now() - ${presence}::interval`,
    ]);
    const s = settingsOf(rows);
    return { locked: s.locked && (count[0] as { n: number }).n > 0, password: !!s.pass };
  };

  return {
    async info(room) {
      await ensure();
      return roomInfo(room);
    },
    async checkKey(room, key) {
      await ensure();
      const rows = await sql`select locked, pass from sig_rooms where room = ${room}`;
      return keyMatches(settingsOf(rows).pass, key);
    },
    async poll(room, me, name, after, key) {
      await ensure();
      if (after === null) {
        // İlk yoklama: odaya kabul. Zaten üyeyse (sayfa yenilemesi gibi) kontrol atlanır.
        const [member, rows, count] = await sql.transaction([
          sql`select 1 from sig_peers where room = ${room} and id = ${me}`,
          sql`select locked, pass from sig_rooms where room = ${room}`,
          sql`select count(*)::int as n from sig_peers
              where room = ${room} and id <> ${me} and seen > now() - ${presence}::interval`,
        ]);
        if (member.length === 0) {
          const others = (count[0] as { n: number }).n;
          const s = settingsOf(rows);
          if (s.locked && others === 0) await sql`update sig_rooms set locked = false where room = ${room}`;
          const no = admit({ ...s, locked: s.locked && others > 0 }, others, key);
          if (no) return no;
        }
      }

      const [touched, peers, msgs, last, rows] = await sql.transaction([
        after === null
          ? sql`insert into sig_peers (room, id, name) values (${room}, ${me}, ${name})
                on conflict (room, id) do update set name = excluded.name, seen = now() returning 1`
          : sql`update sig_peers set name = ${name}, seen = now() where room = ${room} and id = ${me} returning 1`,
        sql`select id, name from sig_peers
            where room = ${room} and id <> ${me} and seen > now() - ${presence}::interval`,
        after === null
          ? sql`select 1 where false`
          : sql`select id::int as id, sender as "from", body from sig_msgs
                where room = ${room} and id > ${after} and sender <> ${me}
                  and (target = ${me} or target = '*')
                order by id limit 200`,
        after === null ? sql`select coalesce(max(id), 0)::int as last from sig_msgs` : sql`select 1 where false`,
        sql`select locked, pass from sig_rooms where room = ${room}`,
      ]);
      if (touched.length === 0) return { denied: "uye" };
      const s = settingsOf(rows);
      // Arada bir eski kayıtları süpür.
      if (Math.random() < 0.02) {
        void sql.transaction([
          sql`delete from sig_msgs where at < now() - interval '10 minutes'`,
          sql`delete from sig_peers where seen < now() - interval '1 hour'`,
          sql`delete from sig_rooms r where updated < now() - interval '1 day'
              and not exists (select 1 from sig_peers p where p.room = r.room)`,
        ]).catch(() => {});
      }
      return {
        peers: peers as Peer[],
        msgs: msgs as Msg[],
        last: after === null ? (last[0] as { last: number }).last : null,
        // Yoklayan kişi odada olduğu için oda boş değil: kilit olduğu gibi geçerli.
        room: { locked: s.locked, password: !!s.pass },
      };
    },
    async send(room, from, to, body) {
      await ensure();
      // Yalnızca odadaki biri mesaj bırakabilir.
      const rows = await sql`insert into sig_msgs (room, sender, target, body)
                select ${room}, ${from}, ${to}, ${JSON.stringify(body)}::jsonb
                where exists (select 1 from sig_peers where room = ${room} and id = ${from})
                returning id`;
      return rows.length > 0;
    },
    async configure(room, me, change) {
      await ensure();
      const member = await sql`select 1 from sig_peers where room = ${room} and id = ${me}`;
      if (member.length === 0) return null;
      const s = settingsOf(await sql`select locked, pass from sig_rooms where room = ${room}`);
      const locked = change.locked ?? s.locked;
      const pass = change.password === undefined ? s.pass : change.password ? hashKey(change.password) : null;
      await sql`insert into sig_rooms (room, locked, pass, updated) values (${room}, ${locked}, ${pass}, now())
                on conflict (room) do update set locked = excluded.locked, pass = excluded.pass, updated = now()`;
      return roomInfo(room);
    },
    async leave(room, me) {
      await ensure();
      await sql`delete from sig_peers where room = ${room} and id = ${me}`;
    },
  };
}

let store: Store | null = null;
export function getStore(): Store {
  // Canlıda sinyal veritabanı (SIG_), yoksa eski DATABASE_URL.
  // Yerel geliştirme ve testler canlı veritabanına DOKUNMAZ: Neon'un ücretsiz planı uyanık kalınan
  // süreyi sayıyor, uzun testler kotayı bitirmişti. Bilerek denemek için USE_REMOTE_DB=1.
  const remote = process.env.NODE_ENV === "production" || process.env.USE_REMOTE_DB === "1";
  const url = remote ? (process.env.SIG_DATABASE_URL ?? process.env.DATABASE_URL) : undefined;
  return (store ??= url ? neonStore(url) : memoryStore());
}
