// VEXORA — Cloudflare Worker
// Serves the static app from ./public and exposes a small /api surface.
// No database, auth or storage is connected yet; those routes say so honestly.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        app: "VEXORA",
        time: new Date().toISOString(),
        services: { auth: "not_configured", database: "not_configured", storage: "not_configured" },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "not_configured", message: "This backend feature is not connected yet." }, 501);
    }

    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
