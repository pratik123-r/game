import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { randomUUID } from "node:crypto";

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3001;

// roomId -> room. The backend is the single source of truth.
const rooms = new Map();

// All room data is wiped this long after the room was created.
const ROOM_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const SWEEP_INTERVAL_MS = 60 * 1000; // check every minute

const USER_ID_PATTERN = /^[A-Za-z0-9_.-]{3,20}$/;

const WINNING_LINES = [];

// Rows
for (let row = 0; row < 5; row++) {
  WINNING_LINES.push(
    Array.from({ length: 5 }, (_, col) => row * 5 + col)
  );
}

// Columns
for (let col = 0; col < 5; col++) {
  WINNING_LINES.push(
    Array.from({ length: 5 }, (_, row) => row * 5 + col)
  );
}

// Diagonals
WINNING_LINES.push(
  [0, 6, 12, 18, 24],
  [4, 8, 12, 16, 20]
);

// Generate a random 5x5 board.
function makeBoard() {
  const numbers = Array.from(
    { length: 25 },
    (_, index) => index + 1
  );

  for (let i = numbers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [numbers[i], numbers[j]] = [
      numbers[j],
      numbers[i],
    ];
  }

  return numbers;
}

// Count completed lines on a player's board.
function countLines(board, selectedNumbers) {
  const selected = new Set(selectedNumbers);

  const markedIndexes = new Set(
    board
      .map((number, index) =>
        selected.has(number) ? index : -1
      )
      .filter(index => index >= 0)
  );

  return WINNING_LINES.filter(line =>
    line.every(index => markedIndexes.has(index))
  ).length;
}

// Convert room data into a client-safe object.
function serializeRoom(room) {
  return {
    roomId: room.roomId,
    status: room.status,

    players: room.players.map(player => ({
      id: player.id,
      userId: player.userId,
      name: player.name,
      board: player.board,
      connected: Boolean(player.socketId),
    })),

    selectedNumbers: [...room.selectedNumbers],
    currentTurn: room.currentTurn,
    winner: room.winner,
    messages: room.messages.slice(-60),
    expiresAt: room.expiresAt,
  };
}

// Broadcast updated room state.
function sendRoom(room) {
  io.to(room.roomId).emit(
    "room:update",
    serializeRoom(room)
  );
}

// Normalize room IDs.
function cleanRoomId(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

// Normalize user IDs (case is kept for display, compared case-insensitively).
function cleanUserId(value) {
  return String(value || "").trim();
}

// Find a player using their active socket ID.
function findPlayer(room, socketId) {
  return room.players.find(
    player => player.socketId === socketId
  );
}

function isExpired(room) {
  return Date.now() >= room.expiresAt;
}

// True only when the room has two players and both are online.
function bothConnected(room) {
  return (
    room.players.length === 2 &&
    room.players.every(player => Boolean(player.socketId))
  );
}

// Give a random first turn, but only once BOTH players are connected.
// Does nothing if a turn is already set, the game is not running,
// or someone is still offline (it is retried on every join/reconnect).
function assignRandomTurn(room) {
  if (
    room.status !== "playing" ||
    room.currentTurn ||
    !bothConnected(room)
  ) {
    return false;
  }

  const first =
    room.players[Math.floor(Math.random() * 2)];

  room.currentTurn = first.id;

  room.messages.push({
    id: randomUUID(),
    system: true,
    text: `${first.name} goes first!`,
    createdAt: new Date().toISOString(),
  });

  return true;
}

// Detach a socket from whatever room it is in. The player's seat, board
// and the game state are kept so they can come back (refresh/reconnect).
function detachSocket(socket) {
  const roomId = socket.data.roomId;

  socket.data.roomId = null;
  socket.data.userKey = null;

  if (!roomId) {
    return;
  }

  socket.leave(roomId);

  const room = rooms.get(roomId);

  if (!room) {
    return;
  }

  const player = findPlayer(room, socket.id);

  if (!player) {
    return;
  }

  player.socketId = null;

  sendRoom(room);
}

// Permanently delete a room and release everyone in it.
function destroyRoom(room, reason) {
  io.to(room.roomId).emit("room:expired", { reason });

  room.players.forEach(player => {
    if (!player.socketId) {
      return;
    }

    const playerSocket = io.sockets.sockets.get(player.socketId);

    if (playerSocket) {
      playerSocket.leave(room.roomId);
      playerSocket.data.roomId = null;
      playerSocket.data.userKey = null;
    }
  });

  room.players = [];
  room.selectedNumbers = [];
  room.messages = [];
  room.currentTurn = null;
  room.winner = null;

  rooms.delete(room.roomId);

  console.log(`Room ${room.roomId} cleared (${reason}).`);
}

// Sweep: delete every room older than 4 hours.
const sweeper = setInterval(() => {
  for (const room of [...rooms.values()]) {
    if (isExpired(room)) {
      destroyRoom(room, "expired after 4 hours");
    }
  }
}, SWEEP_INTERVAL_MS);

sweeper.unref();

io.on("connection", socket => {

  // JOIN ROOM (new player, or existing player restoring their seat)
  socket.on(
    "room:join",
    (payload = {}, callback = () => {}) => {
      const roomId = cleanRoomId(payload.roomId);
      const userId = cleanUserId(payload.userId);

      if (!roomId || roomId.length > 24) {
        return callback({
          ok: false,
          error: "Enter a room ID between 1 and 24 characters.",
        });
      }

      if (!USER_ID_PATTERN.test(userId)) {
        return callback({
          ok: false,
          error:
            "User ID must be 3-20 characters: letters, numbers, dot, dash or underscore.",
        });
      }

      const userKey = userId.toLowerCase();

      let room = rooms.get(roomId);

      // An expired room is treated as non-existent.
      if (room && isExpired(room)) {
        destroyRoom(room, "expired after 4 hours");
        room = null;
      }

      if (!room) {
        const now = Date.now();

        room = {
          roomId,
          players: [],
          selectedNumbers: [],
          currentTurn: null,
          status: "waiting",
          winner: null,
          messages: [],
          createdAt: now,
          expiresAt: now + ROOM_TTL_MS,
        };

        rooms.set(roomId, room);
      }

      // If this socket was sitting in a different room, release that seat.
      if (
        socket.data.roomId &&
        socket.data.roomId !== roomId
      ) {
        detachSocket(socket);
      }

      // Existing player in this room with the same User ID?
      let player = room.players.find(
        item => item.userKey === userKey
      );

      if (player) {
        // Same user opened the room again (refresh / new tab):
        // take over the seat and drop the stale connection.
        if (player.socketId && player.socketId !== socket.id) {
          const oldSocket = io.sockets.sockets.get(
            player.socketId
          );

          if (oldSocket) {
            oldSocket.emit("session:replaced");
            oldSocket.leave(roomId);
            oldSocket.data.roomId = null;
            oldSocket.data.userKey = null;
          }
        }

        player.socketId = socket.id;
      } else {
        if (room.players.length >= 2) {
          return callback({
            ok: false,
            error: "This room is full. Only two players can join.",
          });
        }

        if (room.status === "finished") {
          return callback({
            ok: false,
            error: "This game has finished. Create a new room to play again.",
          });
        }

        player = {
          id: randomUUID(),
          userId,
          userKey,
          name: userId,
          board: makeBoard(),
          socketId: socket.id,
        };

        room.players.push(player);
      }

      socket.join(roomId);

      socket.data.roomId = roomId;
      socket.data.userKey = userKey;

      // Start the game when both players have joined.
      if (
        room.players.length === 2 &&
        room.status === "waiting"
      ) {
        room.status = "playing";
        room.currentTurn = null;
      }

      // Random first turn - only once both players are connected.
      // Also covers the case where the game started while one player
      // was offline: the turn is given as soon as they reconnect.
      assignRandomTurn(room);

      callback({
        ok: true,
        playerId: player.id,
        room: serializeRoom(room),
      });

      sendRoom(room);
    }
  );

  // LEAVE ROOM (seat and game state are kept until the room expires)
  socket.on("room:leave", (_payload, callback = () => {}) => {
    detachSocket(socket);
    callback({ ok: true });
  });

  // RESTART GAME (only after a game has finished)
  // New boards, cleared numbers, and the player who LOST goes first.
  socket.on(
    "game:restart",
    (_payload, callback = () => {}) => {
      const room = rooms.get(socket.data.roomId);

      if (!room) {
        return callback({
          ok: false,
          error: "Room not found.",
        });
      }

      const player = findPlayer(room, socket.id);

      if (!player) {
        return callback({
          ok: false,
          error: "You are not an active player in this room.",
        });
      }

      if (room.status !== "finished") {
        return callback({
          ok: false,
          error: "The game has not finished yet.",
        });
      }

      if (room.players.length !== 2) {
        return callback({
          ok: false,
          error: "Both players are needed to restart.",
        });
      }

      const loser = room.players.find(
        item => item.id !== room.winner
      );

      room.players.forEach(item => {
        item.board = makeBoard();
      });

      room.selectedNumbers = [];
      room.winner = null;
      room.status = "playing";
      room.currentTurn = loser.id;

      room.messages.push({
        id: randomUUID(),
        system: true,
        text: `New game started! ${loser.name} lost the last game, so they go first.`,
        createdAt: new Date().toISOString(),
      });

      room.messages = room.messages.slice(-100);

      callback({ ok: true });

      sendRoom(room);
    }
  );

  // SELECT NUMBER
  socket.on(
    "number:select",
    (payload = {}, callback = () => {}) => {
      const room = rooms.get(socket.data.roomId);

      if (!room) {
        return callback({
          ok: false,
          error: "Room not found.",
        });
      }

      const player = findPlayer(room, socket.id);

      if (!player) {
        return callback({
          ok: false,
          error: "You are not an active player in this room.",
        });
      }

      if (room.status !== "playing") {
        return callback({
          ok: false,
          error: "The game is not currently active.",
        });
      }

      if (room.currentTurn !== player.id) {
        return callback({
          ok: false,
          error: "It is not your turn.",
        });
      }

      const number = Number(payload.number);

      if (
        !Number.isInteger(number) ||
        number < 1 ||
        number > 25
      ) {
        return callback({
          ok: false,
          error: "Choose a number from 1 to 25.",
        });
      }

      if (room.selectedNumbers.includes(number)) {
        return callback({
          ok: false,
          error: "That number has already been selected.",
        });
      }

      room.selectedNumbers.push(number);

      const lines = countLines(
        player.board,
        room.selectedNumbers
      );

      // Check whether the current player has won.
      if (lines >= 5) {
        room.status = "finished";
        room.winner = player.id;
        room.currentTurn = null;

        room.messages.push({
          id: randomUUID(),
          system: true,
          text: `${player.name} completed five lines and won!`,
          createdAt: new Date().toISOString(),
        });
      } else {
        // Pass the turn to the other player, even if they are
        // temporarily disconnected (they can refresh and continue).
        const nextPlayer = room.players.find(
          item => item.id !== player.id
        );

        room.currentTurn = nextPlayer?.id || null;
      }

      callback({ ok: true });

      sendRoom(room);
    }
  );

  // SEND CHAT MESSAGE
  socket.on(
    "chat:send",
    (payload = {}, callback = () => {}) => {
      const room = rooms.get(socket.data.roomId);

      if (!room) {
        return callback({
          ok: false,
          error: "Room not found.",
        });
      }

      const player = findPlayer(room, socket.id);

      if (!player) {
        return callback({
          ok: false,
          error: "You are not an active player in this room.",
        });
      }

      const message = String(
        payload.message || ""
      )
        .trim()
        .slice(0, 300);

      if (!message) {
        return callback({
          ok: false,
          error: "Type a message first.",
        });
      }

      room.messages.push({
        id: randomUUID(),
        playerId: player.id,
        playerName: player.name,
        text: message,
        createdAt: new Date().toISOString(),
      });

      room.messages = room.messages.slice(-100);

      callback({ ok: true });

      sendRoom(room);
    }
  );

  // HANDLE DISCONNECTION
  // The player keeps their seat, board and turn. They only get marked
  // as "Reconnecting..." until they come back with the same User ID.
  socket.on("disconnect", () => {
    detachSocket(socket);
  });
});

server.listen(PORT, () => {
  console.log(
    `Bingo server listening on http://localhost:${PORT}`
  );
});