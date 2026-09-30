# Nuke Wars — deployment

How the game gets from GitHub to the internet. Part 1 (the client on Vercel) is live since V1.5 Session 1; Part 2 (the WebSocket server on Railway) is written in Session 8.

## How it works today

- **Live site:** <https://nuke-wars.vercel.app/> (Vercel project `nuke-wars`).
- **Production:** every push (or merge) to `main` builds and deploys the site on Vercel. Nothing to run by hand.
- **Previews:** every pull request gets its own temporary copy of the site at a unique link. Vercel's bot posts it as a comment on the PR. Use it to try a change before merging.
- **CI:** GitHub Actions (`.github/workflows/ci.yml`) runs `npm run lint`, `npm test` and `npm run build` on every pull request and every push to `main`. A red ✗ on a PR means one failed; click **Details** to see which.
- The client is a plain static site (Vite builds it into `dist/`). CPU and hotseat run entirely in the player's browser.
- **The match server exists since Session 6 (`server/`, `npm run server`) but is not deployed yet.** Without `VITE_SERVER_URL` a production build hides the online button, so the live site is unaffected. Session 8 puts the server on Railway and sets that variable on Vercel. How to run it locally: `docs/protocol.md`, "Running it locally".

## Part 1 — the client on Vercel

### Settings (what the import screen should show)

| Setting | Value |
|---|---|
| Framework Preset | **Vite** (auto-detected) |
| Root Directory | `./` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | default (`npm install`) |
| Node.js version | 24.x (Project → Settings → Build and Deployment) |
| Environment variables | none yet (Session 8 adds the server URL) |

No `vercel.json` is needed: the game is one page with no URL routes.

### First-time import (done 2026-09-29)

1. Go to <https://vercel.com/new>.
2. Under **Import Git Repository**, find `nuke-wars` and click **Import**. If it isn't listed, click **Adjust GitHub App Permissions →**, choose **Only select repositories**, add `delement738/nuke-wars`, **Save**, and return to the Vercel tab.
3. Check the settings match the table above. Leave everything else alone.
4. Click **Deploy**. The build takes about a minute; then click the preview image to open the live game.
5. The production address is on the project's **Overview** page: <https://nuke-wars.vercel.app/>.

### If a deploy fails

Open the project → **Deployments** → the failed one → **Build Logs**. The same three commands CI runs will reproduce it locally: `npm ci && npm run build`.

### Rolling back

Project → **Deployments** → pick an older green deployment → **⋯** → **Promote to Production** (Vercel's "Instant Rollback"). Then fix `main` properly.

## Part 2 — the server on Railway

The match server (`server/`) runs on Railway as one always-on Node process. The browser talks to it over a WebSocket (`wss://…`); everything else about the site is still served by Vercel.

### What is in the repo

- **`railway.json`** is Railway's settings file, so they live in Git rather than only in the dashboard:
  - **Start command:** `node --import tsx server/main.ts`. It runs `node` directly rather than through `npm`, so Railway's stop signal reaches the server itself.
  - **Health check:** Railway opens `/health` and only switches traffic to a new deployment once that answers `ok`. A broken build therefore never replaces a working one.
  - **Restart** on a crash, up to 10 times.
  - **`watchPatterns`:** Railway redeploys only when a file the server uses changes (`server/`, `src/sim/`, `src/state/`, `src/net/`, the package files). This matters because **a redeploy ends every match in progress** (see "Things to know" below), so a change to the title screen shouldn't restart the server.
- **`package.json`** pins Node to `24.x` (`engines`, matching CI and Vercel), and lists `tsx` under `dependencies`, because the server needs it at run time.

### Settings (Railway → the service → **Variables**)

| Variable | Value | Why |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://nuke-wars.vercel.app,https://nuke-wars-*-TEAM.vercel.app` | Only pages from our site and its preview links may connect (`docs/protocol.md`, "Limits"). Replace `TEAM` with the end of any Vercel preview link's name, e.g. `delement738s-projects`. |
| `TRUST_PROXY` | `1` | The server sits behind Railway's proxy, so per-address limits must read the visitor's address from the header the proxy writes. |
| `PORT` | *(don't set it)* | Railway sets it itself. |

And on **Vercel** (project → **Settings** → **Environment Variables**):

| Variable | Value | Environments |
|---|---|---|
| `VITE_SERVER_URL` | `wss://` + the Railway domain, e.g. `wss://nuke-wars-server-production.up.railway.app` | Production **and** Preview |

A `VITE_` variable is baked into the page **when it is built**, so after adding or changing it the site must be **redeployed** before it takes effect.

### First-time setup

1. <https://railway.com/new> → **Deploy from GitHub repo** → pick `delement738/nuke-wars`. If it isn't listed, click **Configure GitHub App**, give Railway access to that repository, and come back.
2. Railway creates a service and starts building straight away. Let the first build fail or finish; the settings come next.
3. Click the service → **Settings**:
   - **Source → Branch:** `main`.
   - **Networking → Public Networking → Generate Domain.** If it asks for a port, leave the one it detected (the port the server printed). Copy the domain it shows.
4. **Variables** tab → add `ALLOWED_ORIGINS` and `TRUST_PROXY` as in the table above → **Deploy** (Railway shows a banner to apply the changes).
5. When the deployment turns green, open `https://<the domain>/health` in a browser. It should say `ok`.
6. On Vercel, add `VITE_SERVER_URL` (table above), then **Deployments** → the latest production one → **⋯** → **Redeploy**.
7. Open <https://nuke-wars.vercel.app/>. The title screen now has **Play online**. Create a room and open the link in a second window (or send it to a friend).

### Day to day

- **Deploys:** merging a change to a server file into `main` redeploys Railway on its own. The new copy starts, passes `/health`, takes the traffic, and then the old copy is stopped.
- **Logs:** the service → **Deployments** → the active one → **View Logs** (or the **Observability** tab). Every line starts with a time. A `stats:` line every 5 minutes shows rooms, connections and every kind of refusal since the server started. A server that is quietly being abused shows up there as climbing refusal counts.
- **Rolling back:** **Deployments** → an older green one → **⋯** → **Redeploy**. Then fix `main`.

### Things to know

- **A redeploy, restart or crash ends every match in progress.** Rooms live only in the server's memory. Players see "That room does not exist, or has closed." Keeping matches across restarts would need a database; that's a deliberate V1.5 limit.
- **One server, one process.** Two copies would each hold different rooms, and a link to a room on the other copy would fail. So don't raise Railway's replica count above 1.
- **Cost:** Railway bills by usage. An idle Node process with a handful of matches uses very little; check **Usage** in the account menu after the first week.
