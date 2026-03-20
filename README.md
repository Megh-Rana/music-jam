# Music Jam

Realtime group music queue with room codes, host-sync playback, and YouTube embed player.

## Stack

- Client: React + Vite
- Backend: Cloudflare Workers + Durable Objects

## Features

- Anonymous room create/join with short room code
- Shared queue: add/remove/reorder/mix
- Server-authoritative sync (host controls playback)
- URL/ID song add
- YouTube search + recommendations when `YOUTUBE_API_KEY` is set

## Local Dev

Backend:

```bash
cd server
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Frontend:

```bash
cd client
npm install
npm run dev
```

Set `VITE_SERVER_URL` in frontend env to Worker URL if needed.

## Deploy

- Backend (Cloudflare Workers): `cd server && npm run deploy`
  - Set secrets/vars in Cloudflare dashboard for each environment:
    - `YOUTUBE_API_KEY` (required for search/recommendations)
    - `ENABLE_YTDLP=false` on main
  - Project root for Git deploy: `server`
- Frontend (Vercel): deploy `client`
  - Set env `VITE_SERVER_URL` to the Worker URL (e.g. `https://music-jam-backend.<your>.workers.dev`)
  - Production/preview envs must each have the variable set

## Backend Vars

- `YOUTUBE_API_KEY` (optional but needed for search/recommendations)
- `ENABLE_YTDLP=false` on public/main branch
