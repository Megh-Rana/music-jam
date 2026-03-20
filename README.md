# Music Jam

Realtime group music queue with room codes, shared playback sync, and YouTube embed player.

## Features

- Anonymous room create/join with 6-char code
- Shared queue: add, remove, reorder, mix
- Host-authoritative playback sync for all listeners
- URL/ID song add via YouTube resolve
- Search + recommendations when `YOUTUBE_API_KEY` is configured

## Stack

- Client: React + Vite + socket.io-client
- Server: Node.js + Express + Socket.io

## Run locally

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

```bash
cd client
npm install
npm run dev
```

Client defaults to `http://localhost:4000`.

To use a deployed backend, set `VITE_SERVER_URL` in client env.

## Env

Server (`server/.env`):

- `PORT=4000`
- `YOUTUBE_API_KEY=...` (optional but needed for search/recommendations)
- `ENABLE_YTDLP=false`

## yt-dlp branch notes

On branch `yt-dlp`, set `ENABLE_YTDLP=true` and make sure `yt-dlp` is installed on the server machine. This mode is intended for personal/private use.
