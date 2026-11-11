# VEXORA — Connect Beyond Limits.

Social networking app. **Stage 1: Home page only** (bottom navigation comes next).

## Structure
```
public/index.html   The whole Home page (HTML + CSS + JS)
src/worker.js       Cloudflare Worker: serves the app + /api routes
wrangler.toml       Cloudflare config
package.json        Scripts and Wrangler
```

## Test locally
```
npm install
npm run dev
```
Open the address Wrangler prints. You can also open `public/index.html` directly in a browser.

## Deploy (GitHub → Cloudflare)
1. Push these files to a GitHub repository, keeping the folder structure.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository** → pick the repo.
3. Build command: leave empty. Deploy command: `npx wrangler deploy`.
4. Deploy, then open the `*.workers.dev` address.

## What works now
Stories (view, create), create post (text, photo, video, feeling, visibility), feed, like/love, comments, share, bookmarks, post menu, search, notifications panel, toasts, loading skeletons.

## What is demo only
- Posts, comments and reactions are saved **in the browser (localStorage)** on the device, not on a server. Videos are not kept after a reload.
- Sample people, posts and notifications are placeholder content.
- `/api/health` reports auth, database and storage as `not_configured`. Connect them (for example Firebase or Cloudflare D1/R2) in the next stages.
