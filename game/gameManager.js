/**
 * Game manager: room creation, game flow, turn management, bot logic.
 * All state stored in Redis via redis service.
 */

const { getDecksForPlayers } = require('./deck');
const { shuffle } = require('./shuffle');
const { validateDeclare, calculateDeadwood } = require('./validator');
const { cardPoint, deadwoodPoints } = require('./scoring');

function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function createRoom(gameType, maxPlayers, practiceMode, creatorUserId) {
  const roomId = generateRoomId();
  const cardsPerPlayer = gameType === 21 ? 21 : 13;
  return {
    roomId,
    gameType,
    maxPlayers,
    practiceMode,
    creatorUserId,
    players: [],
    gameState: 'waiting',
    deck: [],
    discardPile: [],
    joker: null,
    jokerCard: null,
    currentTurnIndex: 0,
    turnExpiresAt: null,
    turnTimer: null,
    disconnectTimer: null,
    hands: {},
    createdAt: Date.now(),
  };
}

async function startGame(room, redis) {
  if (room.gameState !== 'waiting') {
    return { ok: false, reason: 'Game already started' };
  }
  if (room.players.length < 2) {
    return { ok: false, reason: 'Need at least 2 players' };
  }

  const cardsPerPlayer = room.gameType === 21 ? 21 : 13;
  const deck = shuffle(getDecksForPlayers(room.players.length, cardsPerPlayer, 2, true));
  
  room.deck = deck;
  room.discardPile = [deck.pop()];
  room.jokerCard = room.discardPile[0].includes('-') 
    ? room.discardPile[0].split('-')[0] 
    : null;
  room.joker = room.jokerCard;
  room.gameState = 'playing';
  room.currentTurnIndex = 0;
  room.hands = {};

  for (let i = 0; i < room.players.length; i++) {
    const player = room.players[i];
    const hand = [];
    for (let j = 0; j < cardsPerPlayer; j++) {
      if (deck.length > 0) {
        hand.push(deck.pop());
      }
    }
    // Store by userId for reconnection support
    room.hands[player.userId] = hand;
  }

  await redis.saveRoom(room);
  return { ok: true, room };
}

async function pickCard(room, userId, source, redis) {
  if (room.gameState !== 'playing') {
    return { ok: false, reason: 'Game not in progress' };
  }

  const currentPlayer = room.players[room.currentTurnIndex];
  if (currentPlayer.userId !== userId) {
    return { ok: false, reason: 'Not your turn' };
  }

  if (!room.hands[userId]) {
    return { ok: false, reason: 'Hand not found' };
  }

  if (source === 'deck') {
    if (room.deck.length === 0) {
      if (room.discardPile.length > 1) {
        const top = room.discardPile.pop();
        room.deck = shuffle(room.discardPile);
        room.discardPile = [top];
      } else {
        return { ok: false, reason: 'No cards available' };
      }
    }
    const card = room.deck.pop();
    room.hands[userId].push(card);
  } else if (source === 'discard') {
    if (room.discardPile.length === 0) {
      return { ok: false, reason: 'Discard pile is empty' };
    }
    const card = room.discardPile.pop();
    room.hands[userId].push(card);
  } else {
    return { ok: false, reason: 'Invalid source' };
  }

  await redis.saveRoom(room);
  return { ok: true, room };
}

async function discardCard(room, userId, card, redis) {
  if (room.gameState !== 'playing') {
    return { ok: false, reason: 'Game not in progress' };
  }

  const currentPlayer = room.players[room.currentTurnIndex];
  if (currentPlayer.userId !== userId) {
    return { ok: false, reason: 'Not your turn' };
  }

  const hand = room.hands[userId];
  if (!hand) {
    return { ok: false, reason: 'Hand not found' };
  }

  const cardIndex = hand.indexOf(card);
  if (cardIndex === -1) {
    return { ok: false, reason: 'Card not in hand' };
  }

  hand.splice(cardIndex, 1);
  room.discardPile.push(card);

  // Move to next turn
  room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
  room.turnExpiresAt = Date.now() + (30 * 1000); // 30 seconds

  await redis.saveRoom(room);
  return { ok: true, room };
}

async function declare(room, userId, cards, groupedCards, redis) {
  if (room.gameState !== 'playing') {
    return { ok: false, reason: 'Game not in progress' };
  }

  const currentPlayer = room.players[room.currentTurnIndex];
  if (currentPlayer.userId !== userId) {
    return { ok: false, reason: 'Not your turn' };
  }

  const hand = room.hands[userId];
  if (!hand) {
    return { ok: false, reason: 'Hand not found' };
  }
  if (hand.length !== cards.length) {
    return { ok: false, reason: 'Card count mismatch' };
  }

  // Use provided groupedCards or default to single group
  const groups = groupedCards || [{ cards }];
  const validation = validateDeclare(room.gameType, cards, groups, room.jokerCard);
  if (!validation.valid) {
    return { ok: false, reason: validation.reason };
  }

  // Game over
  room.gameState = 'ended';
  room.winnerIndex = room.currentTurnIndex;
  const winnerHand = [...hand];
  const deadwood = calculateDeadwood(cards, groups);
  const deadwoodPts = deadwoodPoints(cards, groups);

  const scores = [];
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    const pHand = room.hands[p.userId] || [];
    const pDeadwood = calculateDeadwood(pHand, [{ cards: pHand }]);
    const pPts = deadwoodPoints(pHand, [{ cards: pHand }]);
    scores.push({ penalty: pPts, deadwood: pDeadwood.length });
  }

  await redis.saveRoom(room);
  return {
    ok: true,
    room,
    winnerIndex: room.winnerIndex,
    winnerHand,
    scores,
    winnerGrouped: groups,
    scoreBreakdown: { pureSequences: validation.pureSequences, sequences: validation.sequences, sets: validation.sets },
  };
}

async function botPlay(room, redis) {
  const currentPlayer = room.players[room.currentTurnIndex];
  if (!currentPlayer.isBot) return;

  // Simple bot: pick from deck, discard random card
  const botUserId = currentPlayer.userId;
  const hand = room.hands[botUserId] || [];

  // Pick from deck
  if (room.deck.length > 0) {
    const card = room.deck.pop();
    hand.push(card);
    room.hands[botUserId] = hand;
  }

  // Discard random card
  if (hand.length > 0) {
    const discardIndex = Math.floor(Math.random() * hand.length);
    const discarded = hand.splice(discardIndex, 1)[0];
    room.discardPile.push(discarded);
    room.hands[botUserId] = hand;
  }

  // Move to next turn
  room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
  room.turnExpiresAt = Date.now() + (30 * 1000);

  await redis.saveRoom(room);
  return room;
}

module.exports = {
  createRoom,
  startGame,
  pickCard,
  discardCard,
  declare,
  botPlay,
  generateRoomId,
};
