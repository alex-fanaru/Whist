/* global io */
const socket = io();

// Views
const viewLobby = document.getElementById('viewLobby');
const viewRoom = document.getElementById('viewRoom');
const viewGame = document.getElementById('viewGame');

// Lobby
const connStatus = document.getElementById('connStatus');
const createName = document.getElementById('createName');
const createRoom = document.getElementById('createRoom');
const btnCreate = document.getElementById('btnCreate');
const joinName = document.getElementById('joinName');
const btnRefresh = document.getElementById('btnRefresh');
const roomsList = document.getElementById('roomsList');

// Room
const roomTitle = document.getElementById('roomTitle');
const roomMeta = document.getElementById('roomMeta');
const playersList = document.getElementById('playersList');
const btnLeave = document.getElementById('btnLeave');
const btnAddBot = document.getElementById('btnAddBot');
const btnStart = document.getElementById('btnStart');
const roomNotice = document.getElementById('roomNotice');

// Game
const gameRoomTitle = document.getElementById('gameRoomTitle');
const gameInfo = document.getElementById('gameInfo');
const btnLeaveFromGame = document.getElementById('btnLeaveFromGame');
const phasePill = document.getElementById('phasePill');
const handPill = document.getElementById('handPill');
const trumpPill = document.getElementById('trumpPill');
const turnPill = document.getElementById('turnPill');
const tableEl = document.getElementById('table');
const trickArea = document.getElementById('trickArea');

const bidArea = document.getElementById('bidArea');
const bidButtons = document.getElementById('bidButtons');
const btnBid = document.getElementById('btnBid');
const bidHint = document.getElementById('bidHint');
const trumpArea = document.getElementById('trumpArea');
const trumpButtons = document.getElementById('trumpButtons');
const trumpHint = document.getElementById('trumpHint');

const handEndArea = document.getElementById('handEndArea');
const handSummary = document.getElementById('handSummary');
const btnNextHand = document.getElementById('btnNextHand');

const gameEndArea = document.getElementById('gameEndArea');
const finalLeaderboard = document.getElementById('finalLeaderboard');
const bidsList = document.getElementById('bidsList');
const scoreList = document.getElementById('scoreList');
const bidHintLeft = document.getElementById('bidHintLeft');
const btnBackToLobby = document.getElementById('btnBackToLobby');

// Toast
const toast = document.getElementById('toast');
let toastTimer = null;
function showToast(msg, ms = 2200) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), ms);
}

// State
let currentRoomId = null;
let youId = null;
let rooms = [];
let room = null;
let state = null;
let handsByPlayer = {};
let selectedBidValue = null;

function canBidNow() {
  return !!(state && youId && state.phase === 'bidding' && state.currentBidderId === youId);
}

function show(view) {
  viewLobby.classList.add('hidden');
  viewRoom.classList.add('hidden');
  viewGame.classList.add('hidden');
  view.classList.remove('hidden');
}

function suitName(s) {
  switch (s) {
    case 'S': return '♠';
    case 'H': return '♥';
    case 'D': return '♦';
    case 'C': return '♣';
    default: return s;
  }
}

function isRedSuit(s) {
  return s === 'H' || s === 'D';
}

function cardLabel(cardStr) {
  const suit = cardStr.slice(-1);
  const rank = cardStr.slice(0, -1);
  return `${rank}${suitName(suit)}`;
}


function cardToImageCandidates(cardStr) {
  // cardStr: "AS", "10H", "QD" etc.
  const suit = cardStr.slice(-1);
  const rank = cardStr.slice(0, -1);

  const suitMap = { S: ['spades'], H: ['hearts'], D: ['diamonds', 'diamods'], C: ['clubs', 'cubs'] };

  // Most of your set: ace_of_spades.png, 2_of_spades.png etc.
  // Face cards have a trailing "2": jack_of_spades2.png etc (and some suit typos).
  const baseSuitNames = suitMap[suit] || [suit.toLowerCase()];

  const lowerRank = rank.toLowerCase();

  const candidates = [];
  if (rank === 'A') {
    for (const sn of baseSuitNames) candidates.push(`ace_of_${sn}.png`);
  } else if (rank === 'K' || rank === 'Q' || rank === 'J') {
    const face = rank === 'K' ? 'king' : (rank === 'Q' ? 'queen' : 'jack');
    for (const sn of baseSuitNames) {
      candidates.push(`${face}_of_${sn}2.png`);
      candidates.push(`${face}_of_${sn}.png`);
    }
  } else {
    // numeric ranks: 2..10
    for (const sn of baseSuitNames) candidates.push(`${lowerRank}_of_${sn}.png`);
  }

  return candidates;
}

function createCardFaceEl(cardStr) {
  const wrap = document.createElement('div');
  wrap.className = 'cardBtn';
  const img = document.createElement('img');
  img.className = 'cardImg';

  const candidates = cardToImageCandidates(cardStr);
  let idx = 0;

  const setNext = () => {
    if (idx >= candidates.length) {
      // Fallback to text
      wrap.innerHTML = '';
      wrap.className = `cardBtn ${isRedSuit(cardStr.slice(-1)) ? 'red' : 'black'}`;
      wrap.textContent = cardLabel(cardStr);
      return;
    }
    // Use a relative asset URL so it works even when the app is hosted under a subpath.
    img.src = new URL(`cards/${candidates[idx++]}`, window.location.href).toString();
  };

  img.onerror = () => setNext();
  img.alt = cardStr;
  wrap.appendChild(img);
  setNext();
  return wrap;
}

function createCardBackEl() {
  const wrap = document.createElement('div');
  wrap.className = 'cardBtn back';
  return wrap;
}


function renderRooms() {
  roomsList.innerHTML = '';
  if (!rooms.length) {
    const p = document.createElement('div');
    p.className = 'muted';
    p.textContent = 'Niciun room încă. Creează unul!';
    roomsList.appendChild(p);
    return;
  }

  for (const r of rooms) {
    const el = document.createElement('div');
    el.className = 'roomItem';

    const left = document.createElement('div');
    const title = document.createElement('div');
    title.textContent = `${r.name} (${r.players.length}/6)`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = r.inGame ? `În joc (${r.phase})` : 'În așteptare';
    left.appendChild(title);
    left.appendChild(meta);

    const btn = document.createElement('button');
    btn.textContent = r.inGame ? 'Locked' : 'Join';
    btn.disabled = r.inGame;
    btn.onclick = () => {
      const name = (joinName.value || '').trim() || 'Player';
      socket.emit('room:join', { roomId: r.id, playerName: name });
    };

    el.appendChild(left);
    el.appendChild(btn);
    roomsList.appendChild(el);
  }
}

function renderRoom() {
  if (!room) return;
  roomTitle.textContent = room.name;
  const hostName = room.players.find(p => p.id === room.hostId)?.name || 'Host';
  roomMeta.textContent = `Host: ${hostName} • ${room.players.length}/6`;

  playersList.innerHTML = '';
  for (const p of room.players) {
    const tag = document.createElement('div');
    tag.className = 'playerTag';
    const flags = [];
    if (p.id === room.hostId) flags.push('host');
    if (p.isBot) flags.push('bot');
    if (p.id === youId) flags.push('you');
    tag.textContent = `${p.name}${flags.length ? ` (${flags.join(', ')})` : ''}`;
    playersList.appendChild(tag);
  }

  const amHost = youId && room.hostId === youId;
  btnAddBot.disabled = !amHost || room.inGame;
  btnStart.disabled = !amHost || room.inGame || room.players.length < 3;

  roomNotice.textContent = room.inGame
    ? 'Jocul a început.'
    : 'Adună 3–6 jucători. Hostul poate adăuga boți și porni jocul.';
}

function rotateToYou(arr) {
  if (!youId) return arr.slice();
  const idx = arr.indexOf(youId);
  if (idx === -1) return arr.slice();
  return arr.slice(idx).concat(arr.slice(0, idx));
}

function clearSeats() {
  // remove existing seats but keep the center
  Array.from(tableEl.querySelectorAll('.seat')).forEach(x => x.remove());
}

function renderTable() {
  if (!state || !room) return;

  clearSeats();

  const pids = rotateToYou(state.playerIds);
  const posMap = [3, 2, 1, 0, 5, 4]; // i=0 (you) -> bottom, then clockwise
  for (let i = 0; i < pids.length; i++) {
    const pid = pids[i];
    const player = room.players.find(p => p.id === pid);
    const name = player?.name || pid;

    const seat = document.createElement('div');
    const isBiddingTurn = state.phase === 'bidding' && pid === state.currentBidderId;
    const isPlayingTurn = state.phase === 'playing' && pid === state.currentPlayerId;
    seat.className = `seat pos${posMap[i]}${pid === youId ? ' me' : ''}${isBiddingTurn ? ' bidding' : ''}${isPlayingTurn ? ' playing' : ''}`;

    const nameRow = document.createElement('div');
    nameRow.className = 'nameRow';

    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    const badges = [];
    if (pid === state.dealerId) badges.push('D');
    if (pid === state.currentPlayerId) badges.push('▶');
    if (pid === state.currentBidderId) badges.push('BID');
    nameEl.textContent = name;
    if (badges.length) {
      for (const b of badges) {
        const span = document.createElement('span');
        span.className = 'badge';
        span.textContent = b;
        nameEl.appendChild(span);
      }
    }

    const metaEl = document.createElement('div');
    metaEl.className = 'meta';
    const score = state.totalScores?.[pid] ?? 0;
    const bid = (typeof state.bids?.[pid] === 'number') ? state.bids[pid] : '-';
    const won = state.tricksWon?.[pid] ?? 0;
    const st = state.streaks?.[pid];
    const stTxt = (st && st.type && st.count) ? ` • Streak ${st.type}${st.count}` : '';
    metaEl.textContent = `Scor ${score} • Bid ${bid} • Won ${won}${stTxt}`;

    nameRow.appendChild(nameEl);
    nameRow.appendChild(metaEl);

    const handRow = document.createElement('div');
    handRow.className = 'handRow';

    const cards = handsByPlayer?.[pid] || [];
    const canPlay = state.phase === 'playing' && pid === youId && state.currentPlayerId === youId;

    for (const cs of cards) {
      let b;
      if (cs === 'HIDDEN') {
        b = createCardBackEl();
        b.classList.add('disabled');
        handRow.appendChild(b);
        continue;
      }

      b = createCardFaceEl(cs);

      if (pid !== youId || !canPlay) {
        b.classList.add('disabled');
      } else {
        b.onclick = () => socket.emit('game:play', { card: cs });
      }

      handRow.appendChild(b);
    }

    seat.appendChild(nameRow);
    seat.appendChild(handRow);
    tableEl.appendChild(seat);
  }
}

function renderTrick() {
  trickArea.innerHTML = '';
  if (!state) return;
  if (!state.currentTrick?.length) {
    const m = document.createElement('div');
    m.className = 'muted small';
    m.textContent = '—';
    trickArea.appendChild(m);
    return;
  }
  for (const t of state.currentTrick) {
    const who = room?.players.find(p => p.id === t.pid)?.name || t.pid;
    const el = document.createElement('div');
    el.className = 'trickCard';

    const w = document.createElement('div');
    w.className = 'who';
    w.textContent = who;

    const cardEl = createCardFaceEl(t.card);
    cardEl.classList.add('disabled');

    el.appendChild(w);
    el.appendChild(cardEl);
    trickArea.appendChild(el);
  }
}

function renderBidding() {
  if (!state) return;

  const isMyBid = state.phase === 'bidding' && state.currentBidderId === youId;
  bidArea.classList.toggle('hidden', !isMyBid);

  if (!isMyBid) return;

  const handSize = state.cardsPerPlayer;
  bidButtons.innerHTML = '';
  selectedBidValue = null;
  btnBid.disabled = true;
  let forbidden = null;
  if (youId === state.dealerId) {
    let sumOthers = 0;
    for (const pid of state.playerIds) {
      if (pid === youId) continue;
      const b = state.bids[pid];
      if (typeof b === 'number') sumOthers += b;
    }
    const f = handSize - sumOthers;
    if (f >= 0 && f <= handSize) forbidden = f;
  }
  for (let i = 0; i <= handSize; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'primary bidBtn';
    b.textContent = String(i);
    if (forbidden !== null && i === forbidden) {
      b.disabled = true;
      b.classList.add('disabled');
    }
    b.onclick = () => {
      selectedBidValue = String(i);
      Array.from(bidButtons.children).forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      btnBid.disabled = !canBidNow();
    };
    bidButtons.appendChild(b);
  }

  // dealer forbidden hint
  bidHint.textContent = '';
  if (youId === state.dealerId) {
    if (forbidden !== null) {
      bidHint.textContent = `Ești dealer — nu ai voie să anunți ${forbidden}.`;
    }
  }
}

function renderHandEnd() {
  if (!state || !room) return;
  handEndArea.classList.toggle('hidden', state.phase !== 'hand_end');

  const amHost = youId && room.hostId === youId;
  btnNextHand.disabled = !amHost;

  if (state.phase !== 'hand_end') return;

  // quick summary: bids vs won
  const lines = state.playerIds.map(pid => {
    const name = room.players.find(p => p.id === pid)?.name || pid;
    const bid = state.bids[pid];
    const won = state.tricksWon[pid];
    const score = state.totalScores[pid];
    return `${name}: bid ${bid}, won ${won}, total ${score}`;
  });
  handSummary.textContent = lines.join(' • ');
}

function renderGameEnd() {
  if (!state || !room) return;
  gameEndArea.classList.toggle('hidden', state.phase !== 'game_end');
  if (state.phase !== 'game_end') return;

  finalLeaderboard.innerHTML = '';
  const lb = state.leaderboard || [];
  for (let i = 0; i < lb.length; i++) {
    const row = document.createElement('div');
    row.className = 'playerTag';
    const name = room.players.find(p => p.id === lb[i].pid)?.name || lb[i].pid;
    row.textContent = `${i + 1}. ${name} — ${lb[i].score}`;
    finalLeaderboard.appendChild(row);
  }
}

function renderGameHeader() {
  if (!state || !room) return;

  gameRoomTitle.textContent = room.name;
  phasePill.textContent = state.phase;
  handPill.textContent = `${state.handIndex}/${state.totalHands} • ${state.cardsPerPlayer} cărți`;
  const trumpLabel = state.trumpSuit ? suitName(state.trumpSuit) : '—';
  trumpPill.innerHTML = `<span class="trumpLabel">ATU</span><span class="trumpSuit ${isRedSuit(state.trumpSuit) ? 'red' : 'black'}">${trumpLabel}</span>`;

  const turnName = (state.phase === 'bidding' || state.phase === 'choose_trump')
    ? (room.players.find(p => p.id === state.currentBidderId)?.name || '—')
    : (room.players.find(p => p.id === state.currentPlayerId)?.name || '—');
  turnPill.textContent = turnName;

  gameInfo.textContent = `Dealer: ${(room.players.find(p => p.id === state.dealerId)?.name || '—')}`;
}

function streakBadge(st) {
  if (!st || !st.type || !st.count) return `<span class="streakBadge">😐 0</span>`;
  const count = st.count;
  if (st.type === '+') {
    const flames = '🔥'.repeat(Math.min(5, count));
    return `<span class="streakBadge streakPlus">${flames} +${count}</span>`;
  }
  const ice = '🧊'.repeat(Math.min(5, count));
  return `<span class="streakBadge streakMinus">${ice} -${count}</span>`;
}

function renderSidePanels() {
  if (!state || !room) return;

  // Left: bids (current hand)
  if (bidHintLeft) {
    bidHintLeft.textContent = `Hand ${state.handIndex}/${state.totalHands} • ${state.cardsPerPlayer} cărți`;
  }

  if (bidsList) {
    bidsList.innerHTML = '';
    for (const pid of state.playerIds) {
      const p = room.players.find(x => x.id === pid);
      const bid = (typeof state.bids[pid] === 'number') ? state.bids[pid] : '—';
      const won = (typeof state.tricksWon[pid] === 'number') ? state.tricksWon[pid] : 0;

      const el = document.createElement('div');
      el.className = 'listItem';
      el.innerHTML = `<span class="name">${p?.name || pid}</span><span class="meta">bid ${bid} • won ${won}</span>`;
      bidsList.appendChild(el);
    }
  }

  // Right: scores + streaks
  if (scoreList) {
    scoreList.innerHTML = '';
    const ordered = (state.leaderboard && state.leaderboard.length)
      ? state.leaderboard.map(x => x.pid)
      : [...state.playerIds];

    for (const pid of ordered) {
      const p = room.players.find(x => x.id === pid);
      const score = state.totalScores[pid] ?? 0;
      const st = state.streaks ? state.streaks[pid] : null;

      const el = document.createElement('div');
      el.className = 'listItem';
      el.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:4px;">
          <span class="name">${p?.name || pid}</span>
          <span class="meta">${streakBadge(st)}</span>
        </div>
        <div style="font-weight:900; font-size:16px;">${score}</div>
      `;
      scoreList.appendChild(el);
    }
  }
}

function renderTrumpChoice() {
  if (!state) return;
  const isMyChoice = state.phase === 'choose_trump' && state.currentBidderId === youId;
  trumpArea.classList.toggle('hidden', !isMyChoice);
  if (!isMyChoice) return;

  trumpButtons.innerHTML = '';
  trumpHint.textContent = 'Alege atu-ul pentru această mână.';
  const suits = ['S', 'H', 'D', 'C'];
  for (const s of suits) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `primary trumpBtn ${isRedSuit(s) ? 'red' : 'black'}`;
    b.textContent = suitName(s);
    b.onclick = () => {
      trumpHint.textContent = 'Se trimite...';
      trumpButtons.querySelectorAll('button').forEach(x => x.disabled = true);
      socket.emit('game:chooseTrump', { suit: s });
    };
    trumpButtons.appendChild(b);
  }
}

function renderGame() {
  renderGameHeader();
  renderTrick();
  renderTrumpChoice();
  renderBidding();
  renderHandEnd();
  renderGameEnd();
  renderSidePanels();
  renderTable();
}

// UI events
btnCreate.onclick = () => {
  const name = (createName.value || '').trim() || 'Player';
  const roomName = (createRoom.value || '').trim() || 'Room';
  socket.emit('room:create', { roomName, playerName: name });
};

btnRefresh.onclick = () => socket.emit('lobby:list');
btnLeave.onclick = () => { socket.emit('room:leave'); show(viewLobby); room = null; currentRoomId = null; };
btnAddBot.onclick = () => socket.emit('room:addBot');
btnStart.onclick = () => socket.emit('game:start');

btnLeaveFromGame.onclick = () => { socket.emit('room:leave'); show(viewLobby); room = null; state = null; currentRoomId = null; };
btnBid.onclick = () => {
  if (selectedBidValue === null) return;
  if (!canBidNow()) return;
  btnBid.disabled = true;
  socket.emit('game:bid', { value: selectedBidValue });
};
btnNextHand.onclick = () => socket.emit('game:nextHand');
btnBackToLobby.onclick = () => { show(viewLobby); room = null; state = null; currentRoomId = null; socket.emit('lobby:list'); };

// Socket events
socket.on('connect', () => {
  connStatus.textContent = 'connected';
  connStatus.style.borderColor = 'rgba(94,234,212,.35)';
  socket.emit('lobby:list');
});

socket.on('disconnect', () => {
  connStatus.textContent = 'disconnected';
  connStatus.style.borderColor = 'rgba(255,255,255,.10)';
});

socket.on('lobby:update', list => {
  rooms = list || [];
  renderRooms();
});

socket.on('room:joined', ({ roomId, youId: yid }) => {
  currentRoomId = roomId;
  youId = yid;
  show(viewRoom);
  socket.emit('lobby:list');
});

socket.on('room:update', r => {
  room = r;
  if (!room) return;
  if (room.inGame) show(viewGame);
  else show(viewRoom);
  renderRoom();
});

socket.on('game:state', payload => {
  state = payload.state;
  handsByPlayer = payload.handsByPlayer || {};
  show(viewGame);
  renderGame();
});

socket.on('error:msg', ({ message }) => showToast(message || 'Eroare'));
