import { customAlphabet } from 'nanoid'

const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6)

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  })
}

function parseVideoId(input) {
  if (!input) return null
  const trimmed = input.trim()
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed
  try {
    const url = new URL(trimmed)
    if (url.hostname.includes('youtu.be')) {
      const id = url.pathname.slice(1)
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null
    }
    const v = url.searchParams.get('v')
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] === 'shorts' && parts[1] && /^[a-zA-Z0-9_-]{11}$/.test(parts[1])) return parts[1]
  } catch {
    return null
  }
  return null
}

async function fetchVideoById(videoId, apiKey) {
  if (apiKey) {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos')
    url.searchParams.set('key', apiKey)
    url.searchParams.set('id', videoId)
    url.searchParams.set('part', 'snippet')
    const res = await fetch(url)
    const data = await res.json()
    const item = data.items?.[0]
    if (!item) return null
    return {
      videoId,
      title: item.snippet.title,
      thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
    }
  }

  const url = new URL('https://www.youtube.com/oembed')
  url.searchParams.set('url', `https://www.youtube.com/watch?v=${videoId}`)
  url.searchParams.set('format', 'json')
  const res = await fetch(url)
  const data = await res.json()
  return { videoId, title: data.title, thumbnail: data.thumbnail_url || '' }
}

async function fetchRecommendations(videoId, apiKey) {
  const relatedUrl = new URL('https://www.googleapis.com/youtube/v3/search')
  relatedUrl.searchParams.set('key', apiKey)
  relatedUrl.searchParams.set('part', 'snippet')
  relatedUrl.searchParams.set('type', 'video')
  relatedUrl.searchParams.set('relatedToVideoId', videoId)
  relatedUrl.searchParams.set('maxResults', '6')
  const relatedRes = await fetch(relatedUrl)
  if (relatedRes.ok) {
    const relatedData = await relatedRes.json()
    const relatedItems = (relatedData.items || []).map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
    }))
    if (relatedItems.length > 0) return relatedItems
  }

  const source = await fetchVideoById(videoId, apiKey)
  if (!source?.title) return []
  const queryUrl = new URL('https://www.googleapis.com/youtube/v3/search')
  queryUrl.searchParams.set('key', apiKey)
  queryUrl.searchParams.set('part', 'snippet')
  queryUrl.searchParams.set('type', 'video')
  queryUrl.searchParams.set('q', `${source.title} music`)
  queryUrl.searchParams.set('maxResults', '6')
  const queryRes = await fetch(queryUrl)
  if (!queryRes.ok) return []
  const queryData = await queryRes.json()
  return (queryData.items || [])
    .map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
    }))
    .filter((item) => item.videoId !== videoId)
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return json({ ok: true })
    const url = new URL(request.url)

    if (url.pathname === '/health') return json({ ok: true })
    if (url.pathname === '/config') {
      return json({ searchEnabled: Boolean(env.YOUTUBE_API_KEY), extractionEnabled: Boolean(env.ENABLE_YTDLP === 'true') })
    }

    if (url.pathname === '/api/room/create' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}))
      const roomCode = nanoid()
      const clientId = crypto.randomUUID()
      const mode = body.mode === 'extract' && env.ENABLE_YTDLP === 'true' ? 'extract' : 'embed'
      const id = env.ROOM_DO.idFromName(roomCode)
      const stub = env.ROOM_DO.get(id)
      const res = await stub.fetch('https://room.internal/init', {
        method: 'POST',
        body: JSON.stringify({ roomCode, name: String(body.name || 'Guest').slice(0, 24), clientId, mode }),
      })
      const data = await res.json()
      return json({ ok: true, roomCode, clientId, room: data.room })
    }

    if (url.pathname === '/api/room/join' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}))
      const roomCode = String(body.roomCode || '').toUpperCase()
      if (!roomCode) return json({ ok: false, error: 'Missing room code' }, 400)
      const id = env.ROOM_DO.idFromName(roomCode)
      const stub = env.ROOM_DO.get(id)
      const existsRes = await stub.fetch('https://room.internal/exists')
      const exists = await existsRes.json()
      if (!exists.exists) return json({ ok: false, error: 'Room not found' }, 404)
      return json({ ok: true, roomCode, clientId: crypto.randomUUID() })
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket upgrade required' }, 426)
      const roomCode = url.searchParams.get('roomCode')
      if (!roomCode) return json({ error: 'Missing roomCode' }, 400)
      const id = env.ROOM_DO.idFromName(roomCode.toUpperCase())
      const stub = env.ROOM_DO.get(id)
      return stub.fetch(request)
    }

    if (url.pathname === '/api/search' && request.method === 'GET') {
      const apiKey = env.YOUTUBE_API_KEY || ''
      const q = String(url.searchParams.get('q') || '').trim()
      if (!apiKey) return json({ error: 'Search disabled: missing YOUTUBE_API_KEY.' }, 400)
      if (!q) return json({ error: 'Missing q' }, 400)
      const ytUrl = new URL('https://www.googleapis.com/youtube/v3/search')
      ytUrl.searchParams.set('key', apiKey)
      ytUrl.searchParams.set('part', 'snippet')
      ytUrl.searchParams.set('type', 'video')
      ytUrl.searchParams.set('q', q)
      ytUrl.searchParams.set('maxResults', '8')
      const res = await fetch(ytUrl)
      if (!res.ok) return json({ error: 'Failed to search YouTube' }, 500)
      const data = await res.json()
      const items = (data.items || []).map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
      }))
      return json({ items })
    }

    if (url.pathname === '/api/recommendations' && request.method === 'GET') {
      const apiKey = env.YOUTUBE_API_KEY || ''
      const videoId = parseVideoId(String(url.searchParams.get('videoId') || ''))
      if (!apiKey || !videoId) return json({ items: [] })
      try {
        const items = await fetchRecommendations(videoId, apiKey)
        return json({ items })
      } catch {
        return json({ items: [] })
      }
    }

    if (url.pathname === '/api/resolve' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}))
      const videoId = parseVideoId(String(body.input || ''))
      if (!videoId) return json({ error: 'Invalid YouTube URL or video ID' }, 400)
      try {
        const song = await fetchVideoById(videoId, env.YOUTUBE_API_KEY || '')
        if (!song) return json({ error: 'Video not found' }, 404)
        return json(song)
      } catch {
        return json({ error: 'Failed to resolve video' }, 500)
      }
    }

    return json({ error: 'Not found' }, 404)
  },
}

export class RoomDurableObject {
  constructor(state) {
    this.state = state
    this.room = null
    this.sockets = new Map()
  }

  async loadRoom() {
    if (!this.room) {
      this.room = (await this.state.storage.get('room')) || null
    }
    return this.room
  }

  async saveRoom() {
    if (this.room) await this.state.storage.put('room', this.room)
  }

  serializeRoom() {
    if (!this.room) return null
    const members = Object.entries(this.room.members).map(([id, name]) => ({ id, name }))
    return {
      roomCode: this.room.roomCode,
      mode: this.room.mode,
      hostId: this.room.hostId,
      members,
      queue: this.room.queue,
      current: this.room.current,
      playback: this.room.playback,
    }
  }

  broadcast() {
    const payload = JSON.stringify({ type: 'room:update', room: this.serializeRoom() })
    for (const ws of this.sockets.keys()) {
      try {
        ws.send(payload)
      } catch {}
    }
  }

  async fetch(request) {
    const url = new URL(request.url)
    const room = await this.loadRoom()

    if (url.pathname === '/init' && request.method === 'POST') {
      const body = await request.json()
      this.room = {
        roomCode: body.roomCode,
        mode: body.mode,
        hostId: body.clientId,
        members: { [body.clientId]: body.name },
        queue: [],
        current: null,
        playback: { videoId: null, status: 'paused', positionSec: 0, updatedAt: Date.now() },
      }
      await this.saveRoom()
      return json({ room: this.serializeRoom() })
    }

    if (url.pathname === '/exists') {
      return json({ exists: Boolean(room) })
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      if (!room) return json({ error: 'Room not found' }, 404)
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      const name = String(url.searchParams.get('name') || 'Guest').slice(0, 24)
      const clientId = String(url.searchParams.get('clientId') || '')
      if (!clientId) return json({ error: 'Missing clientId' }, 400)

      server.accept()
      this.sockets.set(server, { clientId })
      this.room.members[clientId] = name
      this.broadcast()
      this.saveRoom()

      server.addEventListener('message', async (event) => {
        let msg
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        if (!this.room) return
        const me = this.sockets.get(server)
        if (!me) return
        const isHost = me.clientId === this.room.hostId

        if (msg.type === 'queue:add' && msg.song?.videoId) {
          const item = {
            id: `${msg.song.videoId}-${Date.now()}`,
            videoId: msg.song.videoId,
            title: msg.song.title,
            thumbnail: msg.song.thumbnail,
            addedBy: this.room.members[me.clientId] || 'Guest',
          }
          if (!this.room.current) {
            this.room.current = item
            this.room.playback = { videoId: item.videoId, status: 'paused', positionSec: 0, updatedAt: Date.now() }
          } else {
            this.room.queue.push(item)
          }
        }

        if (msg.type === 'queue:remove' && isHost) {
          this.room.queue = this.room.queue.filter((item) => item.id !== msg.id)
        }

        if (msg.type === 'queue:move' && isHost) {
          const from = Number(msg.from)
          const to = Number(msg.to)
          if (from >= 0 && to >= 0 && from < this.room.queue.length && to < this.room.queue.length) {
            const [item] = this.room.queue.splice(from, 1)
            this.room.queue.splice(to, 0, item)
          }
        }

        if (msg.type === 'queue:mix' && isHost) {
          for (let i = this.room.queue.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1))
            ;[this.room.queue[i], this.room.queue[j]] = [this.room.queue[j], this.room.queue[i]]
          }
        }

        if (msg.type === 'player:next' && isHost) {
          const next = this.room.queue.shift() || null
          this.room.current = next
          this.room.playback = { videoId: next?.videoId || null, status: 'paused', positionSec: 0, updatedAt: Date.now() }
        }

        if (msg.type === 'playback:update' && isHost) {
          this.room.playback = {
            videoId: msg.playback?.videoId || this.room.current?.videoId || null,
            status: msg.playback?.status || this.room.playback.status,
            positionSec: Math.max(0, Number(msg.playback?.positionSec || 0)),
            updatedAt: Date.now(),
          }
        }

        if (msg.type === 'sync:request') {
          server.send(JSON.stringify({ type: 'room:update', room: this.serializeRoom() }))
          return
        }

        await this.saveRoom()
        this.broadcast()
      })

      server.addEventListener('close', async () => {
        const meta = this.sockets.get(server)
        this.sockets.delete(server)
        if (!this.room || !meta) return

        const stillConnected = [...this.sockets.values()].some((s) => s.clientId === meta.clientId)
        if (!stillConnected) {
          delete this.room.members[meta.clientId]
          const members = Object.keys(this.room.members)
          if (members.length === 0) {
            this.room = null
            await this.state.storage.delete('room')
            return
          }
          if (this.room.hostId === meta.clientId) this.room.hostId = members[0]
          await this.saveRoom()
          this.broadcast()
        }
      })

      return new Response(null, { status: 101, webSocket: client })
    }

    return json({ error: 'Not found' }, 404)
  }
}
