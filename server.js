const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { WhistGame, cardToString } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

/**
 * Rooms
 * roomId => {
 *   id,
 *   name,
 *   createdAt,
 *   hostId,
 *   players: [{id, name, isBot}],
 *   game: WhistGame|null,
 * }
 */
const rooms = new Map();
const socketToRoom = new Map();

function rid(len = 6) {
  return Math.random().toString(36).slice(2, 2 + len).toUpperCase();
}

function getRoomPublic(room) {
  return {
    id: room.id,
    name: room.name,
    createdAt: room.createdAt,
    hostId: room.hostId,
    players: room.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot })),
    inGame: !!room.game,
    phase: room.game ? room.game.getPublicState().phase : 'waiting',
  };
}

function broadcastLobby() {
  const list = Array.from(rooms.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(getRoomPublic);
  io.emit('lobby:update', list);
}

function emitRoomUpdate(room) {
  io.to(room.id).emit('room:update', getRoomPublic(room));
  broadcastLobby();
}

function scheduleAutoNextHand(room, delayMs = 5000) {
  if (!room?.game) return;
  if (room.game.phase !== 'hand_end') return;
  if (room.nextHandTimer) return;

  room.nextHandTimer = setTimeout(() => {
    room.nextHandTimer = null;
    if (!room.game) return;
    if (room.game.phase !== 'hand_end') return;
    room.game.nextHand();
    emitRoomUpdate(room);
    sendStateToAll(room);
    maybeBotAct(room);
  }, delayMs);
}

function getPlayer(room, pid) {
  return room.players.find(p => p.id === pid);
}

function isHost(room, pid) {
  return room.hostId === pid;
}

function buildHandsViewFor(room, viewerId) {
  const handsByPlayer = {};
  for (const pid of room.game.playerIds) {
    const real = room.game.hands[pid].map(cardToString);
    handsByPlayer[pid] = (pid === viewerId) ? real : real.map(() => 'HIDDEN');
  }
  return handsByPlayer;
}

function sendStateToAll(room) {
  if (!room.game) return;
  const state = room.game.getPublicState();

  // Privacy: each human player sees only their own hand; others are hidden card-backs.
  for (const p of room.players) {
    if (p.isBot) continue;
    const viewerId = p.id; // human players use socket.id as player id
    const sock = io.sockets.sockets.get(viewerId);
    if (!sock) continue;
    const handsByPlayer = buildHandsViewFor(room, viewerId);
    sock.emit('game:state', { state, handsByPlayer });
  }
}

function sendStateToSocket(room, socketId) {
  if (!room?.game) return;
  const sock = io.sockets.sockets.get(socketId);
  if (!sock) return;
  const state = room.game.getPublicState();
  const handsByPlayer = buildHandsViewFor(room, socketId);
  sock.emit('game:state', { state, handsByPlayer });
}

function maybeBotAct(room) {
  if (!room.game) return;
  const game = room.game;

  if (game.phase === 'bidding') {
    const pid = game.getCurrentBidder();
    const p = getPlayer(room, pid);
    if (p && p.isBot) {
      setTimeout(() => {
        try {
          const handSize = game.currentHandSize;
          const hand = game.hands[pid];
          let est = hand.filter(c => c.rank >= 11).length;
          est = Math.max(0, Math.min(handSize, est));

          // If dealer, avoid forbidden sum.
          if (pid === game.playerIds[game.dealerIndex]) {
            const sumOthers = game.playerIds
              .filter(x => x !== pid)
              .reduce((s, x) => s + (typeof game.bids[x] === 'number' ? game.bids[x] : 0), 0);
            const forbidden = handSize - sumOthers;
            if (est === forbidden) est = (est === handSize ? Math.max(0, handSize - 1) : est + 1);
          }

          game.placeBid(pid, est);
          sendStateToAll(room);
          maybeBotAct(room);
        } catch (e) {
          // ignore
        }
      }, 350);
    }
  } else if (game.phase === 'playing') {
    const pid = game.getCurrentPlayer();
    const p = getPlayer(room, pid);
    if (p && p.isBot) {
      setTimeout(() => {
        try {
          const hand = game.hands[pid];
          let choice = null;

          // Choose the lowest valid card (very simple & predictable)
          if (game.currentTrick.length === 0) {
            choice = hand[0];
          } else {
            const leadSuit = game.leadSuit;
            const sameSuit = hand.filter(c => c.suit === leadSuit);
            choice = (sameSuit.length ? sameSuit[0] : hand[0]);
          }

          game.playCard(pid, cardToString(choice));
          sendStateToAll(room);
          maybeBotAct(room);
        } catch (e) {
          // ignore
        }
      }, 450);
    }
  }
}

function startGame(room) {
  const ids = room.players.map(p => p.id);
  room.game = new WhistGame({ playerIds: ids, dealerIndex: 0 });
  room.game.startHand();
  emitRoomUpdate(room);
  sendStateToAll(room);
  maybeBotAct(room);
}

function cleanupRoomIfEmpty(room) {
  if (room.players.length === 0) {
    rooms.delete(room.id);
    broadcastLobby();
  }
}

io.on('connection', socket => {
  socket.on('lobby:list', () => broadcastLobby());

  socket.on('room:create', ({ roomName, playerName }) => {
    try {
      const name = String(roomName || '').trim().slice(0, 40) || 'Room';
      const pname = String(playerName || '').trim().slice(0, 16) || 'Player';
      const id = rid(6);

      const room = {
        id,
        name,
        createdAt: Date.now(),
        hostId: socket.id,
        players: [{ id: socket.id, name: pname, isBot: false }],
        game: null,
      };

      rooms.set(id, room);
      socketToRoom.set(socket.id, id);
      socket.join(id);
      emitRoomUpdate(room);
      socket.emit('room:joined', { roomId: id, youId: socket.id });
    } catch (e) {
      socket.emit('error:msg', { message: e.message || 'Failed to create room' });
    }
  });

  socket.on('room:join', ({ roomId, playerName }) => {
    try {
      const id = String(roomId || '').trim();
      const room = rooms.get(id);
      if (!room) throw new Error('Room not found');
      if (room.game) throw new Error('Game already started in this room');
      if (room.players.length >= 6) throw new Error('Room is full (max 6)');

      const pname = String(playerName || '').trim().slice(0, 16) || 'Player';
      room.players.push({ id: socket.id, name: pname, isBot: false });

      socketToRoom.set(socket.id, id);
      socket.join(id);
      emitRoomUpdate(room);
      socket.emit('room:joined', { roomId: id, youId: socket.id });
    } catch (e) {
      socket.emit('error:msg', { message: e.message || 'Failed to join room' });
    }
  });

  socket.on('room:leave', () => {
    const rid = socketToRoom.get(socket.id);
    if (!rid) return;
    const room = rooms.get(rid);
    socketToRoom.delete(socket.id);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(rid);

    if (room.hostId === socket.id && room.players.length) {
      room.hostId = room.players.find(p => !p.isBot)?.id || room.players[0].id;
    }

    // no mid-game reconnect handling tonight
    if (room.game) room.game.phase = 'game_end';

    emitRoomUpdate(room);
    cleanupRoomIfEmpty(room);
  });

  socket.on('room:addBot', () => {
    try {
      const rid = socketToRoom.get(socket.id);
      const room = rooms.get(rid);
      if (!room) throw new Error('Not in a room');
      if (!isHost(room, socket.id)) throw new Error('Only host can add bots');
      if (room.game) throw new Error('Cannot add bots after game starts');
      if (room.players.length >= 6) throw new Error('Room is full (max 6)');

      const botId = `bot-${rid(6)}`;
      room.players.push({ id: botId, name: `Bot ${room.players.filter(p => p.isBot).length + 1}`, isBot: true });
      emitRoomUpdate(room);
    } catch (e) {
      socket.emit('error:msg', { message: e.message || 'Failed to add bot' });
    }
  });

  socket.on('game:start', () => {
    try {
      const rid = socketToRoom.get(socket.id);
      const room = rooms.get(rid);
      if (!room) throw new Error('Not in a room');
      if (!isHost(room, socket.id)) throw new Error('Only host can start');
      if (room.players.length < 3) throw new Error('Need at least 3 players');
      if (room.players.length > 6) throw new Error('Max 6 players');
      startGame(room);
    } catch (e) {
      socket.emit('error:msg', { message: e.message || 'Failed to start game' });
    }
  });

  socket.on('game:bid', ({ value }) => {
    try {
      const rid = socketToRoom.get(socket.id);
      const room = rooms.get(rid);
      if (!room?.game) throw new Error('No active game');
      room.game.placeBid(socket.id, parseInt(value, 10));
      sendStateToAll(room);
      maybeBotAct(room);
    } catch (e) {
      const rid = socketToRoom.get(socket.id);
      const room = rooms.get(rid);
      sendStateToSocket(room, socket.id);
      socket.emit('error:msg', { message: e.message || 'Bid failed' });
    }
  });

  socket.on('game:play', ({ card }) => {
    try {
      const rid = socketToRoom.get(socket.id);
      const room = rooms.get(rid);
      if (!room?.game) throw new Error('No active game');
      room.game.playCard(socket.id, String(card));
      sendStateToAll(room);
      scheduleAutoNextHand(room);
      maybeBotAct(room);
    } catch (e) {
      const rid = socketToRoom.get(socket.id);
      const room = rooms.get(rid);
      sendStateToSocket(room, socket.id);
      socket.emit('error:msg', { message: e.message || 'Play failed' });
    }
  });

  socket.on('game:nextHand', () => {
    try {
      const rid = socketToRoom.get(socket.id);
      const room = rooms.get(rid);
      if (!room?.game) throw new Error('No active game');
      if (!isHost(room, socket.id)) throw new Error('Only host can continue');
      room.game.nextHand();
      emitRoomUpdate(room);
      sendStateToAll(room);
      maybeBotAct(room);
    } catch (e) {
      socket.emit('error:msg', { message: e.message || 'Cannot start next hand' });
    }
  });

  socket.on('disconnect', () => {
    const rid = socketToRoom.get(socket.id);
    if (!rid) return;
    const room = rooms.get(rid);
    socketToRoom.delete(socket.id);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.hostId === socket.id && room.players.length) {
      room.hostId = room.players.find(p => !p.isBot)?.id || room.players[0].id;
    }
    if (room.game) room.game.phase = 'game_end';
    emitRoomUpdate(room);
    cleanupRoomIfEmpty(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Whist server listening on http://localhost:${PORT}`));
