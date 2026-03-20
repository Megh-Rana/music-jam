import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

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

export default function App() {
  const wsRef = useRef(null)
  const playerRef = useRef(null)
  const playerHostRef = useRef(document.createElement('div'))
  const syncTimerRef = useRef(null)
  const roomRef = useRef(null)
  const isHostRef = useRef(false)
  const lastPlaybackEmitRef = useRef({ videoId: null, status: null, positionSec: 0, at: 0 })
  const autoplayHintRef = useRef(false)

  const [name, setName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [clientId, setClientId] = useState('')
  const [room, setRoom] = useState(null)
  const [songInput, setSongInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchItems, setSearchItems] = useState([])
  const [recommendations, setRecommendations] = useState([])
  const [searchEnabled, setSearchEnabled] = useState(false)
  const [loadingSearch, setLoadingSearch] = useState(false)
  const [status, setStatus] = useState('')

  const isHost = room && clientId && room.hostId === clientId
  const membersLabel = useMemo(() => (room ? `${room.members.length} listening` : ''), [room])

  useEffect(() => {
    roomRef.current = room
    isHostRef.current = Boolean(isHost)
  }, [room, isHost])

  const emitPlayback = (videoId, status, positionSec, force = false) => {
    if (!videoId) return
    const now = Date.now()
    const last = lastPlaybackEmitRef.current
    const changedVideo = last.videoId !== videoId
    const changedStatus = last.status !== status
    const jumped = Math.abs((last.positionSec || 0) - (positionSec || 0)) > 1.1
    const stale = now - (last.at || 0) > 1800
    if (!force && !changedVideo && !changedStatus && !jumped && !stale) return
    send({ type: 'playback:update', playback: { videoId, status, positionSec } })
    lastPlaybackEmitRef.current = { videoId, status, positionSec, at: now }
  }

  const send = (payload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(payload))
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
    if (!room) return undefined
    let disposed = false

    function mountPlayer() {
      if (playerRef.current || !window.YT?.Player) return
      playerRef.current = new window.YT.Player(playerHostRef.current, {
        width: '100%',
        height: '100%',
        playerVars: { controls: 1, rel: 0, modestbranding: 1, iv_load_policy: 3 },
        events: {
          onStateChange: (event) => {
            const latestRoom = roomRef.current
            if (!latestRoom?.current) return
            if (!isHostRef.current) return
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
      if (!disposed) mountPlayer()
    }
    return () => {
      disposed = true
    }
  }, [isHost, room])

  useEffect(() => {
    if (!room?.current?.videoId || !playerRef.current?.getPlayerState) return
    const player = playerRef.current
    const playback = room.playback
    const videoId = room.current.videoId
    const state = player.getPlayerState()
    const loadedId = player.getVideoData?.().video_id
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
    if (playback.status === 'playing' && !isPlayingState(state)) {
      player.playVideo()
      if (!isHost && !autoplayHintRef.current) {
        autoplayHintRef.current = true
        setStatus('If audio does not start, tap the player once to enable playback.')
      }
    }
    if (playback.status === 'paused' && isPlayingState(state)) player.pauseVideo()
  }, [room])

  useEffect(() => {
    if (syncTimerRef.current) clearInterval(syncTimerRef.current)
    if (!room || !isHost) return
    syncTimerRef.current = setInterval(() => {
      const player = playerRef.current
      if (!player?.getCurrentTime || !room.current) return
      const status = isPlayingState(player.getPlayerState?.()) ? 'playing' : 'paused'
      emitPlayback(room.current.videoId, status, Number(player.getCurrentTime() || 0))
    }, 400)
    return () => {
      if (syncTimerRef.current) clearInterval(syncTimerRef.current)
    }
  }, [isHost, room])

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

  const addByUrl = async () => {
    if (!songInput.trim()) return
    const res = await fetch(`${SERVER_URL}/api/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: songInput.trim() }),
    })
    const data = await res.json()
    if (!res.ok) return setStatus(data.error || 'Could not add song')
    addResolvedSong(data)
    setSongInput('')
    setStatus('Added to queue')
  }

  const searchSongs = async () => {
    if (!searchEnabled) return setStatus('Search disabled: add YOUTUBE_API_KEY on backend')
    const q = searchQuery.trim()
    if (!q) return
    setLoadingSearch(true)
    try {
      const res = await fetch(`${SERVER_URL}/api/search?q=${encodeURIComponent(q)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Search failed')
      setSearchItems(data.items || [])
      setStatus(`Found ${data.items?.length || 0} songs`)
    } catch (error) {
      setStatus(error.message)
      setSearchItems([])
    } finally {
      setLoadingSearch(false)
    }
  }

  if (!room) {
    return (
      <main className="page page-center">
        <section className="auth-card">
          <p className="eyebrow">music-jam</p>
          <h1>Jam in sync with friends</h1>
          <p className="subtext">Create a room, share a code, and build one queue together.</p>
          <label>Display name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="NeonTiger" /></label>
          <div className="row"><button className="btn btn-primary" onClick={createRoom}>Create Room</button></div>
          <div className="join-block">
            <input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} placeholder="ROOM CODE" maxLength={6} />
            <button className="btn" onClick={joinRoom}>Join</button>
          </div>
          {status ? <p className="status">{status}</p> : null}
        </section>
      </main>
    )
  }

  return (
    <main className="page">
      <header className="topbar">
        <div><p className="eyebrow">Room {room.roomCode}</p><h2>Now jamming</h2></div>
        <div><p className="meta">{membersLabel}</p><p className="meta">{isHost ? 'You are host' : 'Listener mode'}</p></div>
      </header>
      <section className="layout">
        <div className="panel player-panel">
          <div className="player-shell"><div className="player" ref={playerHostRef}></div></div>
          <div className="player-meta"><h3>{room.current?.title || 'Queue a song to start'}</h3><p>{room.current ? `Added by ${room.current.addedBy}` : 'Paste a YouTube link below'}</p></div>
          <div className="row wrap">
            <button className="btn" onClick={() => send({ type: 'sync:request' })}>Resync</button>
            {isHost ? <button className="btn btn-primary" onClick={() => send({ type: 'player:next' })}>Next song</button> : null}
          </div>
        </div>
        <div className="panel">
          <h3>Add song</h3>
          <p className="meta">Paste YouTube URL or ID</p>
          <div className="join-block">
            <input value={songInput} onChange={(e) => setSongInput(e.target.value)} placeholder="https://youtube.com/watch?v=..." />
            <button className="btn btn-primary" onClick={addByUrl}>Add</button>
          </div>
          <h3 className="spaced">Search</h3>
          <div className="join-block">
            <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder={searchEnabled ? 'Search YouTube songs' : 'Enable API key for search'} />
            <button className="btn" onClick={searchSongs} disabled={loadingSearch || !searchEnabled}>{loadingSearch ? '...' : 'Find'}</button>
          </div>
          <div className="result-list">{searchItems.map((item) => <button key={item.videoId} className="result" onClick={() => addResolvedSong(item)}><img src={item.thumbnail} alt="" /><span>{item.title}</span></button>)}</div>
          <h3 className="spaced">Recommendations</h3>
          <div className="result-list">{recommendations.map((item) => <button key={`rec-${item.videoId}`} className="result" onClick={() => addResolvedSong(item)}><img src={item.thumbnail} alt="" /><span>{item.title}</span></button>)}</div>
        </div>
        <div className="panel queue-panel">
          <div className="row between"><h3>Queue</h3><button className="btn" onClick={() => send({ type: 'queue:mix' })}>Mix</button></div>
          <div className="queue-list">
            {room.queue.length === 0 ? <p className="meta">Queue is empty</p> : null}
            {room.queue.map((item, index) => (
              <article className="queue-item" key={item.id}>
                <img src={item.thumbnail} alt="" />
                <div><p>{item.title}</p><small>by {item.addedBy}</small></div>
                <div className="item-controls">
                  <button className="btn mini" onClick={() => send({ type: 'queue:move', from: index, to: index - 1 })}>↑</button>
                  <button className="btn mini" onClick={() => send({ type: 'queue:move', from: index, to: index + 1 })}>↓</button>
                  <button className="btn mini" onClick={() => send({ type: 'queue:remove', id: item.id })}>✕</button>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
      {status ? <p className="status status-bottom">{status}</p> : null}
    </main>
  )
}
