// VEXORA Worker: serves ./public and a real JSON API backed by D1 (binding "DB").
// The database tables are created automatically (see SCHEMA + ensureSchema below),
// so nothing has to be run by hand in the D1 console.
// There is no login yet: each device gets a random id (X-User-Id) and a display name.

// ---------------------------------------------------------------------------
// DATABASE SCHEMA (all tables). Safe to run many times: IF NOT EXISTS.
// ---------------------------------------------------------------------------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_name TEXT NOT NULL,
    body TEXT, image TEXT, feeling TEXT,
    shares INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY, post_id TEXT NOT NULL, user_id TEXT NOT NULL,
    user_name TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reactions (
    post_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL,
    PRIMARY KEY (post_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS bookmarks (
    user_id TEXT NOT NULL, post_id TEXT NOT NULL, PRIMARY KEY (user_id, post_id))`,
  `CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_name TEXT NOT NULL,
    text TEXT NOT NULL, g INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL,
    created_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_created ON posts (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications (user_id, created_at DESC)`,
];

// Creates the tables on the first request after a deploy (once per Worker instance).
let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = (async () => {
      // The very first draft used different (never used, empty) tables. Replace them if found.
      const info = await db.prepare("SELECT name FROM pragma_table_info('posts')").all();
      const cols = info.results.map((c) => c.name);
      if (cols.length && !cols.includes("user_name")) {
        await db.batch(["users", "posts", "comments", "reactions"].map((t) => db.prepare(`DROP TABLE IF EXISTS ${t}`)));
      }
      await db.batch(SCHEMA.map((q) => db.prepare(q)));
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

const HDR = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: HDR });
const fail = (m, s = 400) => json({ error: "error", message: m }, s);
const uuid = () => crypto.randomUUID();

async function api(request, env, url) {
  const db = env.DB;
  if (!db) return fail("Database is not connected.", 501);
  await ensureSchema(db);
  const uid = /^[0-9a-f-]{20,40}$/i.test(request.headers.get("X-User-Id") || "") ? request.headers.get("X-User-Id") : null;
  let name = "";
  try { name = decodeURIComponent(request.headers.get("X-User-Name") || "").trim().slice(0, 30); } catch (e) {}
  const [, res, rid, sub] = url.pathname.split("/").filter(Boolean);
  const m = request.method;
  let body = {};
  if (m === "POST") { try { body = await request.json(); } catch (e) {} }
  const needUser = () => (uid && name ? null : fail("Choose a name first.", 401));
  const notify = (to, text) => db.prepare("INSERT INTO notifications (id,user_id,text,created_at,read) VALUES (?1,?2,?3,?4,0)").bind(uuid(), to, text, Date.now());

  if (res === "posts" && !rid) {
    if (m === "GET") {
      const { results } = await db.prepare(
        `SELECT p.id, p.user_id, p.user_name, p.body, p.image, p.feeling, p.shares, p.created_at,
          (SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id AND r.kind='l') AS l,
          (SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id AND r.kind='h') AS h,
          (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS cn,
          (SELECT kind FROM reactions r WHERE r.post_id=p.id AND r.user_id=?1) AS me,
          EXISTS(SELECT 1 FROM bookmarks b WHERE b.post_id=p.id AND b.user_id=?1) AS sv
         FROM posts p ORDER BY p.created_at DESC LIMIT 50`).bind(uid || "").all();
      return json({ posts: results });
    }
    if (m === "POST") {
      const e = needUser(); if (e) return e;
      const text = String(body.body || "").trim().slice(0, 1000);
      const image = body.image || null;
      const feeling = body.feeling ? String(body.feeling).slice(0, 30) : null;
      if (!text && !image) return fail("Write something or add a photo.");
      if (image && (image.length > 450000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image))) return fail("Photo is too large or not valid.");
      const post = { id: uuid(), user_id: uid, user_name: name, body: text, image, feeling, shares: 0, created_at: Date.now() };
      await db.prepare("INSERT INTO posts (id,user_id,user_name,body,image,feeling,shares,created_at) VALUES (?1,?2,?3,?4,?5,?6,0,?7)")
        .bind(post.id, uid, name, text, image, feeling, post.created_at).run();
      return json({ post: { ...post, l: 0, h: 0, cn: 0, me: null, sv: 0 } });
    }
  }

  if (res === "posts" && rid) {
    const post = await db.prepare("SELECT user_id FROM posts WHERE id=?1").bind(rid).first();
    if (!post) return fail("Post not found.", 404);
    if (m === "DELETE") {
      if (post.user_id !== uid) return fail("You can only delete your own posts.", 403);
      await db.batch([
        db.prepare("DELETE FROM comments WHERE post_id=?1").bind(rid), db.prepare("DELETE FROM reactions WHERE post_id=?1").bind(rid),
        db.prepare("DELETE FROM bookmarks WHERE post_id=?1").bind(rid), db.prepare("DELETE FROM posts WHERE id=?1").bind(rid)]);
      return json({ ok: true });
    }
    if (sub === "comments" && m === "GET") {
      const { results } = await db.prepare("SELECT user_name AS u, body AS x FROM comments WHERE post_id=?1 ORDER BY created_at ASC LIMIT 200").bind(rid).all();
      return json({ comments: results });
    }
    if (m === "POST") {
      if (sub === "share") {
        if (!uid) return fail("Unknown device.", 401);
        await db.prepare("UPDATE posts SET shares=shares+1 WHERE id=?1").bind(rid).run();
        const r = await db.prepare("SELECT shares FROM posts WHERE id=?1").bind(rid).first();
        return json({ shares: r.shares });
      }
      const e = needUser(); if (e) return e;
      if (sub === "react") {
        const kind = body.kind;
        if (kind !== null && kind !== "l" && kind !== "h") return fail("Invalid reaction.");
        const st = [kind
          ? db.prepare("INSERT OR REPLACE INTO reactions (post_id,user_id,kind) VALUES (?1,?2,?3)").bind(rid, uid, kind)
          : db.prepare("DELETE FROM reactions WHERE post_id=?1 AND user_id=?2").bind(rid, uid)];
        if (kind && post.user_id !== uid) st.push(notify(post.user_id, `${name} reacted ${kind === "h" ? "❤️" : "👍"} to your post`));
        await db.batch(st);
        const c = await db.prepare("SELECT COALESCE(SUM(kind='l'),0) AS l, COALESCE(SUM(kind='h'),0) AS h FROM reactions WHERE post_id=?1").bind(rid).first();
        return json({ l: c.l, h: c.h, me: kind });
      }
      if (sub === "comments") {
        const text = String(body.body || "").trim().slice(0, 300);
        if (!text) return fail("Write a comment first.");
        const st = [db.prepare("INSERT INTO comments (id,post_id,user_id,user_name,body,created_at) VALUES (?1,?2,?3,?4,?5,?6)").bind(uuid(), rid, uid, name, text, Date.now())];
        if (post.user_id !== uid) st.push(notify(post.user_id, `${name} commented on your post`));
        await db.batch(st);
        return json({ comment: { u: name, x: text } });
      }
      if (sub === "bookmark") {
        await (body.on
          ? db.prepare("INSERT OR IGNORE INTO bookmarks (user_id,post_id) VALUES (?1,?2)").bind(uid, rid)
          : db.prepare("DELETE FROM bookmarks WHERE user_id=?1 AND post_id=?2").bind(uid, rid)).run();
        return json({ sv: !!body.on });
      }
    }
  }

  if (res === "stories") {
    if (m === "GET") {
      const { results } = await db.prepare("SELECT id, user_name, text, g FROM stories WHERE created_at>?1 ORDER BY created_at DESC LIMIT 30").bind(Date.now() - 864e5).all();
      return json({ stories: results });
    }
    if (m === "POST") {
      const e = needUser(); if (e) return e;
      const text = String(body.text || "").trim().slice(0, 120), g = Number(body.g);
      if (!text) return fail("Write something first.");
      await db.prepare("INSERT INTO stories (id,user_id,user_name,text,g,created_at) VALUES (?1,?2,?3,?4,?5,?6)")
        .bind(uuid(), uid, name, text, g >= 0 && g <= 4 ? g : 0, Date.now()).run();
      return json({ ok: true });
    }
  }

  if (res === "notifications") {
    if (!uid) return json({ notifications: [], unread: 0 });
    if (m === "GET") {
      const { results } = await db.prepare("SELECT id, text, created_at, read FROM notifications WHERE user_id=?1 ORDER BY created_at DESC LIMIT 30").bind(uid).all();
      return json({ notifications: results, unread: results.filter((n) => !n.read).length });
    }
    if (m === "POST" && rid === "read") {
      await db.prepare("UPDATE notifications SET read=1 WHERE user_id=?1").bind(uid).run();
      return json({ ok: true });
    }
  }
  return fail("Not found.", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      let database = "not_configured", posts = "not_configured";
      if (env.DB) {
        try { await ensureSchema(env.DB); } catch (e) {}
        try { await env.DB.prepare("SELECT 1").first(); database = "connected"; } catch (e) { database = "error"; }
        try { await env.DB.prepare("SELECT 1 FROM posts LIMIT 1").first(); posts = "ready"; } catch (e) { posts = "tables_missing"; }
      }
      return json({ ok: true, app: "VEXORA", time: new Date().toISOString(), services: { auth: "not_configured", database, posts, storage: "not_configured" } });
    }
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env, url); }
      catch (e) { return fail(/no such table/i.test(String(e.message)) ? "Database tables are missing. Run schema.sql in the D1 console first." : "Server error.", 500); }
    }
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Referrer-Policy", "strict-origin-when-cross-origin");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  },
};
