import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import axios from 'axios'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { customAlphabet } from 'nanoid'

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
})

const PORT = Number(process.env.PORT || 4000)
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || ''
const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6)

app.use(cors())
app.use(express.json())

const rooms = new Map()

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

function createRoom(hostSocketId, hostName) {
  const roomCode = nanoid()
  const room = {
    roomCode,
    hostId: hostSocketId,
    members: [{ id: hostSocketId, name: hostName }],
    queue: [],
    current: null,
    playback: {
      videoId: null,
      status: 'paused',
      positionSec: 0,
      updatedAt: Date.now(),
    },
  }
  rooms.set(roomCode, room)
  return room
}

function serializeRoom(room) {
  return {
    roomCode: room.roomCode,
    hostId: room.hostId,
    members: room.members,
    queue: room.queue,
    current: room.current,
    playback: room.playback,
  }
}

function broadcastRoom(roomCode) {
  const room = rooms.get(roomCode)
  if (!room) return
  io.to(roomCode).emit('room:update', serializeRoom(room))
}

async function fetchVideoById(videoId) {
  if (YOUTUBE_API_KEY) {
    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        key: YOUTUBE_API_KEY,
        id: videoId,
        part: 'snippet',
      },
    })
    const item = data.items?.[0]
    if (!item) return null
    return {
      videoId,
      title: item.snippet.title,
      thumbnail:
        item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
    }
  }

  const { data } = await axios.get('https://www.youtube.com/oembed', {
    params: {
      url: `https://www.youtube.com/watch?v=${videoId}`,
      format: 'json',
    },
  })

  return {
    videoId,
    title: data.title,
    thumbnail: data.thumbnail_url || '',
  }
}

app.get('/health', (req, res) => {
  res.json({ ok: true })
})

app.get('/config', (req, res) => {
  res.json({ searchEnabled: Boolean(YOUTUBE_API_KEY) })
})

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim()
  if (!YOUTUBE_API_KEY) {
    return res.status(400).json({ error: 'Search disabled: missing YOUTUBE_API_KEY.' })
  }
  if (!q) return res.status(400).json({ error: 'Missing q' })

  try {
    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        key: YOUTUBE_API_KEY,
        part: 'snippet',
        type: 'video',
        q,
        maxResults: 8,
      },
    })

    const items = (data.items || []).map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      thumbnail:
        item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
    }))
    res.json({ items })
  } catch {
    res.status(500).json({ error: 'Failed to search YouTube' })
  }
})

app.get('/api/recommendations', async (req, res) => {
  const videoId = parseVideoId(String(req.query.videoId || ''))
  if (!YOUTUBE_API_KEY) {
    return res.json({ items: [] })
  }
  if (!videoId) return res.status(400).json({ error: 'Invalid videoId' })

  try {
    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        key: YOUTUBE_API_KEY,
        part: 'snippet',
        type: 'video',
        relatedToVideoId: videoId,
        maxResults: 6,
      },
    })

    const items = (data.items || []).map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      thumbnail:
        item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
    }))
    res.json({ items })
  } catch {
    res.status(500).json({ error: 'Failed to fetch recommendations' })
  }
})

app.post('/api/resolve', async (req, res) => {
  const input = String(req.body?.input || '')
  const videoId = parseVideoId(input)
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL or video ID' })

  try {
    const song = await fetchVideoById(videoId)
    if (!song) return res.status(404).json({ error: 'Video not found' })
    res.json(song)
  } catch {
    res.status(500).json({ error: 'Failed to resolve video' })
  }
})

io.on('connection', (socket) => {
  socket.on('room:create', ({ name }, cb) => {
    const safeName = String(name || 'Guest').slice(0, 24)
    const room = createRoom(socket.id, safeName)
    socket.join(room.roomCode)
    cb?.({ ok: true, room: serializeRoom(room), clientId: socket.id })
  })

  socket.on('room:join', ({ roomCode, name }, cb) => {
    const room = rooms.get(String(roomCode || '').toUpperCase())
    if (!room) return cb?.({ ok: false, error: 'Room not found' })

    const safeName = String(name || 'Guest').slice(0, 24)
    room.members.push({ id: socket.id, name: safeName })
    socket.join(room.roomCode)
    broadcastRoom(room.roomCode)
    cb?.({ ok: true, room: serializeRoom(room), clientId: socket.id })
  })

  socket.on('queue:add', ({ roomCode, song }) => {
    const room = rooms.get(String(roomCode || '').toUpperCase())
    if (!room || !song?.videoId) return
    const member = room.members.find((m) => m.id === socket.id)
    const item = {
      id: `${song.videoId}-${Date.now()}`,
      videoId: song.videoId,
      title: song.title,
      thumbnail: song.thumbnail,
      addedBy: member?.name || 'Guest',
    }

    if (!room.current) {
      room.current = item
      room.playback = {
        videoId: item.videoId,
        status: 'paused',
        positionSec: 0,
        updatedAt: Date.now(),
      }
    } else {
      room.queue.push(item)
    }
    broadcastRoom(room.roomCode)
  })

  socket.on('queue:remove', ({ roomCode, id }) => {
    const room = rooms.get(String(roomCode || '').toUpperCase())
    if (!room) return
    room.queue = room.queue.filter((item) => item.id !== id)
    broadcastRoom(room.roomCode)
  })

  socket.on('queue:move', ({ roomCode, from, to }) => {
    const room = rooms.get(String(roomCode || '').toUpperCase())
    if (!room) return
    if (from < 0 || to < 0 || from >= room.queue.length || to >= room.queue.length) return
    const [item] = room.queue.splice(from, 1)
    room.queue.splice(to, 0, item)
    broadcastRoom(room.roomCode)
  })

  socket.on('queue:mix', ({ roomCode }) => {
    const room = rooms.get(String(roomCode || '').toUpperCase())
    if (!room) return
    for (let i = room.queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[room.queue[i], room.queue[j]] = [room.queue[j], room.queue[i]]
    }
    broadcastRoom(room.roomCode)
  })

  socket.on('player:next', ({ roomCode }) => {
    const room = rooms.get(String(roomCode || '').toUpperCase())
    if (!room || socket.id !== room.hostId) return
    const next = room.queue.shift() || null
    room.current = next
    room.playback = {
      videoId: next?.videoId || null,
      status: 'paused',
      positionSec: 0,
      updatedAt: Date.now(),
    }
    broadcastRoom(room.roomCode)
  })

  socket.on('playback:update', ({ roomCode, playback }) => {
    const room = rooms.get(String(roomCode || '').toUpperCase())
    if (!room || socket.id !== room.hostId) return
    room.playback = {
      videoId: playback.videoId || room.current?.videoId || null,
      status: playback.status || room.playback.status,
      positionSec: Math.max(0, Number(playback.positionSec || 0)),
      updatedAt: Date.now(),
    }
    broadcastRoom(room.roomCode)
  })

  socket.on('sync:request', ({ roomCode }) => {
    const room = rooms.get(String(roomCode || '').toUpperCase())
    if (!room) return
    socket.emit('room:update', serializeRoom(room))
  })

  socket.on('disconnect', () => {
    for (const [roomCode, room] of rooms) {
      const prev = room.members.length
      room.members = room.members.filter((m) => m.id !== socket.id)
      if (room.members.length === 0) {
        rooms.delete(roomCode)
        continue
      }
      if (room.hostId === socket.id) {
        room.hostId = room.members[0].id
      }
      if (room.members.length !== prev) broadcastRoom(roomCode)
    }
  })
})

httpServer.listen(PORT, () => {
  console.log(`music-jam server running on ${PORT}`)
})
