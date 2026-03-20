import { Component, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  render() {
    if (this.state.hasError) {
      return (
        <main className="entry-screen">
          <header className="entry-topbar"><h1>MUSIC JAM</h1></header>
          <section className="entry-hero">
            <h2>Something went wrong</h2>
            <p>Please refresh the page to reconnect.</p>
            <button className="cta" onClick={() => window.location.reload()}>Refresh</button>
          </section>
        </main>
      )
    }
    return this.props.children
  }
}

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:8787'

function clampName(input) {
  return (input || 'Guest').trim().slice(0, 24) || 'Guest'
}

function isPlayingState(state) {
  return state === 1
}

function toWsUrl(base, roomCode, clientId, name) {
  const u = new URL(base)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/ws'
  u.searchParams.set('roomCode', roomCode)
  u.searchParams.set('clientId', clientId)
  u.searchParams.set('name', name)
  return u.toString()
}

function App() {
  const wsRef = useRef(null)
  const playerRef = useRef(null)
  const syncTimerRef = useRef(null)
  const roomRef = useRef(null)
  const isHostRef = useRef(false)
  const lastPlaybackEmitRef = useRef({ videoId: null, status: null, positionSec: 0, at: 0 })

  const [name, setName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [clientId, setClientId] = useState('')
  const [room, setRoom] = useState(null)
  const hasRoom = Boolean(room)
  const [searchInput, setSearchInput] = useState('')
  const [searchItems, setSearchItems] = useState([])
  const [recommendations, setRecommendations] = useState([])
  const [searchEnabled, setSearchEnabled] = useState(false)
  const [loadingSearch, setLoadingSearch] = useState(false)
  const [status, setStatus] = useState('')
  const [coverBroken, setCoverBroken] = useState(false)

  const isHost = room && clientId && room.hostId === clientId
  const membersLabel = useMemo(() => (room ? `${room.members.length} live` : ''), [room])
  const coverThumb = room?.current?.thumbnail || ''
  const hasCover = Boolean(coverThumb && !coverBroken)
  const playbackStatus = room?.playback?.status || 'paused'

  useEffect(() => {
    setCoverBroken(false)
  }, [room?.current?.videoId])

  useEffect(() => {
    roomRef.current = room
    isHostRef.current = Boolean(isHost)
  }, [room, isHost])

  const send = (payload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(payload))
  }

  const emitPlayback = (videoId, nextStatus, positionSec, force = false) => {
    if (!videoId) return
    const now = Date.now()
    const last = lastPlaybackEmitRef.current
    const changedVideo = last.videoId !== videoId
    const changedStatus = last.status !== nextStatus
    const jumped = Math.abs((last.positionSec || 0) - (positionSec || 0)) > 1.1
    const stale = now - (last.at || 0) > 1800
    if (!force && !changedVideo && !changedStatus && !jumped && !stale) return
    send({ type: 'playback:update', playback: { videoId, status: nextStatus, positionSec } })
    lastPlaybackEmitRef.current = { videoId, status: nextStatus, positionSec, at: now }
  }

  const connectWs = (roomCode, cid, displayName) => {
    if (wsRef.current) wsRef.current.close()
    const ws = new WebSocket(toWsUrl(SERVER_URL, roomCode, cid, displayName))
    wsRef.current = ws
    ws.onopen = () => send({ type: 'sync:request' })
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'room:update') setRoom(msg.room)
      } catch {}
    }
    ws.onclose = () => setStatus('Disconnected. Rejoin room if needed.')
  }

  useEffect(() => {
    fetch(`${SERVER_URL}/config`)
      .then((res) => res.json())
      .then((data) => setSearchEnabled(Boolean(data.searchEnabled)))
      .catch(() => setSearchEnabled(false))
  }, [])

  useEffect(() => {
    if (!hasRoom) return undefined
    let disposed = false
    function mountPlayer() {
      if (playerRef.current || !window.YT?.Player) return
      const hostEl = document.getElementById('yt-player-host')
      if (!hostEl) return
      playerRef.current = new window.YT.Player('yt-player-host', {
        width: '100%',
        height: '100%',
        playerVars: { controls: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, disablekb: 1 },
        events: {
          onStateChange: (event) => {
            const latestRoom = roomRef.current
            if (!latestRoom?.current || !isHostRef.current) return
            const p = playerRef.current
            if (!p?.getCurrentTime) return
            const positionSec = Number(p.getCurrentTime() || 0)
            if (event.data === 0) return send({ type: 'player:next' })
            if (event.data === 1) emitPlayback(latestRoom.current.videoId, 'playing', positionSec, true)
            if (event.data === 2) emitPlayback(latestRoom.current.videoId, 'paused', positionSec, true)
          },
        },
      })
    }

    if (window.YT?.Player) {
      mountPlayer()
      return () => {
        disposed = true
      }
    }
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement('script')
      script.src = 'https://www.youtube.com/iframe_api'
      document.body.appendChild(script)
    }
    const prevReady = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prevReady === 'function') prevReady()
      setTimeout(() => {
        if (!disposed) mountPlayer()
      }, 0)
    }
    return () => {
      disposed = true
      if (playerRef.current?.destroy) {
        try {
          playerRef.current.destroy()
        } catch {}
      }
      playerRef.current = null
    }
  }, [hasRoom])

  useEffect(() => {
    if (!room?.current?.videoId || !playerRef.current?.getPlayerState) return
    const player = playerRef.current
    const playback = room.playback
    const videoId = room.current.videoId
      const loadedId = player.getVideoData?.()?.video_id
    if (loadedId !== videoId) {
      if (playback.status === 'playing') player.loadVideoById({ videoId, startSeconds: playback.positionSec || 0 })
      else player.cueVideoById({ videoId, startSeconds: playback.positionSec || 0 })
      return
    }
    const now = Date.now()
    const expected = playback.status === 'playing'
      ? (playback.positionSec || 0) + (now - playback.updatedAt) / 1000
      : (playback.positionSec || 0)
    const current = Number(player.getCurrentTime?.() || 0)
    if (Math.abs(current - expected) > 2.2) player.seekTo(expected, true)
    const state = player.getPlayerState()
    if (playback.status === 'playing' && !isPlayingState(state)) player.playVideo()
    if (playback.status === 'paused' && isPlayingState(state)) player.pauseVideo()
  }, [room])

  useEffect(() => {
    if (syncTimerRef.current) clearInterval(syncTimerRef.current)
    if (!hasRoom || !isHost) return
    syncTimerRef.current = setInterval(() => {
      const player = playerRef.current
      const latestRoom = roomRef.current
      if (!player?.getCurrentTime || !latestRoom?.current) return
      const nextStatus = isPlayingState(player.getPlayerState?.()) ? 'playing' : 'paused'
      emitPlayback(latestRoom.current.videoId, nextStatus, Number(player.getCurrentTime() || 0))
    }, 400)
    return () => {
      if (syncTimerRef.current) clearInterval(syncTimerRef.current)
    }
  }, [isHost, hasRoom])

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') send({ type: 'sync:request' })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    if (!room?.current?.videoId || !searchEnabled) {
      setRecommendations([])
      return
    }
    fetch(`${SERVER_URL}/api/recommendations?videoId=${room.current.videoId}`)
      .then((res) => res.json())
      .then((data) => setRecommendations(data.items || []))
      .catch(() => setRecommendations([]))
  }, [room?.current?.videoId, searchEnabled])

  const createRoom = async () => {
    const displayName = clampName(name)
    const res = await fetch(`${SERVER_URL}/api/room/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: displayName, mode: 'embed' }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) return setStatus(data.error || 'Failed to create room')
    setClientId(data.clientId)
    setRoom(data.room)
    connectWs(data.roomCode, data.clientId, displayName)
    setStatus('Room created')
  }

  const joinRoom = async () => {
    const displayName = clampName(name)
    const res = await fetch(`${SERVER_URL}/api/room/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomCode: joinCode.trim().toUpperCase() }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) return setStatus(data.error || 'Failed to join room')
    setClientId(data.clientId)
    connectWs(data.roomCode, data.clientId, displayName)
    setStatus('Joined room')
  }

  const addResolvedSong = (song) => song?.videoId && send({ type: 'queue:add', song })

  const parseVideoId = (input) => {
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

  const handleSearchOrAdd = async () => {
    const q = searchInput.trim()
    if (!q) return
    const id = parseVideoId(q)
    if (id) {
      try {
        const res = await fetch(`${SERVER_URL}/api/resolve`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: q }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Could not add song')
        addResolvedSong(data)
        setStatus('Added to queue')
        setSearchInput('')
      } catch (error) {
        setStatus(error.message)
      }
      return
    }

    if (!searchEnabled) {
      setStatus('Search disabled: add YOUTUBE_API_KEY on backend')
      return
    }
    setLoadingSearch(true)
    try {
      const res = await fetch(`${SERVER_URL}/api/search?q=${encodeURIComponent(q)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Search failed')
      setSearchItems(data.items || [])
      setStatus('')
    } catch (error) {
      setStatus(error.message)
      setSearchItems([])
    } finally {
      setLoadingSearch(false)
    }
  }

  const addRecommendedBatch = () => {
    const picks = recommendations.slice(0, 5)
    if (picks.length === 0) {
      setStatus('No recommendations available yet.')
      return
    }
    for (const song of picks) addResolvedSong(song)
    setStatus(`Added ${picks.length} recommended songs.`)
  }

  const hostTogglePlayback = () => {
    if (!isHost || !room?.current) return
    const player = playerRef.current
    if (!player?.getPlayerState) return
    if (isPlayingState(player.getPlayerState())) player.pauseVideo()
    else player.playVideo()
  }

  const hostSeekBy = (deltaSec) => {
    if (!isHost || !room?.current) return
    const player = playerRef.current
    if (!player?.getCurrentTime) return
    const next = Math.max(0, Number(player.getCurrentTime() || 0) + deltaSec)
    player.seekTo(next, true)
    const nextStatus = isPlayingState(player.getPlayerState?.()) ? 'playing' : 'paused'
    emitPlayback(room.current.videoId, nextStatus, next, true)
  }

  if (!room) {
    return (
      <main className="entry-screen">
        <header className="entry-topbar">
          <h1>MUSIC JAM</h1>
        </header>
        <section className="entry-hero">
          <h2>JAM TOGETHER</h2>
          <p>Real-time collaborative queue for shared listening sessions.</p>
          <label>
            Display name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="NeonTiger" />
          </label>
          <div className="entry-actions">
            <button className="cta" onClick={createRoom}>Create a Jam Room</button>
            <div className="join-inline">
              <input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} placeholder="Join with Code" maxLength={6} />
              <button onClick={joinRoom}>→</button>
            </div>
          </div>
          {status ? <p className="status">{status}</p> : null}
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="topbar-brutal">
        <h1>MUSIC JAM</h1>
        <p>#{room.roomCode} · {membersLabel}</p>
      </header>

      <section className="layout-stack">
        <article className="now-playing card">
          <div className="cover-wrap">
            <div className="cover-fallback" />
            {hasCover ? (
              <img className="cover-art" src={coverThumb} alt="Current track" onError={() => setCoverBroken(true)} />
            ) : null}
          </div>
          <div className="now-meta">
            <h2>{room.current?.title || 'Queue a song to start'}</h2>
            <p>{room.current ? `Added by ${room.current.addedBy}` : 'Paste a YouTube URL or search below'}</p>
            {isHost ? (
              <div className="host-controls">
                <button onClick={() => hostSeekBy(-10)}>-10s</button>
                <button onClick={hostTogglePlayback}>{playbackStatus === 'playing' ? 'Pause' : 'Play'}</button>
                <button onClick={() => hostSeekBy(10)}>+10s</button>
                <button className="primary" onClick={() => send({ type: 'player:next' })}>Next</button>
              </div>
            ) : null}
          </div>
        </article>

        <article className="search-card card">
          <h3>Search or Paste</h3>
          <div className="search-row">
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Track, artist, genre, or YouTube URL/ID"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearchOrAdd()
              }}
            />
            <button onClick={handleSearchOrAdd} disabled={loadingSearch}>{loadingSearch ? '...' : 'Go'}</button>
          </div>
          <div className="list">
            {searchItems.map((item) => (
              <button key={item.videoId} className="list-item" onClick={() => addResolvedSong(item)}>
                <img src={item.thumbnail || ''} alt="" onError={(e) => { e.target.style.display = 'none' }} />
                <span>{item.title}</span>
              </button>
            ))}
          </div>
        </article>

        <section className="queue-section card">
          <div className="queue-head">
            <h3>Up Next</h3>
            <span className="queue-count">{room.queue.length} queued</span>
          </div>
          <div className="queue-list">
            {room.queue.length === 0 ? <p className="meta">Queue is empty</p> : null}
            {room.queue.map((item, index) => (
              <article key={item.id} className="queue-item">
                <img src={item.thumbnail || ''} alt="" onError={(e) => { e.target.style.display = 'none' }} />
                <div>
                  <p>{item.title}</p>
                  <small>by {item.addedBy}</small>
                </div>
                <div className="item-controls">
                  <button onClick={() => send({ type: 'queue:move', from: index, to: index - 1 })}>↑</button>
                  <button onClick={() => send({ type: 'queue:move', from: index, to: index + 1 })}>↓</button>
                  <button onClick={() => send({ type: 'queue:remove', id: item.id })}>✕</button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <div className="recommend-strip card">
          <p>Recommendations ready: {recommendations.length}</p>
          <button onClick={addRecommendedBatch}>Add Recommended Mix</button>
        </div>
      </section>

      {status ? <p className="status">{status}</p> : null}
    </main>
  )
}

export default function WrappedApp() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}
