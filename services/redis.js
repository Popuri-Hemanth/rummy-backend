/**
 * Redis storage layer for horizontal scaling.
 * Keys: room:{roomId}, player:{userId}, roomPlayers:{roomId}, userIdToSocketId stored in Redis.
 * TTL: 10 minutes for empty/ended rooms.
 * Production: retryStrategy, connection logging, status for health check.
 */

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL;
const ROOM_TTL_SECONDS = 10 * 60; // 10 minutes

let pubClient;
let subClient;
let redisStatus = 'disconnected';

function getClients() {
  if (!pubClient) {
    const options = {
      maxRetriesPerRequest: null,
      retryStrategy(times) {
        const delay = Math.min(times * 100, 3000);
        console.warn(`[redis] Retry in ${delay}ms (attempt ${times})`);
        return delay;
      },
    };
    pubClient = new Redis(REDIS_URL, options);
    subClient = new Redis(REDIS_URL, options);

    pubClient.on('connect', () => {
      redisStatus = 'connected';
      console.log('[redis] Pub client connected');
    });
    pubClient.on('error', (err) => {
      console.error('[redis] Pub error:', err.message);
    });
    pubClient.on('close', () => {
      redisStatus = 'disconnected';
      console.error('[redis] CRITICAL: Pub client disconnected');
    });

    subClient.on('connect', () => {
      console.log('[redis] Sub client connected');
    });
    subClient.on('error', (err) => {
      console.error('[redis] Sub error:', err.message);
    });
    subClient.on('close', () => {
      redisStatus = 'disconnected';
      console.error('[redis] CRITICAL: Sub client disconnected');
    });
  }
  return { pubClient, subClient };
}

function getRedisStatus() {
  if (!pubClient) return 'disconnected';
  return pubClient.status === 'ready' ? 'connected' : 'disconnected';
}

async function disconnect() {
  if (pubClient) {
    await pubClient.quit().catch((err) => console.error('[redis] Pub quit error:', err.message));
    pubClient = null;
  }
  if (subClient) {
    await subClient.quit().catch((err) => console.error('[redis] Sub quit error:', err.message));
    subClient = null;
  }
  redisStatus = 'disconnected';
  console.log('[redis] Disconnected');
}

function keyRoom(roomId) {
  return `room:${roomId}`;
}

function keyRoomPlayers(roomId) {
  return `roomPlayers:${roomId}`;
}

function keyPlayer(userId) {
  return `player:${userId}`;
}

/** userId -> socketId mapping (for reconnection across instances) */
const USER_SOCKET_KEY = 'userIdToSocketId';

/** Stats: totalGames, wins, losses — no TTL for retention */
const STATS_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

function keyStats(userId) {
  return `stats:${userId}`;
}

async function getStats(userId) {
  const { pubClient } = getClients();
  const elo = require('../game/elo');
  const raw = await pubClient.get(keyStats(userId));
  if (!raw) {
    const rating = 1000;
    return { totalGames: 0, wins: 0, losses: 0, winRate: 0, rating, peakRating: rating, tier: elo.getTierFromRating(rating) };
  }
  try {
    const s = JSON.parse(raw);
    const wins = s.wins || 0;
    const losses = s.losses || 0;
    const totalGames = s.totalGames ?? (wins + losses);
    const winRate = totalGames > 0 ? Math.round((wins / totalGames) * 100) / 100 : 0;
    const rating = s.rating ?? 1000;
    const peakRating = s.peakRating ?? rating;
    const tier = elo.getTierFromRating(rating);
    return { totalGames, wins, losses, winRate, rating, peakRating, tier };
  } catch (e) {
    const rating = 1000;
    return { totalGames: 0, wins: 0, losses: 0, winRate: 0, rating, peakRating: rating, tier: elo.getTierFromRating(rating) };
  }
}

async function recordGameResult(userId, won) {
  const { pubClient } = getClients();
  const key = keyStats(userId);
  const raw = await pubClient.get(key);
  let s = { totalGames: 0, wins: 0, losses: 0, rating: 1000, peakRating: 1000 };
  if (raw) {
    try {
      s = JSON.parse(raw);
      s.rating = s.rating ?? 1000;
      s.peakRating = s.peakRating ?? s.rating;
    } catch (e) {}
  }
  s.totalGames = (s.totalGames || 0) + 1;
  if (won) {
    s.wins = (s.wins || 0) + 1;
  } else {
    s.losses = (s.losses || 0) + 1;
  }
  await pubClient.set(key, JSON.stringify(s), 'EX', STATS_TTL_SECONDS);
}

async function updateRating(userId, newRating) {
  const { pubClient } = getClients();
  const key = keyStats(userId);
  const raw = await pubClient.get(key);
  let s = { totalGames: 0, wins: 0, losses: 0, rating: 1000, peakRating: 1000 };
  if (raw) {
    try {
      s = JSON.parse(raw);
      s.rating = s.rating ?? 1000;
      s.peakRating = s.peakRating ?? s.rating;
    } catch (e) {}
  }
  s.rating = newRating;
  if (newRating > s.peakRating) {
    s.peakRating = newRating;
  }
  await pubClient.set(key, JSON.stringify(s), 'EX', STATS_TTL_SECONDS);
  // Update leaderboard sorted set
  await pubClient.zadd('leaderboard:elo', newRating, userId);
}

async function updateStatsAndRating(userId, won, newRating) {
  const { pubClient } = getClients();
  const key = keyStats(userId);
  const raw = await pubClient.get(key);
  let s = { totalGames: 0, wins: 0, losses: 0, rating: 1000, peakRating: 1000 };
  if (raw) {
    try {
      s = JSON.parse(raw);
      s.rating = s.rating ?? 1000;
      s.peakRating = s.peakRating ?? s.rating;
    } catch (e) {}
  }
  s.totalGames = (s.totalGames || 0) + 1;
  if (won) {
    s.wins = (s.wins || 0) + 1;
  } else {
    s.losses = (s.losses || 0) + 1;
  }
  s.rating = newRating;
  if (newRating > s.peakRating) {
    s.peakRating = newRating;
  }
  // Use MULTI for atomic update
  const multi = pubClient.multi();
  multi.set(key, JSON.stringify(s), 'EX', STATS_TTL_SECONDS);
  multi.zadd('leaderboard:elo', newRating, userId);
  await multi.exec();
}

async function getLeaderboard(limit = 50) {
  const { pubClient } = getClients();
  const elo = require('../game/elo');
  // Get top N by rating (descending)
  const members = await pubClient.zrevrange('leaderboard:elo', 0, limit - 1, 'WITHSCORES');
  const leaderboard = [];
  for (let i = 0; i < members.length; i += 2) {
    const userId = members[i];
    const rating = parseFloat(members[i + 1]);
    if (userId && rating) {
      const stats = await getStats(userId);
      leaderboard.push({
        userId,
        rating,
        wins: stats.wins,
        losses: stats.losses,
        totalGames: stats.totalGames,
        peakRating: stats.peakRating,
        tier: elo.getTierFromRating(rating),
      });
    }
  }
  return leaderboard;
}

async function getRoom(roomId) {
  const { pubClient } = getClients();
  const raw = await pubClient.get(keyRoom(roomId));
  if (!raw) return null;
  try {
    const room = JSON.parse(raw);
    // Restore from Redis: timers are not serialized; use expiresAt for turn timer
    room.turnTimer = null;
    room.disconnectTimer = null;
    return room;
  } catch (e) {
    return null;
  }
}

async function saveRoom(room) {
  const { pubClient } = getClients();
  const toSave = { ...room };
  toSave.turnTimer = null;
  toSave.disconnectTimer = null;
  await pubClient.set(keyRoom(room.roomId), JSON.stringify(toSave), 'EX', ROOM_TTL_SECONDS);
}

async function deleteRoom(roomId) {
  const { pubClient } = getClients();
  await pubClient.del(keyRoom(roomId));
  await pubClient.del(keyRoomPlayers(roomId));
}

async function getRoomPlayerIds(roomId) {
  const { pubClient } = getClients();
  const raw = await pubClient.get(keyRoomPlayers(roomId));
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

async function setRoomPlayerIds(roomId, playerIds) {
  const { pubClient } = getClients();
  await pubClient.set(keyRoomPlayers(roomId), JSON.stringify(playerIds), 'EX', ROOM_TTL_SECONDS);
}

async function getPlayer(userId) {
  const { pubClient } = getClients();
  const raw = await pubClient.get(keyPlayer(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function savePlayer(userId, data) {
  const { pubClient } = getClients();
  await pubClient.set(keyPlayer(userId), JSON.stringify(data), 'EX', ROOM_TTL_SECONDS);
}

async function setUserIdToSocketId(userId, socketId) {
  const { pubClient } = getClients();
  await pubClient.hset(USER_SOCKET_KEY, userId, socketId);
}

async function getSocketIdByUserId(userId) {
  const { pubClient } = getClients();
  return await pubClient.hget(USER_SOCKET_KEY, userId);
}

async function removeUserIdToSocketId(userId) {
  const { pubClient } = getClients();
  await pubClient.hdel(USER_SOCKET_KEY, userId);
}

module.exports = {
  getClients,
  getRedisStatus,
  disconnect,
  getRoom,
  saveRoom,
  deleteRoom,
  getRoomPlayerIds,
  setRoomPlayerIds,
  getPlayer,
  savePlayer,
  setUserIdToSocketId,
  getSocketIdByUserId,
  removeUserIdToSocketId,
  getStats,
  recordGameResult,
  updateRating,
  updateStatsAndRating,
  getLeaderboard,
  ROOM_TTL_SECONDS,
};
