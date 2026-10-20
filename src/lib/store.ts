// Sinyal kutusu: oda katılımcıları ve aralarındaki kısa ömürlü mesajlar.
// DATABASE_URL varsa Neon Postgres, yoksa (yerel geliştirme) bellek içi.

import { neon } from "@neondatabase/serverless";

export type Peer = { id: string; name: string };
export type Msg = { id: number; from: string; body: unknown };
// `last` yalnızca ilk yoklamada (after = null) döner: istemci oradan saymaya başlar.
// Sonraki yoklamalarda istemci geriye doğru biraz pay bırakır ve kimliğe göre tekilleştirir;
// böylece aynı anda yazılıp geç görünür olan mesajlar kaçmaz.
export type PollResult = { peers: Peer[]; msgs: Msg[]; last: number | null };

// Bu süre boyunca yoklama gelmeyen katılımcı odadan düşmüş sayılır.
const PRESENCE_MS = 10_000;

interface Store {
  poll(room: string, me: string, name: string, after: number | null): Promise<PollResult>;
  send(room: string, from: string, to: string, body: unknown): Promise<void>;
  leave(room: string, me: string): Promise<void>;
}

// ---------- bellek içi ----------

type MemRoom = { peers: Map<string, { name: string; seen: number }>; msgs: (Msg & { to: string; at: number })[] };

function memoryStore(): Store {
  const g = globalThis as unknown as { __pencere?: { rooms: Map<string, MemRoom>; seq: number } };
  g.__pencere ??= { rooms: new Map(), seq: 0 };
  const db = g.__pencere;

  const room = (code: string) => {
    let r = db.rooms.get(code);
    if (!r) db.rooms.set(code, (r = { peers: new Map(), msgs: [] }));
    return r;
  };

  return {
    async poll(code, me, name, after) {
      const r = room(code);
      const now = Date.now();
      r.peers.set(me, { name, seen: now });
      r.msgs = r.msgs.filter((m) => now - m.at < 10 * 60_000);
      const peers = [...r.peers]
        .filter(([id, p]) => id !== me && now - p.seen < PRESENCE_MS)
        .map(([id, p]) => ({ id, name: p.name }));
      if (after === null) return { peers, msgs: [], last: db.seq };
      const msgs = r.msgs
        .filter((m) => m.id > after && m.from !== me && (m.to === me || m.to === "*"))
        .map(({ id, from, body }) => ({ id, from, body }));
      return { peers, msgs, last: null };
    },
    async send(code, from, to, body) {
      room(code).msgs.push({ id: ++db.seq, from, to, body, at: Date.now() });
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
    ]).catch((e) => {
      ready = null;
      throw e;
    }));

  return {
    async poll(room, me, name, after) {
      await ensure();
      const presence = `${PRESENCE_MS / 1000} seconds`;
      const [, peers, msgs, last] = await sql.transaction([
        sql`insert into sig_peers (room, id, name) values (${room}, ${me}, ${name})
            on conflict (room, id) do update set name = excluded.name, seen = now()`,
        sql`select id, name from sig_peers
            where room = ${room} and id <> ${me} and seen > now() - ${presence}::interval`,
        after === null
          ? sql`select 1 where false`
          : sql`select id::int as id, sender as "from", body from sig_msgs
                where room = ${room} and id > ${after} and sender <> ${me}
                  and (target = ${me} or target = '*')
                order by id limit 200`,
        after === null ? sql`select coalesce(max(id), 0)::int as last from sig_msgs` : sql`select 1 where false`,
      ]);
      // Arada bir eski kayıtları süpür.
      if (Math.random() < 0.02) {
        void sql.transaction([
          sql`delete from sig_msgs where at < now() - interval '10 minutes'`,
          sql`delete from sig_peers where seen < now() - interval '1 hour'`,
        ]).catch(() => {});
      }
      return {
        peers: peers as Peer[],
        msgs: msgs as Msg[],
        last: after === null ? (last[0] as { last: number }).last : null,
      };
    },
    async send(room, from, to, body) {
      await ensure();
      await sql`insert into sig_msgs (room, sender, target, body)
                values (${room}, ${from}, ${to}, ${JSON.stringify(body)}::jsonb)`;
    },
    async leave(room, me) {
      await ensure();
      await sql`delete from sig_peers where room = ${room} and id = ${me}`;
    },
  };
}

let store: Store | null = null;
export function getStore(): Store {
  const url = process.env.DATABASE_URL;
  return (store ??= url ? neonStore(url) : memoryStore());
}
