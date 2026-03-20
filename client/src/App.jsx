import { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000'
const socket = io(SERVER_URL, { autoConnect: true })

function clampName(input) {
  return (input || 'Guest').trim().slice(0, 24) || 'Guest'
}

function isPlayingState(state) {
  return state === 1
}

function App() {
  const playerRef = useRef(null)
  const playerHostRef = useRef(document.createElement('div'))
  const syncTimerRef = useRef(null)

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

  const membersLabel = useMemo(() => {
    if (!room) return ''
    return `${room.members.length} listening`
  }, [room])

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
        playerVars: {
          controls: 1,
          rel: 0,
          modestbranding: 1,
          iv_load_policy: 3,
        },
        events: {
          onStateChange: (event) => {
            if (!room || !isHost) return
            const current = room.current
            if (!current) return
            const player = playerRef.current
            if (!player?.getCurrentTime) return
            const positionSec = Number(player.getCurrentTime() || 0)

            if (event.data === 0) {
              socket.emit('player:next', { roomCode: room.roomCode })
              return
            }

            if (event.data === 1) {
              socket.emit('playback:update', {
                roomCode: room.roomCode,
                playback: { videoId: current.videoId, status: 'playing', positionSec },
              })
            }
            if (event.data === 2) {
              socket.emit('playback:update', {
                roomCode: room.roomCode,
                playback: { videoId: current.videoId, status: 'paused', positionSec },
              })
            }
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

    const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]')
    if (!existing) {
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
    function onRoomUpdate(nextRoom) {
      setRoom(nextRoom)
    }

    socket.on('room:update', onRoomUpdate)
    return () => {
      socket.off('room:update', onRoomUpdate)
    }
  }, [])

  useEffect(() => {
    if (!room?.current?.videoId || !playerRef.current?.getPlayerState) return
    const player = playerRef.current
    const playback = room.playback
    const videoId = room.current.videoId
    const state = player.getPlayerState()
    const loadedId = player.getVideoData?.().video_id

    if (loadedId !== videoId) {
      if (playback.status === 'playing') {
        player.loadVideoById({ videoId, startSeconds: playback.positionSec || 0 })
      } else {
        player.cueVideoById({ videoId, startSeconds: playback.positionSec || 0 })
      }
      return
    }

    const now = Date.now()
    const expected = playback.status === 'playing'
      ? (playback.positionSec || 0) + (now - playback.updatedAt) / 1000
      : (playback.positionSec || 0)

    const current = Number(player.getCurrentTime?.() || 0)
    if (Math.abs(current - expected) > 2.2) {
      player.seekTo(expected, true)
    }

    if (playback.status === 'playing' && !isPlayingState(state)) {
      player.playVideo()
    }
    if (playback.status === 'paused' && isPlayingState(state)) {
      player.pauseVideo()
    }
  }, [room])

  useEffect(() => {
    if (syncTimerRef.current) clearInterval(syncTimerRef.current)
    if (!room || !isHost) return
    syncTimerRef.current = setInterval(() => {
      const player = playerRef.current
      if (!player?.getCurrentTime || !room.current) return
      if (!isPlayingState(player.getPlayerState?.())) return
      socket.emit('playback:update', {
        roomCode: room.roomCode,
        playback: {
          videoId: room.current.videoId,
          status: 'playing',
          positionSec: Number(player.getCurrentTime() || 0),
        },
      })
    }, 2000)

    return () => {
      if (syncTimerRef.current) clearInterval(syncTimerRef.current)
    }
  }, [isHost, room])

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

  const createRoom = () => {
    socket.emit('room:create', { name: clampName(name) }, (result) => {
      if (!result?.ok) {
        setStatus(result?.error || 'Failed to create room')
        return
      }
      setClientId(result.clientId)
      setRoom(result.room)
      setStatus('Room created')
    })
  }

  const joinRoom = () => {
    socket.emit(
      'room:join',
      { roomCode: joinCode.trim().toUpperCase(), name: clampName(name) },
      (result) => {
        if (!result?.ok) {
          setStatus(result?.error || 'Failed to join room')
          return
        }
        setClientId(result.clientId)
        setRoom(result.room)
        setStatus('Joined room')
      },
    )
  }

  const addResolvedSong = (song) => {
    if (!room || !song?.videoId) return
    socket.emit('queue:add', { roomCode: room.roomCode, song })
  }

  const addByUrl = async () => {
    if (!songInput.trim() || !room) return
    const res = await fetch(`${SERVER_URL}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: songInput.trim() }),
    })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Could not add song')
      return
    }
    addResolvedSong(data)
    setSongInput('')
    setStatus('Added to queue')
  }

  const searchSongs = async () => {
    if (!searchEnabled) {
      setStatus('Search disabled: add YOUTUBE_API_KEY on server')
      return
    }
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

  const removeQueueItem = (id) => {
    socket.emit('queue:remove', { roomCode: room.roomCode, id })
  }

  const moveQueueItem = (index, delta) => {
    const to = index + delta
    socket.emit('queue:move', { roomCode: room.roomCode, from: index, to })
  }

  const mixQueue = () => {
    if (!room) return
    socket.emit('queue:mix', { roomCode: room.roomCode })
  }

  if (!room) {
    return (
      <main className="page page-center">
        <section className="auth-card">
          <p className="eyebrow">music-jam</p>
          <h1>Jam in sync with friends</h1>
          <p className="subtext">Create a room, share a code, and build one queue together.</p>

          <label>
            Display name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="NeonTiger" />
          </label>

          <div className="row">
            <button className="btn btn-primary" onClick={createRoom}>Create Room</button>
          </div>

          <div className="join-block">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="ROOM CODE"
              maxLength={6}
            />
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
        <div>
          <p className="eyebrow">Room {room.roomCode}</p>
          <h2>Now jamming</h2>
        </div>
        <div>
          <p className="meta">{membersLabel}</p>
          <p className="meta">{isHost ? 'You are host' : 'Listener mode'}</p>
        </div>
      </header>

      <section className="layout">
        <div className="panel player-panel">
          <div className="player-shell">
            <div className="player" ref={playerHostRef}></div>
          </div>
          <div className="player-meta">
            <h3>{room.current?.title || 'Queue a song to start'}</h3>
            <p>{room.current ? `Added by ${room.current.addedBy}` : 'Paste a YouTube link below'}</p>
          </div>
          <div className="row wrap">
            <button className="btn" onClick={() => socket.emit('sync:request', { roomCode: room.roomCode })}>Resync</button>
            {isHost ? <button className="btn btn-primary" onClick={() => socket.emit('player:next', { roomCode: room.roomCode })}>Next song</button> : null}
          </div>
        </div>

        <div className="panel">
          <h3>Add song</h3>
          <p className="meta">Paste YouTube URL or ID</p>
          <div className="join-block">
            <input
              value={songInput}
              onChange={(e) => setSongInput(e.target.value)}
              placeholder="https://youtube.com/watch?v=..."
            />
            <button className="btn btn-primary" onClick={addByUrl}>Add</button>
          </div>

          <h3 className="spaced">Search</h3>
          <div className="join-block">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={searchEnabled ? 'Search YouTube songs' : 'Enable API key for search'}
            />
            <button className="btn" onClick={searchSongs} disabled={loadingSearch || !searchEnabled}>
              {loadingSearch ? '...' : 'Find'}
            </button>
          </div>
          <div className="result-list">
            {searchItems.map((item) => (
              <button key={item.videoId} className="result" onClick={() => addResolvedSong(item)}>
                <img src={item.thumbnail} alt="" />
                <span>{item.title}</span>
              </button>
            ))}
          </div>

          <h3 className="spaced">Recommendations</h3>
          <div className="result-list">
            {recommendations.map((item) => (
              <button key={`rec-${item.videoId}`} className="result" onClick={() => addResolvedSong(item)}>
                <img src={item.thumbnail} alt="" />
                <span>{item.title}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="panel queue-panel">
          <div className="row between">
            <h3>Queue</h3>
            <button className="btn" onClick={mixQueue}>Mix</button>
          </div>
          <div className="queue-list">
            {room.queue.length === 0 ? <p className="meta">Queue is empty</p> : null}
            {room.queue.map((item, index) => (
              <article className="queue-item" key={item.id}>
                <img src={item.thumbnail} alt="" />
                <div>
                  <p>{item.title}</p>
                  <small>by {item.addedBy}</small>
                </div>
                <div className="item-controls">
                  <button className="btn mini" onClick={() => moveQueueItem(index, -1)}>↑</button>
                  <button className="btn mini" onClick={() => moveQueueItem(index, 1)}>↓</button>
                  <button className="btn mini" onClick={() => removeQueueItem(item.id)}>✕</button>
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

export default App
