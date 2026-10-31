
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

const rooms = new Map();

const DISCONNECT_GRACE_MS = 60_000;
const ROOM_CLEANUP_DELAY_MS = 10_000;

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
      name: player.name,
      board: player.board,
      connected: Boolean(player.socketId),
    })),

    selectedNumbers: [...room.selectedNumbers],
    currentTurn: room.currentTurn,
    winner: room.winner,
    messages: room.messages.slice(-60),
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

// Find a player using their active socket ID.
function findPlayer(room, socketId) {
  return room.players.find(
    player => player.socketId === socketId
  );
}

// Remove a room if it has no players.
function removeEmptyRoom(room) {
  if (room.players.length === 0) {
    rooms.delete(room.roomId);
  }
}

// Automatically clean up a finished game.
function cleanupFinishedRoom(room) {
  setTimeout(() => {
    // Make sure the room has not been replaced.
    if (rooms.get(room.roomId) !== room) {
      return;
    }

    if (room.status !== "finished") {
      return;
    }

    // Clear player disconnect timers and release sockets.
    room.players.forEach(player => {
      if (player.disconnectTimer) {
        clearTimeout(player.disconnectTimer);
        player.disconnectTimer = null;
      }

      if (player.socketId) {
        const playerSocket = io.sockets.sockets.get(
          player.socketId
        );

        if (playerSocket) {
          playerSocket.leave(room.roomId);

          playerSocket.data.roomId = null;
          playerSocket.data.playerToken = null;
        }
      }
    });

    // Clear all game data.
    room.players = [];
    room.selectedNumbers = [];
    room.messages = [];
    room.currentTurn = null;
    room.winner = null;

    // Delete the room from server memory.
    rooms.delete(room.roomId);

    console.log(
      `Finished room ${room.roomId} cleaned up successfully.`
    );
  }, ROOM_CLEANUP_DELAY_MS);
}

io.on("connection", socket => {

  // JOIN ROOM
  socket.on(
    "room:join",
    (payload = {}, callback = () => {}) => {
      const roomId = cleanRoomId(payload.roomId);

      if (!roomId || roomId.length > 24) {
        callback({
          ok: false,
          error: "Enter a room ID between 1 and 24 characters.",
        });

        return;
      }

      let room = rooms.get(roomId);

      if (!room) {
        room = {
          roomId,
          players: [],
          selectedNumbers: [],
          currentTurn: null,
          status: "waiting",
          winner: null,
          messages: [],
        };

        rooms.set(roomId, room);
      }

      // Attempt to restore a previously reserved player seat.
      const token = String(payload.playerToken || "");

      let player = token
        ? room.players.find(item => item.token === token)
        : null;

      if (player) {
        if (
          player.socketId &&
          player.socketId !== socket.id
        ) {
          callback({
            ok: false,
            error: "That player is already connected in this room.",
          });

          return;
        }

        player.socketId = socket.id;

        if (player.disconnectTimer) {
          clearTimeout(player.disconnectTimer);
        }

        player.disconnectTimer = null;
      } else {
        if (room.players.length >= 2) {
          callback({
            ok: false,
            error: "This room is full. Only two players can join.",
          });

          return;
        }

        if (room.status === "finished") {
          callback({
            ok: false,
            error: "This game has finished. Create a new room to play again.",
          });

          return;
        }

        player = {
          id: randomUUID(),
          token: randomUUID(),
          name: `Player ${room.players.length + 1}`,
          board: makeBoard(),
          socketId: socket.id,
          disconnectTimer: null,
        };

        room.players.push(player);
      }

      socket.join(roomId);

      socket.data.roomId = roomId;
      socket.data.playerToken = player.token;

      // Start the game when both players have joined.
      if (
        room.players.length === 2 &&
        room.status === "waiting"
      ) {
        room.status = "playing";

        room.currentTurn =
          room.players[
            Math.floor(Math.random() * 2)
          ].id;

        room.messages.push({
          id: randomUUID(),
          system: true,
          text: `${
            room.players.find(
              item => item.id === room.currentTurn
            ).name
          } goes first!`,
          createdAt: new Date().toISOString(),
        });
      }

      callback({
        ok: true,
        playerToken: player.token,
        playerId: player.id,
        room: serializeRoom(room),
      });

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
        const nextPlayer = room.players.find(
          item =>
            item.id !== player.id &&
            item.socketId
        );

        room.currentTurn = nextPlayer?.id || null;
      }

      callback({ ok: true });

      // Notify both players before cleaning up.
      sendRoom(room);

      // Schedule cleanup after the game finishes.
      if (room.status === "finished") {
        cleanupFinishedRoom(room);
      }
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

  // HANDLE PLAYER DISCONNECTION
  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomId);

    if (!room) {
      return;
    }

    const player = findPlayer(room, socket.id);

    if (!player) {
      return;
    }

    player.socketId = null;

    player.disconnectTimer = setTimeout(() => {
      const currentRoom = rooms.get(room.roomId);

      if (!currentRoom) {
        return;
      }

      const index = currentRoom.players.findIndex(
        item => item.token === player.token
      );

      if (
        index !== -1 &&
        !currentRoom.players[index].socketId
      ) {
        currentRoom.players.splice(index, 1);

        if (currentRoom.status === "playing") {
          currentRoom.status = "waiting";
          currentRoom.currentTurn = null;
          currentRoom.selectedNumbers = [];
          currentRoom.winner = null;

          currentRoom.messages.push({
            id: randomUUID(),
            system: true,
            text: "A player left. The room is waiting for another player; the game will restart when they join.",
            createdAt: new Date().toISOString(),
          });
        }

        removeEmptyRoom(currentRoom);

        if (rooms.has(currentRoom.roomId)) {
          sendRoom(currentRoom);
        }
      }
    }, DISCONNECT_GRACE_MS);

    if (room.currentTurn === player.id) {
      room.currentTurn = null;
    }

    sendRoom(room);
  });
});

server.listen(PORT, () => {
  console.log(
    `Bingo server listening on http://localhost:${PORT}`
  );
});