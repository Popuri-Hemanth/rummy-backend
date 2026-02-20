# Rummy Server - Production Backend

Node.js + Express + Socket.IO backend with Redis for horizontal scaling.

## Features

✅ **Horizontal Scaling**: Multiple Node instances share state via Redis  
✅ **Redis Storage**: Room state, player mappings, userId→socketId  
✅ **Socket.IO Redis Adapter**: Multi-instance Socket.IO support  
✅ **Timer Persistence**: Turn timers survive instance restarts (expiresAt in Redis)  
✅ **Reconnection**: Works across instances using userId mapping  
✅ **Auto Cleanup**: Empty/ended rooms expire after 10 minutes  

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Start Redis (if not running)
redis-server

# Start server
npm start
```

Server runs on **http://localhost:3001**

### Docker

```bash
cd ..
docker-compose up -d
```

## Stats & ELO Rating System

- **Redis key**: `stats:{userId}` — `totalGames`, `wins`, `losses`, `rating` (default 1000), `peakRating` (TTL 90 days).
- **Recorded automatically** when a game ends (declare → game_over); only real players (not bots).

### ELO Rating & Tiers

- **Default rating**: 1000
- **K factor**: 40 if `totalGames < 30`, else 32
- **Expected score**: `Ea = 1 / (1 + 10^((Rb - Ra)/400))`
- **Multiplayer logic**:
  - Winner: `Sa = 1` against all opponents
  - Loser: `Sa = 0` against winner, `Sa = 0.5` against other losers
- **Rating update**: `rating_new = rating + K * (Sa_avg - Ea_avg)`
- **Atomic updates**: Uses Redis MULTI for consistency

**Tier System** (computed dynamically from rating):
- `< 900` → **Bronze**
- `900-1099` → **Silver**
- `1100-1299` → **Gold**
- `1300-1499` → **Platinum**
- `1500+` → **Diamond**

### Leaderboard

- **Redis sorted set**: `leaderboard:elo` (score = rating, member = userId)
- **Updated automatically** after each game
- **Socket**: `get_leaderboard` with optional `{ limit }` (default 50) → ack `{ ok, leaderboard: [{ userId, rating, wins, losses, totalGames, peakRating, tier }] }`
- **HTTP**: `GET /api/leaderboard?limit=50` → `[{ userId, rating, wins, losses, totalGames, peakRating, tier }]`

### API

- **Socket**: `get_stats` with `{ userId }` → ack `{ ok, stats: { totalGames, wins, losses, winRate, rating, peakRating, tier } }`
- **HTTP**: `GET /api/stats?userId=xxx` → `{ ok, stats }` (includes `tier`)

**game_over event** includes `ratingChanges` array:
```javascript
{
  winnerIndex: 0,
  scores: [...],
  ratingChanges: [
    { userId: "...", oldRating: 1000, newRating: 1025, ratingChange: 25, tier: "Silver" },
    { userId: "...", oldRating: 1050, newRating: 1025, ratingChange: -25, tier: "Silver" }
  ]
}
```

## Environment Variables (required for production)

- `PORT`: Server port (default: 3001)
- `REDIS_URL`: **Required.** Redis connection string (e.g. Upstash). Process exits if missing.
- `NODE_ENV`: `development` or `production`
- `CORS_ORIGIN`: Allowed origin for CORS (e.g. `https://yourapp.vercel.app` or `*` for dev)

Local dev: copy `.env.example` to `.env` and set `REDIS_URL`. Production (Railway): set all in dashboard.

## Socket Events

### Client → Server

- `create_room`: { gameType, maxPlayers, practiceMode, userId }
- `join_room`: { roomId, username, userId }
- `rejoin_room`: { roomId, userId }
- `start_game`: { roomId }
- `pick_card`: { roomId, source: 'deck' | 'discard' }
- `discard_card`: { roomId, card }
- `declare`: { roomId, cards, groupedCards? }
- `preview_hand`: { roomId, groupedCards }
- `leave_room`: { roomId }

### Server → Client

- `your_hand`: { hand }
- `deal_cards`: { discardPile, currentTurnIndex, joker }
- `player_turn`: { currentTurnIndex, discardPile }
- `turn_timer_start`: { expiresAt }
- `turn_auto_play`: {}
- `game_over`: { winnerIndex, scores, winnerHand, winnerGrouped, scoreBreakdown }
- `player_joined`: { room }
- `rejoined_room`: { room }
- `player_rejoined`: { room }
- `player_disconnected`: { room }
- `preview_result`: { grouped, deadwoodCards }

## Architecture

- **Redis Keys**:
  - `room:{roomId}` - Room state (JSON, TTL 10min)
  - `roomPlayers:{roomId}` - Player IDs in room
  - `player:{userId}` - Player data
  - `userIdToSocketId` - Hash map for reconnection

- **Timer Management**:
  - `turnExpiresAt` stored in Redis (survives restarts)
  - `turnTimer` in-memory per instance (cannot serialize)
  - Clients use `expiresAt` for countdown display

## Testing Multi-Instance

1. Start 2 backend instances on different ports
2. Create room on instance 1
3. Join room from instance 2 (should work via Redis)
4. Verify Socket.IO events broadcast across instances

## Production Deployment

See `../DEPLOYMENT.md` for deployment guides (AWS EC2, Railway, Render, etc.)
