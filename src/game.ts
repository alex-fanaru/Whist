// Whist (Romanesc-inspired) — multiplayer-friendly, deterministic rules
// Supports 3..6 players and the classic "1..8..1" style match schedule described by the user:
// If number of players is X:
// - play X hands with 1 card/player
// - then 1 hand with 2,3,4,5,6,7 cards/player
// - then X hands with 8 cards/player
// - then 1 hand with 7,6,5,4,3,2 cards/player
// - then X hands with 1 card/player
//
// Deck selection:
// We build a BASE deck sized for 8 cards/player (players*8) by trimming low ranks equally across suits.
// For smaller hands we still use the same base deck and simply deal fewer cards (the rest are unused).
// Examples for base deck (8 cards/player):
//   6p => 48 cards => remove all 2s
//   5p => 40 cards => remove 2,3,4
//   4p => 32 cards => remove 2..6 (=> 7..A)
//   3p => 24 cards => remove 2..8 (=> 9..A)
//
// Bidding:
// - bids are 0..handSize
// - dealer cannot bid so that sum(all bids) == handSize
//
// Trick rules:
// - must follow suit if possible
// - trick winner: highest trump if any trump played else highest of lead suit
//
// Scoring per hand:
// - exact bid => +10 + tricks won
// - otherwise => -abs(bid - tricks)

type Suit = 'S' | 'H' | 'D' | 'C';
type Phase = 'waiting' | 'choose_trump' | 'bidding' | 'playing' | 'hand_end' | 'game_end' | 'trick_pause';

type Card = {
  suit: Suit;
  rank: number;
};

type TrickEntry = {
  pid: string;
  card: Card;
};

type Streak = {
  type: '+' | '-' | null;
  count: number;
};

type PublicState = {
  phase: Phase;
  playerIds: string[];
  dealerId: string;
  handIndex: number;
  totalHands: number;
  cardsPerPlayer: number;
  trumpSuit: Suit | null;
  bids: Record<string, number | null>;
  tricksWon: Record<string, number>;
  currentPlayerId: string | null;
  currentBidderId: string | null;
  currentTrick: { pid: string; card: string }[];
  totalScores: Record<string, number>;
  streaks: Record<string, Streak>;
  leaderboard: { pid: string; score: number }[];
};

const SUITS: Suit[] = ['S', 'H', 'D', 'C']; // Spades, Hearts, Diamonds, Clubs
const RANKS_ASC = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // 11=J,12=Q,13=K,14=A

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardToString(c: Card): string {
  const r = c.rank;
  const rs = r === 14 ? 'A' : r === 13 ? 'K' : r === 12 ? 'Q' : r === 11 ? 'J' : String(r);
  return `${rs}${c.suit}`;
}

function stringToCard(s: string): Card {
  const suit = s.slice(-1) as Suit;
  if (!SUITS.includes(suit)) throw new Error('Invalid suit');
  const r = s.slice(0, -1);
  const rank = r === 'A' ? 14 : r === 'K' ? 13 : r === 'Q' ? 12 : r === 'J' ? 11 : parseInt(r, 10);
  if (!Number.isInteger(rank)) throw new Error('Invalid rank');
  return { suit, rank };
}

function compareCards(a: Card, b: Card, leadSuit: Suit | null, trumpSuit: Suit | null): number {
  // returns 1 if a>b, -1 if a<b
  const aTrump = a.suit === trumpSuit;
  const bTrump = b.suit === trumpSuit;
  if (aTrump && !bTrump) return 1;
  if (!aTrump && bTrump) return -1;

  const aLead = a.suit === leadSuit;
  const bLead = b.suit === leadSuit;
  if (aLead && !bLead) return 1;
  if (!aLead && bLead) return -1;

  if (a.suit !== b.suit) return 0;
  return a.rank === b.rank ? 0 : (a.rank > b.rank ? 1 : -1);
}

function buildSchedule(numPlayers: number): number[] {
  const X = numPlayers;
  const sched: number[] = [];
  for (let i = 0; i < X; i++) sched.push(1);
  for (let k = 2; k <= 7; k++) sched.push(k);
  for (let i = 0; i < X; i++) sched.push(8);
  for (let k = 7; k >= 2; k--) sched.push(k);
  for (let i = 0; i < X; i++) sched.push(1);
  return sched;
}

class WhistGame {
  playerIds: string[];
  dealerIndex: number;
  schedule: number[];
  handIndex: number;
  totalScores: Record<string, number>;
  streaks: Record<string, Streak>;
  phase: Phase;
  trumpSuit: Suit | null;
  hands: Record<string, Card[]>;
  bids: Record<string, number | null>;
  tricksWon: Record<string, number>;
  currentTrick: TrickEntry[];
  leadSuit: Suit | null;
  pendingPlayTurnIndex: number | null;
  bidTurnIndex: number;
  playTurnIndex: number | null;

  constructor({ playerIds, dealerIndex = 0 }: { playerIds: string[]; dealerIndex?: number }) {
    this.playerIds = [...playerIds];
    this.dealerIndex = dealerIndex;

    this.schedule = buildSchedule(this.playerIds.length); // list of hand sizes
    this.handIndex = 0; // 0-based in schedule

    this.totalScores = {};
    this.streaks = {};
    for (const pid of this.playerIds) {
      this.totalScores[pid] = 0;
      this.streaks[pid] = { type: null, count: 0 };
    }

    this.phase = 'waiting';
    this.trumpSuit = null;
    this.hands = {};
    this.bids = {};
    this.tricksWon = {};
    this.currentTrick = [];
    this.leadSuit = null;
    this.pendingPlayTurnIndex = null;
    this.bidTurnIndex = 0;
    this.playTurnIndex = null;

    this._resetForNextHand();
  }

  get numPlayers(): number {
    return this.playerIds.length;
  }

  get currentHandSize(): number {
    return this.schedule[this.handIndex] || 1;
  }

  private _minRankForPlayers(n: number): number {
    // Base deck is for 8 cards/player => need 8*n cards.
    // Cards per suit = 2*n. Keep top (2*n) ranks: min = 15 - 2*n.
    return 15 - 2 * n;
  }

  private _createBaseDeck(): Card[] {
    const n = this.numPlayers;
    const needed = 8 * n;
    const minRank = this._minRankForPlayers(n);
    const deck: Card[] = [];
    for (const s of SUITS) {
      for (const r of RANKS_ASC) {
        if (r >= minRank) deck.push({ suit: s, rank: r });
      }
    }
    if (deck.length !== needed) {
      throw new Error(`Deck size mismatch. Expected ${needed}, got ${deck.length}. minRank=${minRank}`);
    }
    return deck;
  }

  private _resetForNextHand(): void {
    this.phase = 'waiting'; // waiting|choose_trump|bidding|playing|hand_end|game_end
    this.trumpSuit = null;
    this.hands = {}; // pid => Card[]
    this.bids = {}; // pid => number|null
    this.tricksWon = {}; // pid => number
    this.currentTrick = []; // [{pid, card}]
    this.leadSuit = null;
    this.pendingPlayTurnIndex = null;

    for (const pid of this.playerIds) {
      this.bids[pid] = null;
      this.tricksWon[pid] = 0;
      this.hands[pid] = [];
    }
  }

  startHand(): PublicState {
    this._resetForNextHand();
    const handSize = this.currentHandSize;

    const deck = shuffle(this._createBaseDeck().slice());
    // pick trump as the suit of the first card in the shuffled deck (simple & deterministic)
    // except for 8-card hands where the first bidder chooses the trump.
    if (handSize !== 8) {
      this.trumpSuit = deck[0].suit;
    }

    // Deal `handSize` cards each, starting from left of dealer
    const startIndex = (this.dealerIndex + 1) % this.numPlayers;
    for (let i = 0; i < handSize; i++) {
      for (let p = 0; p < this.numPlayers; p++) {
        const pid = this.playerIds[(startIndex + p) % this.numPlayers];
        const card = deck.pop();
        if (card) this.hands[pid].push(card);
      }
    }

    // sort hands for nicer UI
    for (const pid of this.playerIds) {
      this.hands[pid].sort((a, b) => (a.suit === b.suit ? a.rank - b.rank : a.suit.localeCompare(b.suit)));
    }

    this.bidTurnIndex = startIndex; // bidding starts left of dealer
    this.phase = (handSize === 8) ? 'choose_trump' : 'bidding';
    this.playTurnIndex = null;
    return this.getPublicState();
  }

  getCurrentBidder(): string {
    return this.playerIds[this.bidTurnIndex];
  }

  private _sumBidsSoFar(excludePid: string): number {
    let sum = 0;
    for (const pid of this.playerIds) {
      if (pid === excludePid) continue;
      const b = this.bids[pid];
      if (typeof b === 'number') sum += b;
    }
    return sum;
  }

  placeBid(pid: string, bid: number): PublicState {
    if (this.phase !== 'bidding') throw new Error('Not in bidding phase');
    if (pid !== this.getCurrentBidder()) throw new Error('Not your turn to bid');

    const handSize = this.currentHandSize;
    if (!Number.isInteger(bid) || bid < 0 || bid > handSize) throw new Error(`Bid must be an integer 0..${handSize}`);

    const isDealer = pid === this.playerIds[this.dealerIndex];
    if (isDealer) {
      const sumOthers = this._sumBidsSoFar(pid);
      const forbidden = handSize - sumOthers;
      if (bid === forbidden) throw new Error(`Dealer cannot bid to make total bids equal ${handSize}`);
    }

    this.bids[pid] = bid;
    this.bidTurnIndex = (this.bidTurnIndex + 1) % this.numPlayers;

    const allBids = this.playerIds.every(p => typeof this.bids[p] === 'number');
    if (allBids) {
      this.phase = 'playing';
      this.playTurnIndex = (this.dealerIndex + 1) % this.numPlayers;
      this.currentTrick = [];
      this.leadSuit = null;
    }
    return this.getPublicState();
  }

  chooseTrump(pid: string, suit: Suit): PublicState {
    if (this.phase !== 'choose_trump') throw new Error('Not in choose trump phase');
    if (pid !== this.getCurrentBidder()) throw new Error('Not your turn to choose trump');
    if (!SUITS.includes(suit)) throw new Error('Invalid trump suit');
    this.trumpSuit = suit;
    this.phase = 'bidding';
    return this.getPublicState();
  }

  getCurrentPlayer(): string | null {
    if (this.phase !== 'playing') return null;
    return this.playerIds[this.playTurnIndex ?? 0];
  }

  private _hasSuit(pid: string, suit: Suit | null): boolean {
    if (!suit) return false;
    return this.hands[pid].some(c => c.suit === suit);
  }

  private _removeCardFromHand(pid: string, card: Card): Card {
    const idx = this.hands[pid].findIndex(c => c.suit === card.suit && c.rank === card.rank);
    if (idx === -1) throw new Error('Card not in hand');
    return this.hands[pid].splice(idx, 1)[0];
  }

  playCard(pid: string, cardStr: string): { state: PublicState; trickEnded: boolean; trickWinner?: string } {
    if (this.phase !== 'playing') throw new Error('Not in playing phase');
    if (pid !== this.getCurrentPlayer()) throw new Error('Not your turn');

    const card = stringToCard(cardStr);
    if (!this.hands[pid].some(c => c.suit === card.suit && c.rank === card.rank)) {
      throw new Error('You do not have that card');
    }
    if (this.currentTrick.length > 0) {
      const leadSuit = this.leadSuit;
      const mustFollow = this._hasSuit(pid, leadSuit);
      if (mustFollow && card.suit !== leadSuit) {
        throw new Error('You must follow suit');
      }
      if (!mustFollow) {
        const mustTrump = this.trumpSuit && this._hasSuit(pid, this.trumpSuit);
        if (mustTrump && card.suit !== this.trumpSuit) {
          throw new Error('You must play trump if you do not have the lead suit');
        }
      }
    }

    const played = this._removeCardFromHand(pid, card);
    if (this.currentTrick.length === 0) this.leadSuit = played.suit;
    this.currentTrick.push({ pid, card: played });

    if (this.currentTrick.length < this.numPlayers) {
      this.playTurnIndex = ((this.playTurnIndex ?? 0) + 1) % this.numPlayers;
      return { state: this.getPublicState(), trickEnded: false };
    }

    // resolve trick
    const leadSuit = this.leadSuit;
    let winner = this.currentTrick[0].pid;
    let bestCard = this.currentTrick[0].card;
    for (let i = 1; i < this.currentTrick.length; i++) {
      const c = this.currentTrick[i].card;
      const cmp = compareCards(c, bestCard, leadSuit, this.trumpSuit);
      if (cmp === 1) {
        bestCard = c;
        winner = this.currentTrick[i].pid;
      }
    }
    this.tricksWon[winner] += 1;

    const handOver = this.playerIds.every(p => this.hands[p].length === 0);
    if (handOver) {
      this._scoreHand();
      const isLast = this.handIndex >= this.schedule.length - 1;
      this.phase = isLast ? 'game_end' : 'hand_end';
      // Keep the last trick visible during hand_end/game_end.
    } else {
      // Pause between tricks to keep cards visible on the table.
      this.phase = 'trick_pause';
      this.pendingPlayTurnIndex = this.playerIds.indexOf(winner);
    }

    return { state: this.getPublicState(), trickEnded: true, trickWinner: winner };
  }

  private _scoreHand(): void {
    for (const pid of this.playerIds) {
      const bid = this.bids[pid];
      const won = this.tricksWon[pid];

      const success = bid === won;
      if (success) {
        this.totalScores[pid] += 5 + won;
      } else {
        this.totalScores[pid] -= Math.abs((bid ?? 0) - won);
      }

      // Streak bonus/penalty rule:
      // - 5 consecutive "+" (successful hands) => +10
      // - 5 consecutive "-" (failed hands) => -10
      // Streak resets when it reaches 5 (after applying bonus/penalty).
      // If interrupted, it switches type and restarts at 1.
      const outcome = success ? '+' : '-';
      const st = this.streaks[pid] || { type: null, count: 0 };

      if (st.type === outcome) {
        st.count += 1;
      } else {
        st.type = outcome;
        st.count = 1;
      }

      if (st.count >= 5) {
        if (outcome === '+') this.totalScores[pid] += 10;
        else this.totalScores[pid] -= 10;

        st.type = null;
        st.count = 0;
      }

      this.streaks[pid] = st;
    }
  }

  nextHand(): PublicState {
    if (this.phase !== 'hand_end') throw new Error('Cannot start next hand now');
    this.handIndex += 1;
    this.dealerIndex = (this.dealerIndex + 1) % this.numPlayers;
    return this.startHand();
  }

  resumeAfterTrick(): PublicState {
    if (this.phase !== 'trick_pause') throw new Error('Cannot resume trick now');
    this.currentTrick = [];
    this.leadSuit = null;
    this.playTurnIndex = this.pendingPlayTurnIndex ?? this.playTurnIndex;
    this.pendingPlayTurnIndex = null;
    this.phase = 'playing';
    return this.getPublicState();
  }

  replacePlayerId(oldId: string, newId: string): void {
    if (oldId === newId) return;
    const idx = this.playerIds.indexOf(oldId);
    if (idx === -1) return;

    this.playerIds[idx] = newId;

    if (this.hands[oldId]) {
      this.hands[newId] = this.hands[oldId];
      delete this.hands[oldId];
    }
    if (Object.prototype.hasOwnProperty.call(this.bids, oldId)) {
      this.bids[newId] = this.bids[oldId];
      delete this.bids[oldId];
    }
    if (Object.prototype.hasOwnProperty.call(this.tricksWon, oldId)) {
      this.tricksWon[newId] = this.tricksWon[oldId];
      delete this.tricksWon[oldId];
    }
    if (Object.prototype.hasOwnProperty.call(this.totalScores, oldId)) {
      this.totalScores[newId] = this.totalScores[oldId];
      delete this.totalScores[oldId];
    }
    if (Object.prototype.hasOwnProperty.call(this.streaks, oldId)) {
      this.streaks[newId] = this.streaks[oldId];
      delete this.streaks[oldId];
    }

    if (this.currentTrick.length) {
      this.currentTrick = this.currentTrick.map(t => (t.pid === oldId ? { ...t, pid: newId } : t));
    }
  }

  getLeaderboard(): { pid: string; score: number }[] {
    return this.playerIds
      .map(pid => ({ pid, score: this.totalScores[pid] }))
      .sort((a, b) => b.score - a.score);
  }

  getPublicState(): PublicState {
    return {
      phase: this.phase,
      playerIds: [...this.playerIds],
      dealerId: this.playerIds[this.dealerIndex],
      handIndex: this.handIndex + 1,
      totalHands: this.schedule.length,
      cardsPerPlayer: this.currentHandSize,
      trumpSuit: this.trumpSuit,
      bids: { ...this.bids },
      tricksWon: { ...this.tricksWon },
      currentPlayerId: this.getCurrentPlayer(),
      currentBidderId: (this.phase === 'bidding' || this.phase === 'choose_trump') ? this.getCurrentBidder() : null,
      currentTrick: this.currentTrick.map(t => ({ pid: t.pid, card: cardToString(t.card) })),
      totalScores: { ...this.totalScores },
      streaks: { ...this.streaks },
      leaderboard: this.getLeaderboard(),
    };
  }
}

export { WhistGame, cardToString, stringToCard, SUITS };
export type { Suit, Card, Phase, TrickEntry, Streak, PublicState };
