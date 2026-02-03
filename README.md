# Whist (3–6 players) — play tonight

This is a small web game (Node.js + Socket.io) with:

- Lobby (rooms list)
- Create / join rooms
- See who's in the room
- Host can add bots
- 3–6 players
- Deck automatically trimmed so that `players * 8` cards exist:
  - 6p -> remove all 2s (48 cards)
  - 5p -> remove 2,3,4 (40 cards)
  - 4p -> remove 2..6 (32 cards)
  - 3p -> remove 2..8 (24 cards)
- Bidding (dealer can't make sum bids == 8)
- Follow-suit enforced
- Leaderboard shown at the end

## Run locally

1) Install Node.js 18+.
2) In this folder:

```bash
npm install
npm run build
npm start
```

Open: `http://localhost:3000`

For development (two terminals):

```bash
# terminal 1
npm run dev:server
```

```bash
# terminal 2
npm run dev:client
```

## Share with friends (fast)

### Option A: Cloudflare Tunnel (recommended)

1) Install `cloudflared`.
2) Keep the game running (`npm start`).
3) In another terminal:

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a public HTTPS URL you can share.

### Option B: ngrok

```bash
ngrok http 3000
```

## Notes

This is a pragmatic "Whist românesc-inspired" rule set optimized for multiplayer testing tonight.
