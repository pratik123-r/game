import React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";
const TOKEN_PREFIX = "buddy-bingo-token:";

function getSavedToken(roomId) {
  try { return localStorage.getItem(TOKEN_PREFIX + roomId) || ""; }
  catch { return ""; }
}

function App() {
  const [roomInput, setRoomInput] = useState("");
  const [roomId, setRoomId] = useState("");
  const [room, setRoom] = useState(null);
  const [playerId, setPlayerId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [joining, setJoining] = useState(false);
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    const socket = io(SERVER_URL, { autoConnect: true, transports: ["websocket", "polling"] });
    socketRef.current = socket;
    socket.on("room:update", updatedRoom => {
      setRoom(updatedRoom);
      setError("");
    });
    socket.on("connect_error", () => setError("Cannot connect to the game server. Check the server URL and try again."));
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [room?.messages?.length]);

  const me = useMemo(() => room?.players?.find(player => player.id === playerId), [room, playerId]);
  const opponent = useMemo(() => room?.players?.find(player => player.id !== playerId), [room, playerId]);
  const isMyTurn = Boolean(room && room.status === "playing" && room.currentTurn === playerId);
  const selected = useMemo(() => new Set(room?.selectedNumbers || []), [room?.selectedNumbers]);
  const myLines = useMemo(() => countLines(me?.board || [], selected), [me, selected]);

  function joinRoom(event) {
    event.preventDefault();
    const id = roomInput.trim().toUpperCase().replace(/\s+/g, "");
    if (!id) return setError("Enter a room ID first.");
    if (id.length > 24) return setError("Room IDs can be up to 24 characters.");
    const socket = socketRef.current;
    if (!socket?.connected) return setError("Connecting to the server. Please try again in a moment.");

    setJoining(true);
    setError("");
    socket.emit("room:join", { roomId: id, playerToken: getSavedToken(id) }, response => {
      setJoining(false);
      if (!response?.ok) {
        setError(response?.error || "Could not join this room.");
        return;
      }
      try { localStorage.setItem(TOKEN_PREFIX + id, response.playerToken); } catch {}
      setRoomId(id);
      setPlayerId(response.playerId);
      setRoom(response.room);
      setNotice("");
    });
  }

  function selectNumber(number) {
    if (!isMyTurn || selected.has(number)) return;
    socketRef.current?.emit("number:select", { number }, response => {
      if (!response?.ok) setError(response?.error || "Could not select that number.");
      else setError("");
    });
  }

  function sendChat(event) {
    event.preventDefault();
    const message = chatInput.trim();
    if (!message) return;
    socketRef.current?.emit("chat:send", { message }, response => {
      if (!response?.ok) setError(response?.error || "Message could not be sent.");
      else setChatInput("");
    });
  }

  async function copyRoomId() {
    try {
      await navigator.clipboard.writeText(roomId);
      setNotice("Room ID copied. Share it with your friend!");
    } catch {
      setNotice(`Share this room ID: ${roomId}`);
    }
  }

  function leaveRoom() {
    socketRef.current?.disconnect();
    socketRef.current?.connect();
    setRoom(null);
    setRoomId("");
    setPlayerId("");
    setError("");
    setNotice("");
  }

  if (!room) {
    return (
      <main className="page lobby-page">
        <section className="brand">
          <div className="brand-mark">B</div>
          <p className="eyebrow">TWO PLAYER GAME</p>
          <h1>Buddy <span>Bingo</span></h1>
          <p className="subheading">Pick numbers. Complete five lines. Beat your friend.</p>
        </section>

        <form className="join-card" onSubmit={joinRoom}>
          <h2>Join a game</h2>
          <p>Enter a room ID. Share the same ID with your friend.</p>
          <label htmlFor="room-id">Room ID</label>
          <input
            id="room-id"
            value={roomInput}
            onChange={event => setRoomInput(event.target.value)}
            placeholder="e.g. BINGO2026"
            maxLength={24}
            autoCapitalize="characters"
            autoComplete="off"
          />
          <button className="primary-button" disabled={joining}>
            {joining ? "Joining..." : "Join room"}
          </button>
          {error && <p className="error-message">{error}</p>}
          <div className="rules-mini">
            <span>5 × 5 board</span><span>2 players max</span><span>Live chat</span>
          </div>
        </form>
        <p className="footer-note">No account needed · Your player number is assigned automatically</p>
      </main>
    );
  }

  const activePlayer = room.players.find(player => player.id === room.currentTurn);
  const winner = room.players.find(player => player.id === room.winner);

  return (
    <main className="page game-page">
      <header className="game-header">
        <div>
          <p className="eyebrow">BUDDY BINGO</p>
          <h1>Room <span>{roomId}</span></h1>
        </div>
        <button className="small-button" onClick={copyRoomId}>Copy invite</button>
      </header>

      {notice && <div className="notice" role="status">{notice}</div>}
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}

      <section className="players-strip">
        {room.players.map((player, index) => (
          <div className={`player-chip ${room.currentTurn === player.id && room.status === "playing" ? "is-active" : ""}`} key={player.id}>
            <div className={`player-avatar avatar-${index + 1}`}>{index + 1}</div>
            <div className="player-info">
              <strong>{player.name}{player.id === playerId ? " (You)" : ""}</strong>
              <small>{player.connected ? "Connected" : "Reconnecting..."}</small>
            </div>
            {room.currentTurn === player.id && room.status === "playing" && <span className="turn-dot" />}
          </div>
        ))}
        {room.players.length < 2 && (
          <div className="waiting-chip"><span className="pulse-dot" /> Waiting for Player 2 to join…</div>
        )}
      </section>

      {room.status === "waiting" ? (
        <section className="waiting-card">
          <div className="waiting-icon">⌛</div>
          <h2>Waiting for your friend</h2>
          <p>Share the room ID below. The game starts automatically when the second player joins.</p>
          <button className="room-code" onClick={copyRoomId}>{roomId} <span>Copy</span></button>
        </section>
      ) : room.status === "finished" ? (
        <section className="winner-banner">
          <div className="winner-trophy">🏆</div>
          <div>
            <p className="eyebrow">GAME OVER</p>
            <h2>{winner?.id === playerId ? "You won!" : `${winner?.name || "Your opponent"} won!`}</h2>
            <p>{winner?.name} completed five lines.</p>
          </div>
        </section>
      ) : (
        <section className={`turn-banner ${isMyTurn ? "your-turn" : ""}`}>
          <span className="turn-icon">{isMyTurn ? "🎯" : "⏳"}</span>
          <div>
            <strong>{isMyTurn ? "Your turn — pick a number!" : `${activePlayer?.name || "Opponent"} is picking`}</strong>
            <small>{isMyTurn ? "Tap any available number on your board." : "The same number will be marked on both boards."}</small>
          </div>
          <span className="line-count">{myLines}/5 <small>lines</small></span>
        </section>
      )}

      <section className="board-card">
        <div className="board-heading">
          <div>
            <h2>Your board</h2>
            <p>Tap a number when it’s your turn</p>
          </div>
          <span className="board-tag">5 × 5</span>
        </div>
        {me && <BingoBoard board={me.board} selected={selected} disabled={!isMyTurn || room.status !== "playing"} onSelect={selectNumber} />}
        <div className="board-legend">
          <span><i className="legend-selected" /> Selected</span>
          <span><i className="legend-available" /> Available</span>
        </div>
      </section>

      <div className="game-actions">
        <button className="chat-toggle" onClick={() => setChatOpen(value => !value)}>
          <span>💬</span> {chatOpen ? "Hide chat" : "Open chat"}
          <span className="chat-count">{room.messages.length}</span>
        </button>
        <button className="text-button" onClick={leaveRoom}>Leave room</button>
      </div>

      {chatOpen && (
        <section className="chat-card">
          <div className="chat-heading"><div><h2>Room chat</h2><p>Chat with your opponent anytime</p></div><span>LIVE</span></div>
          <div className="messages-list">
            {room.messages.length === 0 && <p className="empty-chat">No messages yet. Say hello! 👋</p>}
            {room.messages.map(message => (
              <div className={`message ${message.system ? "system-message" : message.playerId === playerId ? "my-message" : "their-message"}`} key={message.id}>
                {!message.system && <strong>{message.playerId === playerId ? "You" : message.playerName}</strong>}
                <p>{message.text}</p>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
          <form className="chat-form" onSubmit={sendChat}>
            <input value={chatInput} onChange={event => setChatInput(event.target.value)} placeholder="Write a message…" maxLength={300} />
            <button aria-label="Send message" disabled={!chatInput.trim()}>➤</button>
          </form>
        </section>
      )}
      <p className="footer-note game-footer">Numbers selected: {room.selectedNumbers.length} / 25</p>
    </main>
  );
}

function BingoBoard({ board, selected, disabled, onSelect }) {
  return (
    <div className="bingo-grid" role="group" aria-label="Your 5 by 5 Bingo board">
      {board.map((number, index) => {
        const isSelected = selected.has(number);
        return (
          <button
            key={`${number}-${index}`}
            className={`bingo-cell ${isSelected ? "selected" : ""}`}
            disabled={disabled || isSelected}
            onClick={() => onSelect(number)}
            aria-label={`Number ${number}${isSelected ? ", selected" : ""}`}
          >
            {number}
            {isSelected && <span className="cell-check">✓</span>}
          </button>
        );
      })}
    </div>
  );
}

function countLines(board, selected) {
  if (!board.length) return 0;
  const lines = [];
  for (let row = 0; row < 5; row++) lines.push(Array.from({ length: 5 }, (_, col) => row * 5 + col));
  for (let col = 0; col < 5; col++) lines.push(Array.from({ length: 5 }, (_, row) => row * 5 + col));
  lines.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);
  const marked = new Set(board.map((number, index) => selected.has(number) ? index : -1).filter(index => index >= 0));
  return lines.filter(line => line.every(index => marked.has(index))).length;
}

export default App;
