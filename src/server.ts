import express from 'express';
import http from 'http';
import { Server } from 'socket.io';

import { WhistGame, cardToString } from './game';

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

interface Player {
  id: string;
  name: string;
  isBot: boolean;
  offline?: boolean;
  reconnectToken?: string;
}

interface Room {
  id: string;
  name: string;
  createdAt: number;
  hostId: string;
  players: Player[];
  game: WhistGame | null;
  nextHandTimer?: NodeJS.Timeout | null;
  trickPauseTimer?: NodeJS.Timeout | null;
  pauseUntil?: number | null;
  password?: string | null;
  chat?: Array<{ id: string; name: string; text: string; ts: number }>;
}

interface PublicRoom {
  id: string;
  name: string;
  createdAt: number;
  hostId: string;
  players: Array<Pick<Player, 'id' | 'name' | 'isBot' | 'offline'>>;
  inGame: boolean;
  phase: string;
  pauseUntil?: number | null;
  hasPassword?: boolean;
}

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
const rooms = new Map<string, Room>();
const socketToRoom = new Map<string, string>();
const lastActionBySocket = new Map<string, Record<string, number>>();
const lastActionByIp = new Map<string, Record<string, number>>();

function getIp(socket: { handshake: { address?: string } }): string {
  return socket.handshake.address || 'unknown';
}

function rateLimit(key: string, now: number, map: Map<string, Record<string, number>>, id: string, minMs: number): boolean {
  const entry = map.get(id) || {};
  const last = entry[key] || 0;
  if (now - last < minMs) return false;
  entry[key] = now;
  map.set(id, entry);
  return true;
}

function canAct(socket: { id: string; handshake: { address?: string } }, key: string, minMs: number): boolean {
  const now = Date.now();
  if (!rateLimit(key, now, lastActionBySocket, socket.id, minMs)) return false;
  const ip = getIp(socket);
  return rateLimit(key, now, lastActionByIp, ip, minMs);
}

function rid(len = 6): string {
  return Math.random().toString(36).slice(2, 2 + len).toUpperCase();
}

function token(len = 18): string {
  return Math.random().toString(36).slice(2, 2 + len);
}

function getRoomPublic(room: Room): PublicRoom {
  return {
    id: room.id,
    name: room.name,
    createdAt: room.createdAt,
    hostId: room.hostId,
    players: room.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot, offline: !!p.offline })),
    inGame: !!room.game,
    phase: room.game ? String(room.game.getPublicState().phase) : 'waiting',
    pauseUntil: room.pauseUntil ?? null,
    hasPassword: !!room.password,
  };
}

function broadcastLobby(): void {
  const list = Array.from(rooms.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(getRoomPublic);
  io.emit('lobby:update', list);
}

function emitRoomUpdate(room: Room): void {
  io.to(room.id).emit('room:update', getRoomPublic(room));
  broadcastLobby();
}

function scheduleAutoNextHand(room: Room, delayMs = 5000): void {
  if (!room?.game) return;
  if (room.pauseUntil && Date.now() < room.pauseUntil) return;
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

function scheduleResumeAfterTrick(room: Room, delayMs = 5000): void {
  if (!room?.game) return;
  if (room.pauseUntil && Date.now() < room.pauseUntil) return;
  if (room.game.phase !== 'trick_pause') return;
  if (room.trickPauseTimer) return;

  room.trickPauseTimer = setTimeout(() => {
    room.trickPauseTimer = null;
    if (!room.game) return;
    if (room.game.phase !== 'trick_pause') return;
    room.game.resumeAfterTrick();
    sendStateToAll(room);
    maybeBotAct(room);
  }, delayMs);
}

function getPlayer(room: Room, pid: string): Player | undefined {
  return room.players.find(p => p.id === pid);
}

function isHost(room: Room, pid: string): boolean {
  return room.hostId === pid;
}

function buildHandsViewFor(room: Room, viewerId: string): Record<string, string[]> {
  const handsByPlayer: Record<string, string[]> = {};
  if (!room.game) return handsByPlayer;

  for (const pid of room.game.playerIds) {
    const real = room.game.hands[pid].map(cardToString);
    if (pid === viewerId) {
      if (room.game.phase === 'choose_trump'
        && room.game.currentHandSize === 8
        && pid === room.game.getCurrentBidder()) {
        handsByPlayer[pid] = real.map((c, idx) => (idx < 5 ? c : 'HIDDEN'));
      } else {
        handsByPlayer[pid] = real;
      }
    } else {
      handsByPlayer[pid] = real.map(() => 'HIDDEN');
    }
  }
  return handsByPlayer;
}

function sendStateToAll(room: Room): void {
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

function sendStateToSocket(room: Room | undefined, socketId: string): void {
  if (!room?.game) return;
  const sock = io.sockets.sockets.get(socketId);
  if (!sock) return;
  const state = room.game.getPublicState();
  const handsByPlayer = buildHandsViewFor(room, socketId);
  sock.emit('game:state', { state, handsByPlayer });
}

function maybeBotAct(room: Room): void {
  if (!room.game) return;
  if (room.pauseUntil && Date.now() < room.pauseUntil) return;
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
              .reduce((s, x) => s + (typeof game.bids[x] === 'number' ? (game.bids[x] ?? 0) : 0), 0);
            const forbidden = handSize - sumOthers;
            if (est === forbidden) est = (est === handSize ? Math.max(0, handSize - 1) : est + 1);
          }

          game.placeBid(pid, est);
          sendStateToAll(room);
          maybeBotAct(room);
        } catch {
          // ignore
        }
      }, 350);
    }
  } else if (game.phase === 'playing') {
    const pid = game.getCurrentPlayer();
    if (!pid) return;
    const p = getPlayer(room, pid);
    if (p && p.isBot) {
      setTimeout(() => {
        try {
          const hand = game.hands[pid];
          let choice: typeof hand[number] | null = null;

          // Choose the lowest valid card (very simple & predictable)
          if (game.currentTrick.length === 0) {
            choice = hand[0];
          } else {
            const leadSuit = game.leadSuit;
            const sameSuit = hand.filter(c => c.suit === leadSuit);
            choice = (sameSuit.length ? sameSuit[0] : hand[0]);
          }

          if (!choice) return;
          game.playCard(pid, cardToString(choice));
          sendStateToAll(room);
          maybeBotAct(room);
        } catch {
          // ignore
        }
      }, 450);
    }
  } else if (game.phase === 'choose_trump') {
    const pid = game.getCurrentBidder();
    const p = getPlayer(room, pid);
    if (p && p.isBot) {
      setTimeout(() => {
        try {
          const hand = game.hands[pid];
          const counts: Record<string, number> = { S: 0, H: 0, D: 0, C: 0 };
          for (const c of hand) counts[c.suit] = (counts[c.suit] || 0) + 1;
          let best: 'S' | 'H' | 'D' | 'C' = 'S';
          for (const s of ['H', 'D', 'C'] as const) {
            if (counts[s] > counts[best]) best = s;
          }
          game.chooseTrump(pid, best);
          sendStateToAll(room);
          maybeBotAct(room);
        } catch {
          // ignore
        }
      }, 350);
    }
  }
}

function startGame(room: Room): void {
  const ids = room.players.map(p => p.id);
  room.game = new WhistGame({ playerIds: ids, dealerIndex: 0 });
  room.game.startHand();
  emitRoomUpdate(room);
  sendStateToAll(room);
  maybeBotAct(room);
}

function clearPauseIfAllOnline(room: Room): boolean {
  const anyOffline = room.players.some(p => !p.isBot && p.offline);
  if (!anyOffline) {
    room.pauseUntil = null;
    return true;
  }
  return false;
}

function getPlayerName(room: Room, pid: string): string {
  return room.players.find(p => p.id === pid)?.name || 'Player';
}

function cleanupRoomIfEmpty(room: Room): void {
  if (room.players.length === 0) {
    rooms.delete(room.id);
    broadcastLobby();
  }
}

io.on('connection', socket => {
  socket.on('lobby:list', () => broadcastLobby());

  socket.on('room:create', ({ roomName, playerName, password }: { roomName?: string; playerName?: string; password?: string }) => {
    try {
      if (!canAct(socket, 'room:create', 1500)) throw new Error('Prea rapid. Încearcă din nou.');
      const name = String(roomName || '').trim().slice(0, 40) || 'Room';
      const pname = String(playerName || '').trim().slice(0, 16) || 'Player';
      const pass = String(password || '').trim().slice(0, 32) || null;
      const id = rid(6);
      const rtoken = token();

      const room: Room = {
        id,
        name,
        createdAt: Date.now(),
        hostId: socket.id,
        players: [{ id: socket.id, name: pname, isBot: false, offline: false, reconnectToken: rtoken }],
        game: null,
        password: pass,
        chat: [],
      };

      rooms.set(id, room);
      socketToRoom.set(socket.id, id);
      socket.join(id);
      emitRoomUpdate(room);
      socket.emit('room:joined', { roomId: id, youId: socket.id, reconnectToken: rtoken });
    } catch (e) {
      const err = e as Error;
      socket.emit('error:msg', { message: err.message || 'Failed to create room' });
    }
  });

  socket.on('room:join', ({ roomId, playerName, reconnectToken, password }: { roomId?: string; playerName?: string; reconnectToken?: string; password?: string }) => {
    try {
      if (!canAct(socket, 'room:join', 800)) throw new Error('Prea rapid. Încearcă din nou.');
      const id = String(roomId || '').trim();
      const room = rooms.get(id);
      if (!room) throw new Error('Room not found');

      const pname = String(playerName || '').trim().slice(0, 16) || 'Player';
      const existingByToken = reconnectToken
        ? room.players.find(p => !p.isBot && p.reconnectToken === reconnectToken)
        : undefined;
      const existingOffline = existingByToken || room.players.find(p => !p.isBot && p.offline && p.name === pname);

      if (room.password && !existingByToken) {
        const pass = String(password || '').trim();
        if (!pass || pass !== room.password) throw new Error('Room password incorrect');
      }

      if (room.game && !existingByToken) {
        throw new Error('Game already started in this room');
      }

      if (existingOffline) {
        const oldId = existingOffline.id;
        existingOffline.id = socket.id;
        existingOffline.offline = false;
        if (!existingOffline.reconnectToken) existingOffline.reconnectToken = reconnectToken || token();
        if (room.game && oldId && oldId !== socket.id) {
          room.game.replacePlayerId(oldId, socket.id);
        }
        if (room.hostId === oldId) room.hostId = socket.id;
      } else {
        if (room.players.length >= 6) throw new Error('Room is full (max 6)');
        const rtoken = token();
        room.players.push({ id: socket.id, name: pname, isBot: false, offline: false, reconnectToken: rtoken });
        reconnectToken = rtoken;
      }

      socketToRoom.set(socket.id, id);
      socket.join(id);
      emitRoomUpdate(room);
      socket.emit('room:joined', {
        roomId: id,
        youId: socket.id,
        reconnectToken: existingOffline?.reconnectToken || reconnectToken,
        rejoined: !!existingOffline,
      });
      if (room.chat?.length) {
        socket.emit('chat:history', room.chat);
      }
      if (room.game) {
        sendStateToSocket(room, socket.id);
      }
      if (clearPauseIfAllOnline(room)) {
        emitRoomUpdate(room);
        if (room.game) sendStateToAll(room);
      }
    } catch (e) {
      const err = e as Error;
      socket.emit('error:msg', { message: err.message || 'Failed to join room' });
    }
  });

  socket.on('room:leave', () => {
    if (!canAct(socket, 'room:leave', 500)) return;
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    socketToRoom.delete(socket.id);
    if (!room) return;

    const leaving = room.players.find(p => p.id === socket.id);
    if (room.game && room.game.phase !== 'game_end' && leaving && !leaving.isBot) {
      leaving.offline = true;
    } else {
      room.players = room.players.filter(p => p.id !== socket.id);
    }
    socket.leave(roomId);

    if (room.hostId === socket.id && room.players.length) {
      room.hostId = room.players.find(p => !p.isBot && !p.offline)?.id || room.players[0].id;
    }

    if (room.game && room.game.phase !== 'game_end' && leaving && !leaving.isBot) {
      const until = Date.now() + 60_000;
      room.pauseUntil = Math.max(room.pauseUntil ?? 0, until);
    }

    emitRoomUpdate(room);
    cleanupRoomIfEmpty(room);
  });

  socket.on('room:addBot', () => {
    try {
      if (!canAct(socket, 'room:addBot', 800)) throw new Error('Prea rapid. Încearcă din nou.');
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) throw new Error('Not in a room');
      const room = rooms.get(roomId);
      if (!room) throw new Error('Not in a room');
      if (!isHost(room, socket.id)) throw new Error('Only host can add bots');
      if (room.game) throw new Error('Cannot add bots after game starts');
      if (room.players.length >= 6) throw new Error('Room is full (max 6)');

      const botId = `bot-${rid(6)}`;
      room.players.push({ id: botId, name: `Bot ${room.players.filter(p => p.isBot).length + 1}`, isBot: true });
      emitRoomUpdate(room);
    } catch (e) {
      const err = e as Error;
      socket.emit('error:msg', { message: err.message || 'Failed to add bot' });
    }
  });

  socket.on('game:start', () => {
    try {
      if (!canAct(socket, 'game:start', 800)) throw new Error('Prea rapid. Încearcă din nou.');
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) throw new Error('Not in a room');
      const room = rooms.get(roomId);
      if (!room) throw new Error('Not in a room');
      if (room.pauseUntil && Date.now() < room.pauseUntil) throw new Error('Game is paused for reconnect');
      if (!isHost(room, socket.id)) throw new Error('Only host can start');
      if (room.players.length < 3) throw new Error('Need at least 3 players');
      if (room.players.length > 6) throw new Error('Max 6 players');
      startGame(room);
    } catch (e) {
      const err = e as Error;
      socket.emit('error:msg', { message: err.message || 'Failed to start game' });
    }
  });

  socket.on('game:bid', ({ value }: { value?: number | string }) => {
    try {
      if (!canAct(socket, 'game:bid', 300)) throw new Error('Prea rapid. Încearcă din nou.');
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) throw new Error('Not in a room');
      const room = rooms.get(roomId);
      if (!room?.game) throw new Error('No active game');
      if (room.pauseUntil && Date.now() < room.pauseUntil) throw new Error('Game is paused for reconnect');
      room.game.placeBid(socket.id, parseInt(String(value), 10));
      sendStateToAll(room);
      maybeBotAct(room);
    } catch (e) {
      const roomId = socketToRoom.get(socket.id);
      const room = roomId ? rooms.get(roomId) : undefined;
      sendStateToSocket(room, socket.id);
      const err = e as Error;
      socket.emit('error:msg', { message: err.message || 'Bid failed' });
    }
  });

  socket.on('game:play', ({ card }: { card?: string }) => {
    try {
      if (!canAct(socket, 'game:play', 300)) throw new Error('Prea rapid. Încearcă din nou.');
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) throw new Error('Not in a room');
      const room = rooms.get(roomId);
      if (!room?.game) throw new Error('No active game');
      if (room.pauseUntil && Date.now() < room.pauseUntil) throw new Error('Game is paused for reconnect');
      const res = room.game.playCard(socket.id, String(card));
      sendStateToAll(room);
      if (res?.trickEnded && room.game.phase === 'trick_pause') {
        scheduleResumeAfterTrick(room);
      }
      scheduleAutoNextHand(room);
      maybeBotAct(room);
    } catch (e) {
      const roomId = socketToRoom.get(socket.id);
      const room = roomId ? rooms.get(roomId) : undefined;
      sendStateToSocket(room, socket.id);
      const err = e as Error;
      socket.emit('error:msg', { message: err.message || 'Play failed' });
    }
  });

  socket.on('game:chooseTrump', ({ suit }: { suit?: string }) => {
    try {
      if (!canAct(socket, 'game:chooseTrump', 400)) throw new Error('Prea rapid. Încearcă din nou.');
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) throw new Error('Not in a room');
      const room = rooms.get(roomId);
      if (!room?.game) throw new Error('No active game');
      if (room.pauseUntil && Date.now() < room.pauseUntil) throw new Error('Game is paused for reconnect');
      room.game.chooseTrump(socket.id, String(suit) as 'S' | 'H' | 'D' | 'C');
      sendStateToAll(room);
      maybeBotAct(room);
    } catch (e) {
      const roomId = socketToRoom.get(socket.id);
      const room = roomId ? rooms.get(roomId) : undefined;
      sendStateToSocket(room, socket.id);
      const err = e as Error;
      socket.emit('error:msg', { message: err.message || 'Choose trump failed' });
    }
  });

  socket.on('game:nextHand', () => {
    try {
      if (!canAct(socket, 'game:nextHand', 800)) throw new Error('Prea rapid. Încearcă din nou.');
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) throw new Error('Not in a room');
      const room = rooms.get(roomId);
      if (!room?.game) throw new Error('No active game');
      if (room.pauseUntil && Date.now() < room.pauseUntil) throw new Error('Game is paused for reconnect');
      if (!isHost(room, socket.id)) throw new Error('Only host can continue');
      room.game.nextHand();
      emitRoomUpdate(room);
      sendStateToAll(room);
      maybeBotAct(room);
    } catch (e) {
      const err = e as Error;
      socket.emit('error:msg', { message: err.message || 'Cannot start next hand' });
    }
  });

  socket.on('chat:send', ({ text }: { text?: string }) => {
    try {
      if (!canAct(socket, 'chat:send', 300)) throw new Error('Prea rapid. Încearcă din nou.');
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) throw new Error('Not in a room');
      const room = rooms.get(roomId);
      if (!room) throw new Error('Not in a room');
      const msg = String(text || '').trim().slice(0, 240);
      if (!msg) return;
      const entry = {
        id: token(10),
        name: getPlayerName(room, socket.id),
        text: msg,
        ts: Date.now(),
      };
      if (!room.chat) room.chat = [];
      room.chat.push(entry);
      if (room.chat.length > 120) room.chat.shift();
      io.to(roomId).emit('chat:message', entry);
    } catch (e) {
      const err = e as Error;
      socket.emit('error:msg', { message: err.message || 'Chat failed' });
    }
  });

  socket.on('disconnect', () => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    socketToRoom.delete(socket.id);
    if (!room) return;

    const p = room.players.find(x => x.id === socket.id);
    if (p) p.offline = true;

    const onlineHumans = room.players.filter(x => !x.isBot && !x.offline);
    if (room.hostId === socket.id && onlineHumans.length) {
      room.hostId = onlineHumans[0].id;
    }
    if (room.game && room.game.phase !== 'game_end') {
      const until = Date.now() + 60_000;
      room.pauseUntil = Math.max(room.pauseUntil ?? 0, until);
    }
    // keep game state; allow reconnect within pause window
    emitRoomUpdate(room);
    cleanupRoomIfEmpty(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Whist server listening on http://localhost:${PORT}`));
