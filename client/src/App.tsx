import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

type Player = {
  id: string;
  name: string;
  isBot: boolean;
  offline?: boolean;
};

type Room = {
  id: string;
  name: string;
  createdAt: number;
  hostId: string;
  players: Player[];
  inGame: boolean;
  phase: string;
  pauseUntil?: number | null;
  hasPassword?: boolean;
  playAgainVotes?: number;
  playAgainNeeded?: number;
};

type Streak = {
  type: '+' | '-' | null;
  count: number;
};

type PublicState = {
  phase: string;
  playerIds: string[];
  dealerId: string;
  handIndex: number;
  totalHands: number;
  cardsPerPlayer: number;
  trumpSuit: 'S' | 'H' | 'D' | 'C' | null;
  bids: Record<string, number | null>;
  tricksWon: Record<string, number>;
  currentPlayerId: string | null;
  currentBidderId: string | null;
  currentTrick: { pid: string; card: string }[];
  totalScores: Record<string, number>;
  streaks: Record<string, Streak>;
  leaderboard: { pid: string; score: number }[];
};

type HandsByPlayer = Record<string, string[]>;
type ChatMsg = { id: string; name: string; text: string; ts: number; senderId: string };

type View = 'lobby' | 'room' | 'game';

type Toast = {
  message: string;
  visible: boolean;
};

const posMap = [3, 2, 1, 0, 5, 4];
const LS_CREATE_NAME = 'whist.createName';
const LS_JOIN_NAME = 'whist.joinName';
const LS_LAST_ROOM = 'whist.lastRoomId';
const LS_RECONNECT_PREFIX = 'whist.reconnect.';
const LS_MUTED = 'whist.muted';


function suitName(s: string | null): string {
  switch (s) {
    case 'S':
      return '♠';
    case 'H':
      return '♥';
    case 'D':
      return '♦';
    case 'C':
      return '♣';
    default:
      return s || '—';
  }
}

function isRedSuit(s: string | null): boolean {
  return s === 'H' || s === 'D';
}

function cardLabel(cardStr: string): string {
  const suit = cardStr.slice(-1);
  const rank = cardStr.slice(0, -1);
  return `${rank}${suitName(suit)}`;
}

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}


function cardToImageCandidates(cardStr: string): string[] {
  // cardStr: "AS", "10H", "QD" etc.
  const suit = cardStr.slice(-1);
  const rank = cardStr.slice(0, -1);

  const suitMap: Record<string, string[]> = {
    S: ['spades'],
    H: ['hearts'],
    D: ['diamonds', 'diamods'],
    C: ['clubs', 'cubs'],
  };

  const baseSuitNames = suitMap[suit] || [suit.toLowerCase()];
  const lowerRank = rank.toLowerCase();

  const candidates: string[] = [];
  if (rank === 'A') {
    for (const sn of baseSuitNames) candidates.push(`ace_of_${sn}.png`);
  } else if (rank === 'K' || rank === 'Q' || rank === 'J') {
    const face = rank === 'K' ? 'king' : (rank === 'Q' ? 'queen' : 'jack');
    for (const sn of baseSuitNames) {
      candidates.push(`${face}_of_${sn}2.png`);
      candidates.push(`${face}_of_${sn}.png`);
    }
  } else {
    for (const sn of baseSuitNames) candidates.push(`${lowerRank}_of_${sn}.png`);
  }

  return candidates;
}

function CardFace({ cardStr, disabled, onClick }: { cardStr: string; disabled?: boolean; onClick?: () => void }) {
  const candidates = useMemo(() => cardToImageCandidates(cardStr), [cardStr]);
  const [idx, setIdx] = useState(0);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    setIdx(0);
    setFallback(false);
  }, [cardStr]);

  if (fallback || candidates.length === 0) {
    return (
      <div
        className={`cardBtn ${isRedSuit(cardStr.slice(-1)) ? 'red' : 'black'}${disabled ? ' disabled' : ''}`}
        onClick={disabled ? undefined : onClick}
      >
        {cardLabel(cardStr)}
      </div>
    );
  }

  const src = `/cards/${candidates[idx]}`;

  return (
    <div className={`cardBtn${disabled ? ' disabled' : ''}`} onClick={disabled ? undefined : onClick}>
      <img
        className="cardImg"
        src={src}
        alt={cardStr}
        onError={() => {
          if (idx + 1 < candidates.length) setIdx(idx + 1);
          else setFallback(true);
        }}
      />
    </div>
  );
}

function CardBack({ disabled }: { disabled?: boolean }) {
  return <div className={`cardBtn back${disabled ? ' disabled' : ''}`} />;
}

export default function App() {
  const socketRef = useRef<Socket | null>(null);
  const attemptedRejoinRef = useRef(false);
  const [view, setView] = useState<View>('lobby');
  const [connStatus, setConnStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [room, setRoom] = useState<Room | null>(null);
  const [state, setState] = useState<PublicState | null>(null);
  const [handsByPlayer, setHandsByPlayer] = useState<HandsByPlayer>({});
  const [youId, setYouId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>({ message: '', visible: false });

  const [createName, setCreateName] = useState('');
  const [createRoom, setCreateRoom] = useState('');
  const [joinName, setJoinName] = useState('');
  const [createPass, setCreatePass] = useState('');
  const [joinPass, setJoinPass] = useState('');
  const [selectedBidValue, setSelectedBidValue] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [rejoinNotice, setRejoinNotice] = useState<string | null>(null);
  const [inviteRoomId, setInviteRoomId] = useState<string | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [cooldowns, setCooldowns] = useState<Record<string, number>>({});
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [unreadChat, setUnreadChat] = useState(0);
  const [playAgainVoted, setPlayAgainVoted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [showEmojis, setShowEmojis] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const prevIsMyTurnRef = useRef(false);
  const youIdRef = useRef<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const emojis = ['😀', '😅', '😂', '😍', '😎', '😭', '😡', '👍', '🙏', '🔥', '🎉', '🂡', '🐟'];

  const showToast = useCallback((message: string, ms = 2200) => {
    setToast({ message, visible: true });
    window.setTimeout(() => setToast(prev => ({ ...prev, visible: false })), ms);
  }, []);

  useEffect(() => {
    const savedCreate = window.localStorage.getItem(LS_CREATE_NAME) || '';
    const savedJoin = window.localStorage.getItem(LS_JOIN_NAME) || '';
    if (savedCreate) setCreateName(savedCreate);
    if (savedJoin) setJoinName(savedJoin);
    const savedMuted = window.localStorage.getItem(LS_MUTED);
    if (savedMuted === '1') setMuted(true);
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);

  const onCooldown = useCallback((key: string) => {
    const until = cooldowns[key] || 0;
    return until > Date.now();
  }, [cooldowns]);

  const triggerCooldown = useCallback((key: string, ms: number) => {
    setCooldowns(prev => ({ ...prev, [key]: Date.now() + ms }));
  }, []);

  useEffect(() => {
    const socketUrl = import.meta.env.VITE_SOCKET_URL || (import.meta.env.DEV ? 'http://localhost:3000' : undefined);
    const socket = io(socketUrl, { autoConnect: true });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnStatus('connected');
      socket.emit('lobby:list');

      if (!attemptedRejoinRef.current) {
        const lastRoomId = window.localStorage.getItem(LS_LAST_ROOM);
        const lastName = window.localStorage.getItem(LS_JOIN_NAME) || window.localStorage.getItem(LS_CREATE_NAME) || '';
        const lastToken = lastRoomId ? window.localStorage.getItem(`${LS_RECONNECT_PREFIX}${lastRoomId}`) : null;
        if (lastRoomId && lastName) {
          attemptedRejoinRef.current = true;
          socket.emit('room:join', { roomId: lastRoomId, playerName: lastName, reconnectToken: lastToken || undefined });
        }
      }
    });

    socket.on('disconnect', () => {
      setConnStatus('disconnected');
      attemptedRejoinRef.current = false;
    });

    socket.on('lobby:update', (list: Room[]) => {
      setRooms(list || []);
    });

    socket.on('room:joined', ({ roomId, youId: yid, reconnectToken, rejoined }: { roomId: string; youId: string; reconnectToken?: string; rejoined?: boolean }) => {
      setYouId(yid);
      youIdRef.current = yid;
      setView('room');
      window.localStorage.setItem(LS_LAST_ROOM, roomId);
      if (reconnectToken) {
        window.localStorage.setItem(`${LS_RECONNECT_PREFIX}${roomId}`, reconnectToken);
      }
      if (rejoined) {
        setRejoinNotice('Ai revenit în joc.');
        window.setTimeout(() => setRejoinNotice(null), 2500);
      }
      socket.emit('lobby:list');
    });

    socket.on('room:update', (r: Room) => {
      setRoom(r);
      if (!r) return;
      setView(r.inGame ? 'game' : 'room');
    });

    socket.on('game:state', (payload: { state: PublicState; handsByPlayer: HandsByPlayer }) => {
      setState(payload.state);
      setHandsByPlayer(payload.handsByPlayer || {});
      setView('game');
    });

    socket.on('chat:history', (list: ChatMsg[]) => {
      setChatMessages(list || []);
    });

    socket.on('chat:message', (msg: ChatMsg) => {
      setChatMessages(prev => [...prev, msg]);
      const selfId = youIdRef.current || socket.id;
      if (!chatOpen && msg.senderId !== selfId) {
        setUnreadChat(prev => prev + 1);
      }
    });

    socket.on('error:msg', ({ message }: { message: string }) => {
      const msg = message || 'Eroare';
      if (msg.includes('Room not found') || msg.includes('Game already started') || msg.includes('Room is full')) {
        window.localStorage.removeItem(LS_LAST_ROOM);
      }
      showToast(msg);
    });

    socket.on('room:closed', () => {
      setRoom(null);
      setState(null);
      setHandsByPlayer({});
      setChatOpen(false);
      setChatMessages([]);
      setUnreadChat(0);
      setView('lobby');
      window.localStorage.removeItem(LS_LAST_ROOM);
      attemptedRejoinRef.current = false;
      socket.emit('lobby:list');
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [showToast]);

  useEffect(() => {
    if (!state || state.phase !== 'bidding' || state.currentBidderId !== youId) {
      setSelectedBidValue(null);
    }
  }, [state, youId]);

  useEffect(() => {
    if (!state || state.phase !== 'game_end') {
      setPlayAgainVoted(false);
    }
  }, [state?.phase, room?.id]);

  useEffect(() => {
    if (!chatOpen) return;
    if (!chatEndRef.current) return;
    chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [chatOpen, chatMessages.length]);

  useEffect(() => {
    window.localStorage.setItem(LS_CREATE_NAME, createName);
  }, [createName]);

  useEffect(() => {
    window.localStorage.setItem(LS_JOIN_NAME, joinName);
  }, [joinName]);

  useEffect(() => {
    window.localStorage.setItem(LS_MUTED, muted ? '1' : '0');
  }, [muted]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomId = params.get('room');
    if (roomId) {
      setInviteRoomId(roomId.trim());
      setShowInviteModal(true);
    }
  }, []);

  const canBidNow = useMemo(() => {
    return !!(state && youId && state.phase === 'bidding' && state.currentBidderId === youId);
  }, [state, youId]);

  const amHost = useMemo(() => {
    return !!(room && youId && room.hostId === youId);
  }, [room, youId]);

  const roomNotice = useMemo(() => {
    if (!room) return '';
    return room.inGame
      ? 'Jocul a început.'
      : 'Adună 3–6 jucători. Hostul poate adăuga boți și porni jocul.';
  }, [room]);

  const orderedPlayers = useMemo(() => {
    if (!state || !youId) return state?.playerIds || [];
    const idx = state.playerIds.indexOf(youId);
    if (idx === -1) return state.playerIds;
    return state.playerIds.slice(idx).concat(state.playerIds.slice(0, idx));
  }, [state, youId]);

  const handleLeave = useCallback(() => {
    socketRef.current?.emit('room:leave');
    setRoom(null);
    setState(null);
    setHandsByPlayer({});
    setChatOpen(false);
    setChatMessages([]);
    setUnreadChat(0);
    setView('lobby');
    window.localStorage.removeItem(LS_LAST_ROOM);
    attemptedRejoinRef.current = false;
  }, []);

  const handleBackToLobby = useCallback(() => {
    setRoom(null);
    setState(null);
    setHandsByPlayer({});
    setChatOpen(false);
    setChatMessages([]);
    setUnreadChat(0);
    setView('lobby');
    socketRef.current?.emit('lobby:list');
    window.localStorage.removeItem(LS_LAST_ROOM);
    attemptedRejoinRef.current = false;
  }, []);

  const renderRooms = () => {
    if (!rooms.length) {
      return <div className="muted">Niciun room încă. Creează unul!</div>;
    }

    return rooms.map(r => (
      <div className="roomItem" key={r.id}>
        <div>
          <div>{`${r.name} (${r.players.length}/6)${r.hasPassword ? ' 🔒' : ''}`}</div>
          <div className="meta">{r.inGame ? `În joc (${r.phase})` : 'În așteptare'}</div>
        </div>
        <button
          disabled={r.inGame || !isConnected || onCooldown('joinRoom')}
          onClick={() => {
            if (onCooldown('joinRoom')) return;
            triggerCooldown('joinRoom', 600);
            const token = window.localStorage.getItem(`${LS_RECONNECT_PREFIX}${r.id}`) || undefined;
            socketRef.current?.emit('room:join', {
              roomId: r.id,
              playerName: joinName.trim() || 'Player',
              reconnectToken: token,
              password: joinPass.trim() || undefined,
            });
          }}
        >
          {r.inGame ? 'Locked' : 'Join'}
        </button>
      </div>
    ));
  };

  const renderPlayers = () => {
    if (!room) return null;
    return room.players.map(p => {
      const flags: string[] = [];
      if (p.id === room.hostId) flags.push('host');
      if (p.isBot) flags.push('bot');
      if (p.id === youId) flags.push('you');
      if (p.offline) flags.push('offline');
      const suffix = flags.length ? ` (${flags.join(', ')})` : '';
      return (
        <div className="playerTag" key={p.id}>
          {`${p.name}${suffix}`}
        </div>
      );
    });
  };

  const renderTrick = () => {
    if (!state || !state.currentTrick?.length) {
      return <div className="muted small">—</div>;
    }

    return state.currentTrick.map(t => {
      const who = room?.players.find(p => p.id === t.pid)?.name || t.pid;
      return (
        <div className="trickCard" key={`${t.pid}-${t.card}`}>
          <div className="who">{who}</div>
          <CardFace cardStr={t.card} disabled />
        </div>
      );
    });
  };

  const renderTable = () => {
    if (!state || !room) return null;

    return orderedPlayers.map((pid, i) => {
      const player = room.players.find(p => p.id === pid);
      const name = player?.name || pid;

      const isBiddingTurn = state.phase === 'bidding' && pid === state.currentBidderId;
      const isPlayingTurn = state.phase === 'playing' && pid === state.currentPlayerId;
      const isOffline = !!player?.offline;
      const seatClass = `seat pos${posMap[i]}${pid === youId ? ' me' : ''}${isBiddingTurn ? ' bidding' : ''}${isPlayingTurn ? ' playing' : ''}${isOffline ? ' offline' : ''}`;

      const score = state.totalScores?.[pid] ?? 0;
      const bid = (typeof state.bids?.[pid] === 'number') ? state.bids[pid] : '-';
      const won = state.tricksWon?.[pid] ?? 0;
      const st = state.streaks?.[pid];
      const stTxt = (st && st.type && st.count) ? ` • Streak ${st.type}${st.count}` : '';

      const cards = handsByPlayer?.[pid] || [];
      const canPlay = state.phase === 'playing' && pid === youId && state.currentPlayerId === youId;

      return (
        <div className={seatClass} key={pid}>
          <div className="nameRow">
            <div className="name">
              {name}
              {pid === state.dealerId && <span className="badge">D</span>}
              {pid === state.currentPlayerId && <span className="badge">▶</span>}
              {pid === state.currentBidderId && <span className="badge">BID</span>}
              {isOffline && <span className="badge off">OFF</span>}
            </div>
            <div className="meta">{`Scor ${score} • Bid ${bid} • Won ${won}${stTxt}`}</div>
          </div>
          <div className="handRow">
            {cards.map((cs, idx) => {
              if (cs === 'HIDDEN') {
                return <CardBack disabled key={`hidden-${pid}-${idx}`} />;
              }
              return (
                <CardFace
                  key={`${pid}-${cs}-${idx}`}
                  cardStr={cs}
                  disabled={!canPlay}
                  onClick={!canPlay ? undefined : () => socketRef.current?.emit('game:play', { card: cs })}
                />
              );
            })}
          </div>
        </div>
      );
    });
  };

  const renderBidButtons = () => {
    if (!state) return null;
    const handSize = state.cardsPerPlayer;
    let forbidden: number | null = null;

    if (youId && youId === state.dealerId) {
      let sumOthers = 0;
      for (const pid of state.playerIds) {
        if (pid === youId) continue;
        const b = state.bids[pid];
        if (typeof b === 'number') sumOthers += b;
      }
      const f = handSize - sumOthers;
      if (f >= 0 && f <= handSize) forbidden = f;
    }

    return (
      <>
        {Array.from({ length: handSize + 1 }).map((_, i) => {
          const disabled = forbidden !== null && i === forbidden;
          return (
            <button
              type="button"
              className={`primary bidBtn${selectedBidValue === String(i) ? ' selected' : ''}`}
              disabled={disabled}
              onClick={() => {
                setSelectedBidValue(String(i));
              }}
              key={`bid-${i}`}
            >
              {i}
            </button>
          );
        })}
      </>
    );
  };

  const renderLeftPanel = () => {
    if (!state || !room) return null;

    return (
      <aside className="sidePanel left">
        <div className="sideBox">
          <div className="sideTitle">📋 Joc</div>
          <div className="sideRow"><span className="lbl">Fază</span><span className="pill">{state.phase}</span></div>
          <div className="sideRow"><span className="lbl">Joc</span><span className="pill">{`${state.handIndex}/${state.totalHands} • ${state.cardsPerPlayer} cărți`}</span></div>
          <div className="sideRow"><span className="lbl">Atu</span><span className="pill trumpBig" id="trumpPill"><span className="trumpLabel">ATU</span><span className={`trumpSuit ${isRedSuit(state.trumpSuit) ? 'red' : 'black'}`}>{suitName(state.trumpSuit)}</span></span></div>
          <div className="sideRow"><span className="lbl">Rând</span><span className="pill">{
            (state.phase === 'bidding' || state.phase === 'choose_trump')
              ? (room.players.find(p => p.id === state.currentBidderId)?.name || '—')
              : (room.players.find(p => p.id === state.currentPlayerId)?.name || '—')
          }</span></div>
        </div>

        <div className="sideBox">
          <div className="sideTitle">🎯 Bids</div>
          <div className="muted">{`Hand ${state.handIndex}/${state.totalHands} • ${state.cardsPerPlayer} cărți`}</div>
          <div className="list">
            {state.playerIds.map(pid => {
              const p = room.players.find(x => x.id === pid);
              const bid = (typeof state.bids[pid] === 'number') ? state.bids[pid] : '—';
              const won = (typeof state.tricksWon[pid] === 'number') ? state.tricksWon[pid] : 0;
              return (
                <div className="listItem" key={`bid-${pid}`}>
                  <span className="name">{p?.name || pid}</span>
                  <span className="meta">{`bid ${bid} • won ${won}`}</span>
                </div>
              );
            })}
          </div>
        </div>

        {state.phase === 'game_end' && (
          <div className="sideBox">
            <div className="row gap" style={{ flexDirection: 'column' }}>
              <div className="muted small">{`Voturi: ${room?.playAgainVotes ?? 0}/${room?.playAgainNeeded ?? 0}`}</div>
              <button
                className="primary"
                style={{ width: '100%' }}
                disabled={playAgainVoted || onCooldown('playAgainVote')}
                onClick={() => {
                  if (onCooldown('playAgainVote')) return;
                  triggerCooldown('playAgainVote', 800);
                  socketRef.current?.emit('room:playAgainVote');
                  setPlayAgainVoted(true);
                }}
              >
                Votează Play again
              </button>
              <button
                style={{ width: '100%' }}
                disabled={!amHost || onCooldown('closeRoom')}
                onClick={() => {
                  if (onCooldown('closeRoom')) return;
                  triggerCooldown('closeRoom', 800);
                  socketRef.current?.emit('room:close');
                }}
              >
                Închide room
              </button>
              {!amHost && <div className="muted small">Doar hostul poate porni un nou room.</div>}
            </div>
          </div>
        )}
      </aside>
    );
  };

  const renderRightPanel = () => {
    if (!state || !room) return null;

    const ordered = state.leaderboard && state.leaderboard.length
      ? state.leaderboard.map(x => x.pid)
      : [...state.playerIds];

    return (
      <aside className="sidePanel right">
        <div className="sideBox scoreWrap">
          <div className="scoreHeader">
            <div className="sideTitle">🏆 Scoreboard</div>
            <button
              className="chatToggle"
              disabled={!canChat}
              onClick={() => {
                setChatOpen(v => {
                  const next = !v;
                  if (next) setUnreadChat(0);
                  return next;
                });
              }}
              aria-label="Chat"
              title="Chat"
            >
              💬
              {hasUnread && <span className="chatBadge">{unreadChat}</span>}
            </button>
          </div>
          <div className="list">
            {ordered.map(pid => {
              const p = room.players.find(x => x.id === pid);
              const score = state.totalScores[pid] ?? 0;
              const st = state.streaks ? state.streaks[pid] : null;
              const badge = !st || !st.type || !st.count
                ? <span className="streakBadge">😐 0</span>
                : st.type === '+'
                  ? <span className="streakBadge streakPlus">{'🔥'.repeat(Math.min(5, st.count))} +{st.count}</span>
                  : <span className="streakBadge streakMinus">{'🧊'.repeat(Math.min(5, st.count))} -{st.count}</span>;
              return (
                <div className="listItem" key={`score-${pid}`}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span className="name">{p?.name || pid}</span>
                    <span className="meta">{badge}</span>
                  </div>
                  <div style={{ fontWeight: 900, fontSize: '16px' }}>{score}</div>
                </div>
              );
            })}
          </div>

          {chatOpen && (
            <div className="chatPanel">
              <div className="chatHeader">
                <div className="chatTitle">Chat</div>
                <button className="chatClose" onClick={() => setChatOpen(false)}>✕</button>
              </div>
              <div className="chatBody">
                {chatMessages.length === 0 && <div className="muted small">Niciun mesaj încă.</div>}
                {chatMessages.map(m => (
                  <div className="chatMsg" key={m.id}>
                    <span className="chatName">{m.name}</span>
                    <span className="chatText">{m.text}</span>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <div className="chatInputRow">
                <input
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  placeholder="Scrie un mesaj…"
                  maxLength={240}
                  onKeyDown={e => {
                    if (e.key !== 'Enter') return;
                    sendChat();
                  }}
                />
                <button
                  className="emojiToggle"
                  type="button"
                  onClick={() => setShowEmojis(v => !v)}
                  aria-label="Emoticons"
                  title="Emoticons"
                >
                  🙂
                </button>
                <button className="sendBtn" disabled={!canChat} onClick={sendChat} aria-label="Trimite">
                  ➤
                </button>
              </div>
              {showEmojis && (
                <div className="emojiRow">
                  {emojis.map(e => (
                    <button
                      key={e}
                      type="button"
                      className="emojiBtn"
                      onClick={() => setChatInput(prev => `${prev}${e}`)}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {state.phase === 'hand_end' && (
          <div className="sideBox">
            <button
              className="primary"
              style={{ width: '100%' }}
              disabled={!amHost || onCooldown('nextHand')}
              onClick={() => {
                if (onCooldown('nextHand')) return;
                triggerCooldown('nextHand', 800);
                socketRef.current?.emit('game:nextHand');
              }}
            >
              Următorul hand
            </button>
          </div>
        )}
      </aside>
    );
  };

  const hostName = room?.players.find(p => p.id === room?.hostId)?.name || 'Host';

  const connBorder = connStatus === 'connected'
    ? 'rgba(94,234,212,.35)'
    : connStatus === 'disconnected'
      ? 'rgba(255,255,255,.10)'
      : 'rgba(255,255,255,.10)';

  const isConnected = connStatus === 'connected';
  const isInRoom = !!room && !!youId;
  const pauseUntil = room?.pauseUntil ?? null;
  const pauseRemaining = pauseUntil && pauseUntil > now ? Math.ceil((pauseUntil - now) / 1000) : 0;
  const isPaused = pauseRemaining > 0;
  const canChat = isInRoom && isConnected;
  const hasUnread = unreadChat > 0;
  const leaderboard = state?.leaderboard || [];
  const isMyBidTurn = !!(state && youId && state.phase === 'bidding' && state.currentBidderId === youId);
  const isMyPlayTurn = !!(state && youId && state.phase === 'playing' && state.currentPlayerId === youId);
  const isMyTurn = isMyBidTurn || isMyPlayTurn;

  const playPing = useCallback(() => {
    if (muted) return;
    let ctx = audioCtxRef.current;
    if (!ctx) {
      ctx = new AudioContext();
      audioCtxRef.current = ctx;
    }
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 660;
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const nowTime = ctx.currentTime;
    gain.gain.exponentialRampToValueAtTime(0.08, nowTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, nowTime + 0.22);
    osc.start(nowTime);
    osc.stop(nowTime + 0.25);
  }, [muted]);

  useEffect(() => {
    if (isMyTurn && !prevIsMyTurnRef.current) {
      playPing();
    }
    prevIsMyTurnRef.current = isMyTurn;
  }, [isMyTurn, playPing]);

  const sendChat = useCallback(() => {
    if (!canChat) return;
    const msg = chatInput.trim();
    if (!msg) return;
    if (onCooldown('chatSend')) return;
    triggerCooldown('chatSend', 300);
    socketRef.current?.emit('chat:send', { text: msg });
    setChatInput('');
  }, [canChat, chatInput, onCooldown, triggerCooldown]);


  return (
    <>
      <header className="topbar">
        <div className="brand">🂡 Whist</div>
        <div className="topbarRight">
          <div className="pill" style={{ borderColor: connBorder }}>{connStatus}</div>
          <button
            className="muteToggle"
            onClick={() => {
              const next = !muted;
              setMuted(next);
              if (!next) {
                if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
                if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
              }
            }}
          >
            {muted ? 'Muted' : 'Sound On'}
          </button>
        </div>
      </header>

      <main className="container">
        <section className={`view ${view !== 'lobby' ? 'hidden' : ''}`}>
          <div className="grid2">
            <div className="card">
              <h2>Creează room</h2>
              <label>Numele tău</label>
              <input
                value={createName}
                onChange={e => setCreateName(e.target.value)}
                placeholder="ex: Andrei"
                maxLength={24}
              />
              <label>Numele room-ului</label>
              <input
                value={createRoom}
                onChange={e => setCreateRoom(e.target.value)}
                placeholder="ex: Whist de seară"
                maxLength={40}
              />
              <label>Parolă (opțional)</label>
              <input
                value={createPass}
                onChange={e => setCreatePass(e.target.value)}
                placeholder="ex: 1234"
                maxLength={32}
                type="password"
              />
              <button
                className="primary"
                disabled={!isConnected || onCooldown('createRoom')}
                onClick={() => {
                  if (onCooldown('createRoom')) return;
                  triggerCooldown('createRoom', 1200);
                  socketRef.current?.emit('room:create', {
                    roomName: createRoom.trim() || 'Room',
                    playerName: createName.trim() || 'Player',
                    password: createPass.trim() || undefined,
                  });
                }}
              >
                Creează
              </button>
              <p className="muted">3–6 jucători. Hostul poate adăuga boți. Cartile sunt vizibile (ca la o masă).</p>
            </div>

            <div className="card">
              <h2>Rooms disponibile</h2>
              <div className="row">
                <input
                  value={joinName}
                  onChange={e => setJoinName(e.target.value)}
                  placeholder="Numele tău"
                  maxLength={24}
                />
                <button onClick={() => socketRef.current?.emit('lobby:list')}>Refresh</button>
              </div>
              <label>Parolă (dacă e necesară)</label>
              <input
                value={joinPass}
                onChange={e => setJoinPass(e.target.value)}
                placeholder="Parola room-ului"
                maxLength={32}
                type="password"
              />
              <div className="rooms">{renderRooms()}</div>
              <p className="muted">Dacă un joc a început, nu mai poți intra în room.</p>
            </div>
          </div>
        </section>

        <section className={`view ${view !== 'room' ? 'hidden' : ''}`}>
          <div className="card">
            <div className="roomHeader">
              <div>
                <h2>{room?.name || 'Room'}</h2>
                <div className="muted">{`Host: ${hostName} • ${room?.players.length || 0}/6`}</div>
              </div>
              <div className="row">
                <button
                  onClick={() => {
                    if (!room?.id) return;
                    const link = `${window.location.origin}?room=${room.id}`;
                    if (navigator.clipboard?.writeText) {
                      navigator.clipboard.writeText(link);
                      showToast('Invite link copiat!');
                    } else {
                      showToast(link);
                    }
                  }}
                >
                  Invite
                </button>
                <button onClick={handleLeave}>Ieși</button>
              </div>
            </div>

            <h3>Jucători</h3>
            <div className="players">{renderPlayers()}</div>

            <div className="row gap">
              <button
                disabled={!amHost || !!room?.inGame || onCooldown('addBot')}
                onClick={() => {
                  if (onCooldown('addBot')) return;
                  triggerCooldown('addBot', 800);
                  socketRef.current?.emit('room:addBot');
                }}
              >
                + Adaugă bot
              </button>
              <div className="spacer" />
              <button
                className="primary"
                disabled={!amHost || !!room?.inGame || (room?.players.length || 0) < 3 || onCooldown('startGame')}
                onClick={() => {
                  if (onCooldown('startGame')) return;
                  triggerCooldown('startGame', 800);
                  socketRef.current?.emit('game:start');
                }}
              >
                Start game
              </button>
            </div>

            <div className="notice">{roomNotice}</div>
            <div className="muted small">
              Format: X mâini cu 1 carte, apoi 2..7, apoi X mâini cu 8, apoi 7..2, apoi X mâini cu 1 (unde X = nr. jucători).
            </div>
          </div>
        </section>

        <section className={`view ${view !== 'game' ? 'hidden' : ''}`}>
          <div className="card">
            <div className="row space">
              <div>
                <h2>{room?.name || 'Game'}</h2>
                <div className="muted">{`Dealer: ${room?.players.find(p => p.id === state?.dealerId)?.name || '—'}`}</div>
              </div>
              <button onClick={handleLeave}>Ieși</button>
            </div>

            <div className="gameShell">
              {renderLeftPanel()}
              <main className="centerPanel">
                <div className="tableWrap">
                  <div className={`table felt${isPaused ? ' paused' : ''}`}>
                    <div className="tableCenter">
                      <div className="centerTitle">Trick</div>
                      <div className="trick">{renderTrick()}</div>
                    </div>
                    {renderTable()}
                  </div>
                  {isPaused && (
                    <div className="pauseOverlay">
                      <div className="pauseCard">
                        <div className="pauseTitle">Pauză de reconectare</div>
                        <div className="pauseText">Așteptăm jucătorul să revină…</div>
                        <div className="pauseCount">{pauseRemaining}s</div>
                      </div>
                    </div>
                  )}
                </div>
                {rejoinNotice && <div className="notice">{rejoinNotice}</div>}

                <div className="actionRow">
                  {state?.phase === 'choose_trump' && state?.currentBidderId === youId && state?.cardsPerPlayer === 8 && (
                    <div className="trumpArea">
                      <div className="row gap">
                        <label className="inline">Alege ATU:</label>
                        <div className="trumpButtons">
                          {(['S', 'H', 'D', 'C'] as const).map(s => (
                            <button
                              key={`trump-${s}`}
                              type="button"
                              className={`primary trumpBtn ${isRedSuit(s) ? 'red' : 'black'}`}
                              disabled={!isInRoom || onCooldown('chooseTrump')}
                              onClick={() => {
                                if (onCooldown('chooseTrump')) return;
                                triggerCooldown('chooseTrump', 400);
                                socketRef.current?.emit('game:chooseTrump', { suit: s });
                              }}
                            >
                              {suitName(s)}
                            </button>
                          ))}
                        </div>
                        <span className="muted">Alege atu-ul pentru această mână.</span>
                      </div>
                    </div>
                  )}

                <div className={`bidArea ${!(state?.phase === 'bidding' && state?.currentBidderId === youId) ? 'hidden' : ''}`}>
                  <div className="row gap">
                      <label className="inline">Bid:</label>
                      <div className="bidButtons">{renderBidButtons()}</div>
                      <button
                        className="primary"
                        disabled={!canBidNow || selectedBidValue === null || onCooldown('bid')}
                        onClick={() => {
                          if (!canBidNow || selectedBidValue === null) return;
                          if (onCooldown('bid')) return;
                          triggerCooldown('bid', 300);
                          socketRef.current?.emit('game:bid', { value: selectedBidValue });
                        }}
                      >
                        Trimite
                      </button>
                      {youId === state?.dealerId && (
                        <span className="muted">
                          {(() => {
                            let sumOthers = 0;
                            if (state) {
                              for (const pid of state.playerIds) {
                                if (pid === youId) continue;
                                const b = state.bids[pid];
                                if (typeof b === 'number') sumOthers += b;
                              }
                              const forbidden = state.cardsPerPlayer - sumOthers;
                              if (forbidden >= 0 && forbidden <= state.cardsPerPlayer) {
                                return `Ești dealer — nu ai voie să anunți ${forbidden}.`;
                              }
                            }
                            return '';
                          })()}
                        </span>
                      )}
                    </div>
                    <div className="chatMobileRow">
                      <button
                        className="chatToggleMobile"
                        disabled={!canChat}
                        onClick={() => {
                          setChatOpen(true);
                          setUnreadChat(0);
                        }}
                      >
                        Chat
                        {hasUnread && <span className="chatBadge">{unreadChat}</span>}
                      </button>
                    </div>
                </div>
                </div>
              </main>

              {renderRightPanel()}
            </div>

            {state?.phase === 'game_end' && (
              <div className="winOverlay">
                <div className="winCard">
                  <div className="winTitle">Game Over</div>
                  <div className="winSubtitle">Final Rankings</div>
                  <div className="winList">
                    {leaderboard.map((lb, idx) => {
                      const name = room?.players.find(p => p.id === lb.pid)?.name || lb.pid;
                      return (
                        <div className={`winRow place${idx + 1}`} key={`win-${lb.pid}`}>
                          <span className="place">{ordinal(idx + 1)}</span>
                          <span className="winnerName">{name}</span>
                          <span className="winnerScore">{lb.score}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="winHint">Votează Play again sau închide room-ul.</div>
                </div>
                <div className="fireworks">
                  <span className="spark s1" />
                  <span className="spark s2" />
                  <span className="spark s3" />
                  <span className="spark s4" />
                  <span className="spark s5" />
                </div>
              </div>
            )}

            <div className="notice small">
              Click pe o carte din mâna ta ca s-o joci (doar când e rândul tău). Cartile sunt vizibile pentru toți.
            </div>
          </div>
        </section>
      </main>

      {view === 'game' && (
        <button
          className="chatFab"
          disabled={!canChat}
          onClick={() => {
            setChatOpen(v => {
              const next = !v;
              if (next) setUnreadChat(0);
              return next;
            });
          }}
        >
          Chat
          {hasUnread && <span className="chatBadge">{unreadChat}</span>}
        </button>
      )}

      <div className={`toast ${toast.visible ? '' : 'hidden'}`}>{toast.message}</div>

      {showInviteModal && inviteRoomId && (
        <div className="modalOverlay">
          <div className="modalCard">
            <div className="modalTitle">Invitație la room</div>
            <div className="muted">Room ID: {inviteRoomId}</div>
            <label>Numele tău</label>
            <input
              value={joinName}
              onChange={e => setJoinName(e.target.value)}
              placeholder="Numele tău"
              maxLength={24}
              onKeyDown={e => {
                if (e.key !== 'Enter') return;
                const token = window.localStorage.getItem(`${LS_RECONNECT_PREFIX}${inviteRoomId}`) || undefined;
                socketRef.current?.emit('room:join', {
                  roomId: inviteRoomId,
                  playerName: joinName.trim() || 'Player',
                  reconnectToken: token,
                  password: joinPass.trim() || undefined,
                });
                setShowInviteModal(false);
              }}
            />
            <label>Parolă (dacă e necesară)</label>
            <input
              value={joinPass}
              onChange={e => setJoinPass(e.target.value)}
              placeholder="Parola room-ului"
              maxLength={32}
              type="password"
              onKeyDown={e => {
                if (e.key !== 'Enter') return;
                const token = window.localStorage.getItem(`${LS_RECONNECT_PREFIX}${inviteRoomId}`) || undefined;
                socketRef.current?.emit('room:join', {
                  roomId: inviteRoomId,
                  playerName: joinName.trim() || 'Player',
                  reconnectToken: token,
                  password: joinPass.trim() || undefined,
                });
                setShowInviteModal(false);
              }}
            />
            <div className="row gap" style={{ marginTop: '12px' }}>
              <button onClick={() => setShowInviteModal(false)}>Anulează</button>
              <button
                className="primary"
                disabled={!isConnected || onCooldown('joinRoom')}
                onClick={() => {
                  if (onCooldown('joinRoom')) return;
                  triggerCooldown('joinRoom', 600);
                  const token = window.localStorage.getItem(`${LS_RECONNECT_PREFIX}${inviteRoomId}`) || undefined;
                  socketRef.current?.emit('room:join', {
                    roomId: inviteRoomId,
                    playerName: joinName.trim() || 'Player',
                    reconnectToken: token,
                    password: joinPass.trim() || undefined,
                  });
                  setShowInviteModal(false);
                }}
              >
                Join room
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
