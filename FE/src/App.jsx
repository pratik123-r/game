import React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

const USER_KEY = "buddy-bingo-user";
const SESSION_KEY = "buddy-bingo-session";
const STORAGE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours, same as the backend
const USER_ID_PATTERN = /^[A-Za-z0-9_.-]{3,20}$/;

// localStorage helpers: values are stored with a timestamp and expire after 4 hours.
function readStored(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return "";
    const data = JSON.parse(raw);
    if (!data?.value || Date.now() - data.savedAt > STORAGE_TTL_MS) {
      localStorage.removeItem(key);
      return "";
    }
    return data.value;
  } catch {
    return "";
  }
}

function writeStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify({ value, savedAt: Date.now() })); }
  catch {}
}

function clearStored(key) {
  try { localStorage.removeItem(key); }
  catch {}
}

function emitJoin(socket, roomId, userId, callback) {
  socket.emit("room:join", { roomId, userId }, callback);
}

// The server compares User IDs case-insensitively, so the client must too.
const sameUser = (a, b) =>
  Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();

function App() {
  const savedUserId = useMemo(() => readStored(USER_KEY), []);
  const savedRoomId = useMemo(() => (savedUserId ? readStored(SESSION_KEY) : ""), [savedUserId]);

  const [userId, setUserId] = useState(savedUserId);
  const [userInput, setUserInput] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [roomId, setRoomId] = useState("");
  const [room, setRoom] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [seenCount, setSeenCount] = useState(0);
  const [joining, setJoining] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restoring, setRestoring] = useState(Boolean(savedUserId && savedRoomId));

  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  // The room/user this browser should be sitting in (used for auto-rejoin on refresh/reconnect).
  const sessionRef = useRef(savedUserId && savedRoomId ? { userId: savedUserId, roomId: savedRoomId } : null);

  useEffect(() => {
    const socket = io(SERVER_URL, { autoConnect: true, transports: ["websocket", "polling"] });
    socketRef.current = socket;

    // Runs on first connect (page load/refresh) and on every automatic reconnect.
    socket.on("connect", () => {
      const session = sessionRef.current;
      if (!session) return;
      emitJoin(socket, session.roomId, session.userId, response => {
        setRestoring(false);
        if (!response?.ok) {
          sessionRef.current = null;
          clearStored(SESSION_KEY);
          setRoom(null);
          setRoomId("");
          setError(response?.error || "Could not restore your game.");
          return;
        }
        setRoomId(session.roomId);
        setRoom(response.room);
        setSeenCount(response.room?.messages?.length || 0);
        setError("");
      });
    });

    socket.on("room:update", updatedRoom => {
      setRoom(updatedRoom);
      setError("");
    });

    socket.on("room:expired", () => {
      sessionRef.current = null;
      clearStored(SESSION_KEY);
      setRoom(null);
      setRoomId("");
      setChatOpen(false);
      setNotice("");
      setError("This room expired after 4 hours and its data was cleared.");
    });

    socket.on("session:replaced", () => {
      sessionRef.current = null;
      setRoom(null);
      setRoomId("");
      setChatOpen(false);
      setError("This game was opened in another tab or window.");
    });

    socket.on("connect_error", () => {
      setRestoring(false);
      setError("Cannot connect to the game server. Check the server URL and try again.");
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const messageCount = room?.messages?.length || 0;

  // Keep the chat scrolled to the newest message while it is open.
  useEffect(() => {
    if (chatOpen) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messageCount, chatOpen]);

  // While chat is open, everything counts as read.
  useEffect(() => {
    if (chatOpen) setSeenCount(messageCount);
  }, [chatOpen, messageCount]);

  // Clear the transient notice after a few seconds so it doesn't eat screen space.
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  const me = useMemo(
    () => room?.players?.find(player => sameUser(player.userId, userId)),
    [room, userId]
  );
  const isMyTurn = Boolean(room && me && room.status === "playing" && room.currentTurn === me.id);
  const selected = useMemo(() => new Set(room?.selectedNumbers || []), [room?.selectedNumbers]);
  const myLines = useMemo(() => Math.min(5, countLines(me?.board || [], selected)), [me, selected]);
  const unread = chatOpen ? 0 : Math.max(0, messageCount - seenCount);

  function joinRoom(event) {
    event.preventDefault();

    const uid = (userId || userInput).trim();
    const id = roomInput.trim().toUpperCase().replace(/\s+/g, "");

    if (!uid) return setError("Enter a User ID first.");
    if (!USER_ID_PATTERN.test(uid)) {
      return setError("User ID must be 3-20 characters: letters, numbers, dot, dash or underscore.");
    }
    if (!id) return setError("Enter a room ID first.");
    if (id.length > 24) return setError("Room IDs can be up to 24 characters.");

    const socket = socketRef.current;
    if (!socket?.connected) return setError("Connecting to the server. Please try again in a moment.");

    setJoining(true);
    setError("");

    emitJoin(socket, id, uid, response => {
      setJoining(false);
      if (!response?.ok) {
        setError(response?.error || "Could not join this room.");
        return;
      }
      writeStored(USER_KEY, uid);
      writeStored(SESSION_KEY, id);
      sessionRef.current = { userId: uid, roomId: id };
      setUserId(uid);
      setRoomId(id);
      setRoom(response.room);
      setSeenCount(response.room?.messages?.length || 0);
      setChatOpen(false);
      setNotice("");
    });
  }

  function changeUser() {
    clearStored(USER_KEY);
    clearStored(SESSION_KEY);
    sessionRef.current = null;
    setUserId("");
    setUserInput("");
    setError("");
  }

  function selectNumber(number) {
    if (!isMyTurn || selected.has(number)) return;
    socketRef.current?.emit("number:select", { number }, response => {
      if (!response?.ok) setError(response?.error || "Could not select that number.");
      else setError("");
    });
  }

  function restartGame() {
    if (restarting) return;
    setRestarting(true);
    socketRef.current?.emit("game:restart", {}, response => {
      setRestarting(false);
      if (!response?.ok) setError(response?.error || "Could not restart the game.");
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

  // Leaving only detaches this browser. The seat and game stay on the server
  // until the room expires, so you can re-enter the same Room ID and continue.
  function leaveRoom() {
    sessionRef.current = null;
    clearStored(SESSION_KEY);
    socketRef.current?.emit("room:leave", {}, () => {});
    setRoom(null);
    setRoomId("");
    setChatOpen(false);
    setError("");
    setNotice("");
  }

  if (restoring) {
    return (
      <main className="page lobby-page">
        <section className="brand">
          <div className="brand-mark">B</div>
          <h1>Buddy <span>Bingo</span></h1>
          <p className="subheading">Restoring your game…</p>
        </section>
      </main>
    );
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

          {userId ? (
            <p className="user-line">
              Playing as <strong>{userId}</strong>{" "}
              <button type="button" className="text-button" onClick={changeUser}>Not you?</button>
            </p>
          ) : (
            <>
              <p>Pick a unique User ID. It is saved in this browser so you can come back to your game.</p>
              <label htmlFor="user-id">User ID</label>
              <input
                id="user-id"
                value={userInput}
                onChange={event => setUserInput(event.target.value)}
                placeholder="e.g. pratik_01"
                maxLength={20}
                autoComplete="off"
                autoCapitalize="off"
              />
            </>
          )}

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
        <p className="footer-note">No account needed · Game data is cleared after 4 hours</p>
      </main>
    );
  }

  const activePlayer = room.players.find(player => player.id === room.currentTurn);
  const winner = room.players.find(player => player.id === room.winner);
  const iWon = Boolean(winner && sameUser(winner.userId, userId));
  // A finished game with no winner is a tie, even if the flag is missing.
  const isTie = room.status === "finished" && (Boolean(room.isTie) || !winner);
  const bothOnline = room.players.length === 2 && room.players.every(player => player.connected);
  const expiryTime = room.expiresAt
    ? new Date(room.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  let turnTitle;
  let turnHint;
  if (isMyTurn) {
    turnTitle = "Your turn — pick a number!";
    turnHint = "Tap any available number.";
  } else if (!room.currentTurn) {
    turnTitle = "Waiting for both players to connect…";
    turnHint = "A random player goes first once both are online.";
  } else {
    turnTitle = `${activePlayer?.name || "Opponent"} is picking`;
    turnHint = "The number is marked on both boards.";
  }

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
              <strong>{player.name}{sameUser(player.userId, userId) ? " (You)" : ""}</strong>
              <small>{player.connected ? "Connected" : "Reconnecting..."}</small>
            </div>
            {room.currentTurn === player.id && room.status === "playing" && <span className="turn-dot" />}
          </div>
        ))}
        {room.players.length < 2 && (
          <div className="waiting-chip"><span className="pulse-dot" /> Waiting for Player 2…</div>
        )}
      </section>

      {room.status === "waiting" ? (
        <section className="waiting-card">
          <div className="waiting-icon">⌛</div>
          <div className="waiting-text">
            <h2>Waiting for your friend</h2>
            <p>Share the room ID. The game starts when player 2 joins.</p>
          </div>
          <button className="room-code" onClick={copyRoomId}>{roomId} <span>Copy</span></button>
        </section>
      ) : room.status === "finished" ? (
        <section className="winner-banner">
          <div className="winner-trophy">{isTie ? "🤝" : "🏆"}</div>
          <div className="winner-text">
            <p className="eyebrow">{isTie ? "IT'S A TIE" : "GAME OVER"}</p>
            <h2>
              {isTie
                ? "It's a tie!"
                : iWon
                  ? "You won!"
                  : `${winner?.name || "Your opponent"} won!`}
            </h2>
            <p>
              {isTie
                ? "Both completed five lines on the same number. A random player goes first next."
                : `${winner?.name} completed five lines. ${
                    iWon ? "Your opponent goes first next." : "You go first next."
                  }`}
            </p>
            {!bothOnline && <small>Both players need to be online to restart.</small>}
          </div>
          <button
            className="primary-button restart-button"
            onClick={restartGame}
            disabled={restarting || !bothOnline}
          >
            {restarting ? "Restarting..." : "Play again"}
          </button>
        </section>
      ) : (
        <section className={`turn-banner ${isMyTurn ? "your-turn" : ""}`}>
          <span className="turn-icon">{isMyTurn ? "🎯" : "⏳"}</span>
          <div className="turn-text">
            <strong>{turnTitle}</strong>
            <small>{turnHint}</small>
          </div>
          <span className="line-count">{myLines}/5 <small>lines</small></span>
        </section>
      )}

      <div className={`game-main ${chatOpen ? "chat-is-open" : ""}`}>
        <section className="board-card">
          <div className="board-heading">
            <h2>Your board</h2>
            <span className="board-tag">5 × 5</span>
          </div>
          <div className="board-stage">
            {me && (
              <BingoBoard
                board={me.board}
                selected={selected}
                disabled={!isMyTurn || room.status !== "playing"}
                onSelect={selectNumber}
              />
            )}
          </div>
          <div className="board-legend">
            <span><i className="legend-selected" /> Selected</span>
            <span><i className="legend-available" /> Available</span>
          </div>
        </section>

        {chatOpen && (
          <section className="chat-card" aria-label="Room chat">
            <div className="chat-heading">
              <div><h2>Room chat</h2></div>
              <button className="chat-close" onClick={() => setChatOpen(false)} aria-label="Close chat">×</button>
            </div>
            <div className="messages-list">
              {room.messages.length === 0 && <p className="empty-chat">No messages yet. Say hello! 👋</p>}
              {room.messages.map(message => (
                <div className={`message ${message.system ? "system-message" : message.playerId === me?.id ? "my-message" : "their-message"}`} key={message.id}>
                  {!message.system && <strong>{message.playerId === me?.id ? "You" : message.playerName}</strong>}
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
      </div>

      <div className="game-actions">
        <button className="chat-toggle" onClick={() => setChatOpen(value => !value)}>
          <span>💬</span> {chatOpen ? "Hide chat" : "Chat"}
          {unread > 0 && <span className="chat-count">{unread}</span>}
        </button>
        <span className="footer-note game-footer">
          {room.selectedNumbers.length}/25 picked
          {expiryTime && ` · clears ${expiryTime}`}
        </span>
        <button className="text-button" onClick={leaveRoom}>Leave</button>
      </div>
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