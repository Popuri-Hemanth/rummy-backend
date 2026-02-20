/**
 * Socket.IO event handlers - all async with Redis storage.
 * Events: create_room, join_room, rejoin_room, start_game, pick_card, discard_card, declare, preview_hand, leave_room.
 * Security: validate every payload (room exists, player in room, game state, userId present). Reject invalid packets.
 */

const gameManager = require('./game/gameManager');
const { validateDeclare, calculateDeadwood } = require('./game/validator');
const { deadwoodPoints } = require('./game/scoring');
const elo = require('./game/elo');

const turnTimers = new Map();

function invalidPayload(data) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'Invalid payload' };
  return null;
}

function ensureRoom(room) {
  if (!room) return { ok: false, reason: 'Room not found' };
  return null;
}

function ensureUserId(userId) {
  if (!userId || typeof userId !== 'string' || !userId.trim()) return { ok: false, reason: 'userId required' };
  return null;
}

function ensurePlayerInRoom(room, userId) {
  const err = ensureUserId(userId);
  if (err) return err;
  const player = room.players.find((p) => p.userId === userId);
  if (!player) return { ok: false, reason: 'Not in room' };
  return null;
}

function ensureGameState(room, state) {
  if (room.gameState !== state) return { ok: false, reason: `Invalid game state: expected ${state}` };
  return null;
}

function setupSocketHandlers(io, redis) {
  io.on('connection', async (socket) => {
    let currentRoomId = null;
    let currentUserId = null;

    const ackSafe = (ack, payload) => {
      if (typeof ack === 'function') ack(payload);
    };

    // create_room
    socket.on('create_room', async (data, ack) => {
      try {
        const err = invalidPayload(data);
        if (err) return ackSafe(ack, err);
        const { gameType = 13, maxPlayers = 2, practiceMode = true, userId } = data;
        const uidErr = ensureUserId(userId);
        if (uidErr) return ackSafe(ack, uidErr);

        const room = gameManager.createRoom(gameType, maxPlayers, practiceMode, userId);
        room.players.push({
          id: socket.id,
          userId,
          name: data.username || 'Player 1',
          isBot: false,
          disconnected: false,
        });

        await redis.saveRoom(room);
        await redis.setRoomPlayerIds(room.roomId, [socket.id]);
        await redis.setUserIdToSocketId(userId, socket.id);
        await redis.savePlayer(userId, { roomId: room.roomId, socketId: socket.id });

        currentRoomId = room.roomId;
        currentUserId = userId;
        socket.join(room.roomId);

        ackSafe(ack, { ok: true, roomId: room.roomId, room });
      } catch (error) {
        console.error('[socket] create_room error:', error);
        ackSafe(ack, { ok: false, reason: error.message });
      }
    });

    // join_room
    socket.on('join_room', async (data, ack) => {
      try {
        const err = invalidPayload(data);
        if (err) return ackSafe(ack, err);
        const { roomId, username, userId } = data;
        const uidErr = ensureUserId(userId);
        if (uidErr) return ackSafe(ack, uidErr);
        if (!roomId || typeof roomId !== 'string') return ackSafe(ack, { ok: false, reason: 'roomId required' });

        const room = await redis.getRoom(roomId);
        if (ensureRoom(room)) return ackSafe(ack, ensureRoom(room));
        if (ensureGameState(room, 'waiting')) return ackSafe(ack, ensureGameState(room, 'waiting'));

        if (room.players.length >= room.maxPlayers) return ackSafe(ack, { ok: false, reason: 'Room is full' });

        // Check if already in room
        const existingPlayer = room.players.find((p) => p.userId === userId);
        if (existingPlayer) return ackSafe(ack, { ok: false, reason: 'Already in room' });

        room.players.push({
          id: socket.id,
          userId,
          name: username || `Player ${room.players.length + 1}`,
          isBot: false,
          disconnected: false,
        });

        const playerIds = await redis.getRoomPlayerIds(roomId);
        playerIds.push(socket.id);
        await redis.setRoomPlayerIds(roomId, playerIds);
        await redis.setUserIdToSocketId(userId, socket.id);
        await redis.savePlayer(userId, { roomId, socketId: socket.id });
        await redis.saveRoom(room);

        currentRoomId = roomId;
        currentUserId = userId;
        socket.join(roomId);

        io.to(roomId).emit('player_joined', { room });
        ackSafe(ack, { ok: true, room });
      } catch (error) {
        console.error('[socket] join_room error:', error);
        ackSafe(ack, { ok: false, reason: error.message });
      }
    });

    // rejoin_room
    socket.on('rejoin_room', async (data, ack) => {
      try {
        const err = invalidPayload(data);
        if (err) return ackSafe(ack, err);
        const { roomId, userId } = data;
        const uidErr = ensureUserId(userId);
        if (uidErr) return ackSafe(ack, uidErr);
        if (!roomId || typeof roomId !== 'string') return ackSafe(ack, { ok: false, reason: 'roomId required' });

        const room = await redis.getRoom(roomId);
        if (ensureRoom(room)) return ackSafe(ack, ensureRoom(room));
        if (ensurePlayerInRoom(room, userId)) return ackSafe(ack, ensurePlayerInRoom(room, userId));
        const player = room.players.find((p) => p.userId === userId);

        // Update socket ID
        const oldSocketId = player.id;
        player.id = socket.id;
        player.disconnected = false;

        const playerIds = await redis.getRoomPlayerIds(roomId);
        const index = playerIds.indexOf(oldSocketId);
        if (index !== -1) {
          playerIds[index] = socket.id;
        } else {
          playerIds.push(socket.id);
        }
        await redis.setRoomPlayerIds(roomId, playerIds);
        await redis.setUserIdToSocketId(userId, socket.id);
        await redis.saveRoom(room);

        currentRoomId = roomId;
        currentUserId = userId;
        socket.join(roomId);

        // Send hand if game is playing
        if (room.gameState === 'playing' && room.hands[userId]) {
          socket.emit('your_hand', { hand: room.hands[userId] });
        }

        io.to(roomId).emit('player_rejoined', { room });
        ackSafe(ack, { ok: true, room });
      } catch (error) {
        console.error('[socket] rejoin_room error:', error);
        ackSafe(ack, { ok: false, reason: error.message });
      }
    });

    // start_game
    socket.on('start_game', async (data, ack) => {
      try {
        const err = invalidPayload(data);
        if (err) return ackSafe(ack, err);
        const { roomId } = data;
        if (!roomId || typeof roomId !== 'string') return ackSafe(ack, { ok: false, reason: 'roomId required' });

        const room = await redis.getRoom(roomId);
        if (ensureRoom(room)) return ackSafe(ack, ensureRoom(room));
        if (ensureUserId(currentUserId)) return ackSafe(ack, { ok: false, reason: 'Not authenticated' });
        if (room.creatorUserId !== currentUserId) return ackSafe(ack, { ok: false, reason: 'Only creator can start game' });
        if (ensureGameState(room, 'waiting')) return ackSafe(ack, ensureGameState(room, 'waiting'));

        const result = await gameManager.startGame(room, redis);
        if (!result.ok) return ackSafe(ack, result);

        // Deal cards
        for (const player of room.players) {
          const hand = room.hands[player.userId] || [];
          const playerSocket = await redis.getSocketIdByUserId(player.userId);
          if (playerSocket) {
            io.to(playerSocket).emit('your_hand', { hand });
          }
        }

        // Start turn timer
        room.turnExpiresAt = Date.now() + (30 * 1000);
        await redis.saveRoom(room);
        startTurnTimer(room, io, redis);

        io.to(roomId).emit('deal_cards', {
          discardPile: room.discardPile,
          currentTurnIndex: room.currentTurnIndex,
          joker: room.joker,
        });

        io.to(roomId).emit('turn_timer_start', { expiresAt: room.turnExpiresAt });

        console.log(`[game] start room=${roomId} players=${room.players.length}`);
        ackSafe(ack, { ok: true });
      } catch (error) {
        console.error('[socket] start_game error:', error);
        ackSafe(ack, { ok: false, reason: error.message });
      }
    });

    // pick_card
    socket.on('pick_card', async (data, ack) => {
      try {
        const err = invalidPayload(data);
        if (err) return ackSafe(ack, err);
        const { roomId, source } = data;
        if (!roomId || !source) return ackSafe(ack, { ok: false, reason: 'roomId and source required' });

        const room = await redis.getRoom(roomId);
        if (ensureRoom(room)) return ackSafe(ack, ensureRoom(room));
        if (ensurePlayerInRoom(room, currentUserId)) return ackSafe(ack, ensurePlayerInRoom(room, currentUserId));
        if (ensureGameState(room, 'playing')) return ackSafe(ack, ensureGameState(room, 'playing'));

        const result = await gameManager.pickCard(room, currentUserId, source, redis);
        if (!result.ok) return ackSafe(ack, result);

        // Send updated hand
        const hand = room.hands[currentUserId];
        if (hand) {
          socket.emit('your_hand', { hand });
        }

        ackSafe(ack, { ok: true });
      } catch (error) {
        console.error('[socket] pick_card error:', error);
        ackSafe(ack, { ok: false, reason: error.message });
      }
    });

    // discard_card
    socket.on('discard_card', async (data, ack) => {
      try {
        const err = invalidPayload(data);
        if (err) return ackSafe(ack, err);
        const { roomId, card } = data;
        if (!roomId || !card) return ackSafe(ack, { ok: false, reason: 'roomId and card required' });

        const room = await redis.getRoom(roomId);
        if (ensureRoom(room)) return ackSafe(ack, ensureRoom(room));
        if (ensurePlayerInRoom(room, currentUserId)) return ackSafe(ack, ensurePlayerInRoom(room, currentUserId));
        if (ensureGameState(room, 'playing')) return ackSafe(ack, ensureGameState(room, 'playing'));

        const result = await gameManager.discardCard(room, currentUserId, card, redis);
        if (!result.ok) return ackSafe(ack, result);

        // Clear turn timer
        clearTurnTimer(roomId);

        // Start next turn timer
        startTurnTimer(room, io, redis);

        io.to(roomId).emit('player_turn', {
          currentTurnIndex: room.currentTurnIndex,
          discardPile: room.discardPile,
        });

        io.to(roomId).emit('turn_timer_start', { expiresAt: room.turnExpiresAt });

        // Bot play if next player is bot
        setTimeout(async () => {
          const updatedRoom = await redis.getRoom(roomId);
          if (updatedRoom && updatedRoom.gameState === 'playing') {
            const currentPlayer = updatedRoom.players[updatedRoom.currentTurnIndex];
            if (currentPlayer && currentPlayer.isBot) {
              await gameManager.botPlay(updatedRoom, redis);
              io.to(roomId).emit('player_turn', {
                currentTurnIndex: updatedRoom.currentTurnIndex,
                discardPile: updatedRoom.discardPile,
              });
              io.to(roomId).emit('turn_timer_start', { expiresAt: updatedRoom.turnExpiresAt });
              startTurnTimer(updatedRoom, io, redis);
            }
          }
        }, 1000);

        ackSafe(ack, { ok: true });
      } catch (error) {
        console.error('[socket] discard_card error:', error);
        ackSafe(ack, { ok: false, reason: error.message });
      }
    });

    // declare
    socket.on('declare', async (data, ack) => {
      try {
        const err = invalidPayload(data);
        if (err) return ackSafe(ack, err);
        const { roomId, cards } = data;
        if (!roomId || !Array.isArray(cards)) return ackSafe(ack, { ok: false, reason: 'roomId and cards required' });

        const room = await redis.getRoom(roomId);
        if (ensureRoom(room)) return ackSafe(ack, ensureRoom(room));
        if (ensurePlayerInRoom(room, currentUserId)) return ackSafe(ack, ensurePlayerInRoom(room, currentUserId));
        if (ensureGameState(room, 'playing')) return ackSafe(ack, ensureGameState(room, 'playing'));

        // Client sends flat array; groupedCards can be provided or inferred
        const groupedCards = data.groupedCards || [{ cards }];
        const result = await gameManager.declare(room, currentUserId, cards, groupedCards, redis);
        if (!result.ok) return ackSafe(ack, result);

        clearTurnTimer(roomId);

        // Get all real players (not bots) for ELO calculation
        const realPlayers = room.players.filter((p) => p.userId && !p.isBot);
        const winnerUserId = room.players[result.winnerIndex]?.userId;

        let playerRatingChanges = [];
        if (realPlayers.length >= 2) {
          // Get current ratings for all real players
          const playerRatings = await Promise.all(
            realPlayers.map(async (p) => {
              const stats = await redis.getStats(p.userId);
              return {
                userId: p.userId,
                rating: stats.rating,
                totalGames: stats.totalGames,
                won: p.userId === winnerUserId,
              };
            })
          );

          // Calculate new ratings for each player
          const ratingUpdates = [];
          for (const player of playerRatings) {
            const opponents = playerRatings.filter((p) => p.userId !== player.userId);
            const newRating = elo.calculateNewRating(
              player.rating,
              player.totalGames,
              player.won,
              opponents
            );
            const ratingChange = newRating - player.rating;
            ratingUpdates.push({ 
              userId: player.userId, 
              oldRating: player.rating,
              newRating, 
              ratingChange,
              won: player.won 
            });
          }

          // Atomic update: record stats and update ratings for all players
          await Promise.all(
            ratingUpdates.map((update) =>
              redis.updateStatsAndRating(update.userId, update.won, update.newRating).catch((err) =>
                console.error(`updateStatsAndRating error for ${update.userId}:`, err)
              )
            )
          );

          // Prepare rating changes for game_over payload
          playerRatingChanges = await Promise.all(
            ratingUpdates.map(async (update) => {
              const stats = await redis.getStats(update.userId);
              return {
                userId: update.userId,
                oldRating: update.oldRating,
                newRating: update.newRating,
                ratingChange: update.ratingChange,
                tier: stats.tier,
                peakRating: stats.peakRating,
              };
            })
          );
        } else {
          // Fallback: just record stats without ELO (single player or all bots)
          for (const p of realPlayers) {
            if (p.userId) {
              redis.recordGameResult(p.userId, p.userId === winnerUserId).catch((err) =>
                console.error('recordGameResult error:', err)
              );
              // Still include tier for single player games
              const stats = await redis.getStats(p.userId);
              playerRatingChanges.push({
                userId: p.userId,
                oldRating: stats.rating,
                newRating: stats.rating,
                ratingChange: 0,
                tier: stats.tier,
                peakRating: stats.peakRating,
              });
            }
          }
        }

        io.to(roomId).emit('game_over', {
          winnerIndex: result.winnerIndex,
          scores: result.scores,
          winnerHand: result.winnerHand,
          winnerGrouped: result.winnerGrouped,
          scoreBreakdown: result.scoreBreakdown,
          ratingChanges: playerRatingChanges,
        });

        console.log(`[game] end room=${roomId} winner=${room.players[result.winnerIndex]?.userId ?? '?'}`);
        ackSafe(ack, { ok: true });
      } catch (error) {
        console.error('[socket] declare error:', error);
        ackSafe(ack, { ok: false, reason: error.message });
      }
    });

    // get_stats
    socket.on('get_stats', async (data, ack) => {
      try {
        const userId = data?.userId ?? currentUserId;
        if (!userId) {
          return ack ? ack({ ok: false, reason: 'userId required' }) : null;
        }
        const stats = await redis.getStats(userId);
        if (ack) ack({ ok: true, stats });
      } catch (error) {
        console.error('get_stats error:', error);
        if (ack) ack({ ok: false, reason: error.message });
      }
    });

    // get_leaderboard
    socket.on('get_leaderboard', async (data, ack) => {
      try {
        const limit = data?.limit ?? 50;
        const leaderboard = await redis.getLeaderboard(limit);
        if (ack) ack({ ok: true, leaderboard });
      } catch (error) {
        console.error('get_leaderboard error:', error);
        if (ack) ack({ ok: false, reason: error.message });
      }
    });

    // preview_hand
    socket.on('preview_hand', async (data) => {
      try {
        if (invalidPayload(data)) return;
        const { roomId, groupedCards } = data;
        if (!roomId || !Array.isArray(groupedCards)) return;
        const room = await redis.getRoom(roomId);
        if (ensureRoom(room)) return;
        if (ensurePlayerInRoom(room, currentUserId)) return;
        if (ensureGameState(room, 'playing')) return;

        const hand = room.hands[currentUserId] || [];
        const deadwood = calculateDeadwood(hand, groupedCards);

        socket.emit('preview_result', {
          grouped: groupedCards,
          deadwoodCards: deadwood,
        });
      } catch (error) {
        console.error('preview_hand error:', error);
      }
    });

    // leave_room
    socket.on('leave_room', async (data) => {
      try {
        if (invalidPayload(data)) return;
        const { roomId } = data;
        if (!roomId || typeof roomId !== 'string') return;
        const room = await redis.getRoom(roomId);
        if (ensureRoom(room)) return;

        const player = room.players.find((p) => p.id === socket.id);
        if (player) {
          player.disconnected = true;
          await redis.saveRoom(room);
          io.to(roomId).emit('player_disconnected', { room });
        }

        socket.leave(roomId);
        currentRoomId = null;
      } catch (error) {
        console.error('leave_room error:', error);
      }
    });

    socket.on('disconnect', async () => {
      if (currentRoomId) {
        try {
          const room = await redis.getRoom(currentRoomId);
          if (room) {
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
              player.disconnected = true;
              await redis.saveRoom(room);
              io.to(currentRoomId).emit('player_disconnected', { room });
            }
          }
        } catch (error) {
          console.error('disconnect cleanup error:', error);
        }
      }
      if (currentUserId) {
        await redis.removeUserIdToSocketId(currentUserId);
      }
    });
  });
}

function startTurnTimer(room, io, redis) {
  const roomId = room.roomId;
  clearTurnTimer(roomId);

  if (!room.turnExpiresAt) return;
  const delay = room.turnExpiresAt - Date.now();
  if (delay <= 0) return;

  const timer = setTimeout(async () => {
    const updatedRoom = await redis.getRoom(roomId);
    if (!updatedRoom || updatedRoom.gameState !== 'playing') return;

    const currentPlayer = updatedRoom.players[updatedRoom.currentTurnIndex];
    if (currentPlayer && currentPlayer.isBot) {
      await gameManager.botPlay(updatedRoom, redis);
      io.to(roomId).emit('player_turn', {
        currentTurnIndex: updatedRoom.currentTurnIndex,
        discardPile: updatedRoom.discardPile,
      });
      io.to(roomId).emit('turn_timer_start', { expiresAt: updatedRoom.turnExpiresAt });
      startTurnTimer(updatedRoom, io, redis);
    } else {
      io.to(roomId).emit('turn_auto_play', {});
      // Auto-discard first card
      const hand = updatedRoom.hands[currentPlayer.userId];
      if (hand && hand.length > 0) {
        await gameManager.discardCard(updatedRoom, currentPlayer.userId, hand[0], redis);
        io.to(roomId).emit('player_turn', {
          currentTurnIndex: updatedRoom.currentTurnIndex,
          discardPile: updatedRoom.discardPile,
        });
        io.to(roomId).emit('turn_timer_start', { expiresAt: updatedRoom.turnExpiresAt });
        startTurnTimer(updatedRoom, io, redis);
      }
    }
  }, delay);

  turnTimers.set(roomId, timer);
}

function clearTurnTimer(roomId) {
  const timer = turnTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    turnTimers.delete(roomId);
  }
}

module.exports = setupSocketHandlers;
