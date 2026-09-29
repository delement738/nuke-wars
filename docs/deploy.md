# Nuke Wars — deployment

How the game gets from GitHub to the internet. Part 1 (the client on Vercel) is live since V1.5 Session 1; Part 2 (the WebSocket server on Railway) is written in Session 8.

## How it works today

- **Production:** every push (or merge) to `main` builds and deploys the site on Vercel. Nothing to run by hand.
- **Previews:** every pull request gets its own temporary copy of the site at a unique link. Vercel's bot posts it as a comment on the PR. Use it to try a change before merging.
- **CI:** GitHub Actions (`.github/workflows/ci.yml`) runs `npm run lint`, `npm test` and `npm run build` on every pull request and every push to `main`. A red ✗ on a PR means one failed; click **Details** to see which.
- The client is a plain static site (Vite builds it into `dist/`). There is no server yet, so CPU and hotseat run entirely in the player's browser.

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
5. The production address is on the project's **Overview** page (`https://<project>.vercel.app`).

### If a deploy fails

Open the project → **Deployments** → the failed one → **Build Logs**. The same three commands CI runs will reproduce it locally: `npm ci && npm run build`.

### Rolling back

Project → **Deployments** → pick an older green deployment → **⋯** → **Promote to Production** (Vercel's "Instant Rollback"). Then fix `main` properly.

## Part 2 — the server on Railway

*Written in Session 8.* Will cover: the Railway service, its start command, the environment variable that tells the Vercel client where the server is, health checks, and logs.
