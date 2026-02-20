/**
 * Production-grade validator for 13-card and 21-card Rummy.
 * Card format: "RANK-SUIT" (e.g. "A-H", "10-S") or legacy "RS" (e.g. "AH", "10S").
 * Joker: room.jokerCard is a rank (e.g. "5"). All cards of that rank are wild.
 * JOKER / J1 / J2 are also wild.
 */

function normalizeCard(card) {
  if (card === 'JOKER' || card === 'J1' || card === 'J2') return card;
  if (card.includes('-')) return card;
  if (card.length >= 2) {
    const rank = card.substring(0, card.length - 1);
    const suit = card.substring(card.length - 1);
    return `${rank}-${suit}`;
  }
  return card;
}

function isWild(card, jokerRank) {
  const normalized = normalizeCard(card);
  if (normalized === 'JOKER' || normalized === 'J1' || normalized === 'J2') return true;
  if (jokerRank && normalized.includes('-')) {
    const rank = normalized.split('-')[0];
    return rank === jokerRank;
  }
  return false;
}

function parseCard(card) {
  const normalized = normalizeCard(card);
  if (normalized === 'JOKER' || normalized === 'J1' || normalized === 'J2') {
    return { rank: null, suit: null, isWild: true };
  }
  const parts = normalized.split('-');
  if (parts.length !== 2) return null;
  return { rank: parts[0], suit: parts[1], isWild: false };
}

const RANK_ORDER = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['H', 'D', 'C', 'S'];

function rankValue(rank) {
  return RANK_ORDER.indexOf(rank);
}

function isSequence(group, jokerRank) {
  if (group.length < 3) return false;
  const cards = group.map(c => parseCard(c)).filter(c => c);
  if (cards.length === 0) return false;

  const bySuit = {};
  for (const card of cards) {
    if (!card.suit) continue;
    if (!bySuit[card.suit]) bySuit[card.suit] = [];
    bySuit[card.suit].push(card);
  }

  for (const suit in bySuit) {
    const suitCards = bySuit[suit].filter(c => !isWild(c.rank + '-' + c.suit, jokerRank));
    if (suitCards.length === 0) continue;
    suitCards.sort((a, b) => rankValue(a.rank) - rankValue(b.rank));
    let wildCount = group.length - suitCards.length;
    let consecutive = 1;
    for (let i = 1; i < suitCards.length; i++) {
      const diff = rankValue(suitCards[i].rank) - rankValue(suitCards[i - 1].rank);
      if (diff === 1) {
        consecutive++;
      } else if (diff > 1 && wildCount >= diff - 1) {
        consecutive += diff;
        wildCount -= (diff - 1);
      } else {
        consecutive = 1;
      }
    }
    if (consecutive + wildCount >= group.length) return true;
  }
  return false;
}

function isSet(group, jokerRank) {
  if (group.length < 3) return false;
  const cards = group.map(c => parseCard(c)).filter(c => c);
  if (cards.length === 0) return false;

  const ranks = {};
  for (const card of cards) {
    if (isWild(card.rank + '-' + card.suit, jokerRank)) continue;
    if (!card.rank) continue;
    ranks[card.rank] = (ranks[card.rank] || 0) + 1;
  }

  const uniqueRanks = Object.keys(ranks);
  if (uniqueRanks.length === 0) return true; // all wild
  if (uniqueRanks.length === 1) return true; // same rank
  return false;
}

function validateHand(cards, jokerRank, gameType) {
  if (!Array.isArray(cards) || cards.length === 0) {
    return { valid: false, reason: 'Invalid cards' };
  }

  const expectedCount = gameType === 21 ? 21 : 13;
  if (cards.length !== expectedCount) {
    return { valid: false, reason: `Must have ${expectedCount} cards` };
  }

  // Group cards (client sends flat array; we need to detect groups)
  // For now, assume client sends grouped structure or we validate flat
  // In production, client sends groupedCards in declare/preview
  return { valid: true };
}

function validateDeclare(gameType, cards, groupedCards, jokerRank) {
  if (!Array.isArray(cards)) {
    return { valid: false, reason: 'Invalid cards' };
  }

  const expectedCount = gameType === 21 ? 21 : 13;
  if (cards.length !== expectedCount) {
    return { valid: false, reason: `Must have ${expectedCount} cards` };
  }

  if (!Array.isArray(groupedCards) || groupedCards.length === 0) {
    return { valid: false, reason: 'Invalid grouping' };
  }

  let pureSequences = 0;
  let sequences = 0;
  let sets = 0;

  for (const group of groupedCards) {
    if (!Array.isArray(group.cards) && !Array.isArray(group)) {
      return { valid: false, reason: 'Invalid group format' };
    }
    const groupCards = Array.isArray(group.cards) ? group.cards : group;
    if (groupCards.length < 3) {
      return { valid: false, reason: 'Groups must have at least 3 cards' };
    }

    const hasWild = groupCards.some(c => isWild(c, jokerRank));
    const isSeq = isSequence(groupCards, jokerRank);
    const isSetGroup = isSet(groupCards, jokerRank);

    if (isSeq && !hasWild) {
      pureSequences++;
    } else if (isSeq) {
      sequences++;
    } else if (isSetGroup) {
      sets++;
    } else {
      return { valid: false, reason: 'Invalid group: not a sequence or set' };
    }
  }

  if (gameType === 13) {
    if (pureSequences < 1) {
      return { valid: false, reason: '13-card: Need at least 1 pure sequence' };
    }
    if (pureSequences + sequences < 2) {
      return { valid: false, reason: '13-card: Need at least 2 sequences total' };
    }
  } else if (gameType === 21) {
    if (pureSequences < 3) {
      return { valid: false, reason: '21-card: Need at least 3 pure sequences' };
    }
    if (pureSequences + sequences < 4) {
      return { valid: false, reason: '21-card: Need at least 4 sequences total' };
    }
  }

  return { valid: true, pureSequences, sequences, sets };
}

function calculateDeadwood(cards, groupedCards) {
  const grouped = new Set();
  if (Array.isArray(groupedCards)) {
    for (const group of groupedCards) {
      const groupCards = Array.isArray(group.cards) ? group.cards : group;
      for (const card of groupCards) {
        grouped.add(card);
      }
    }
  }
  const deadwood = cards.filter(c => !grouped.has(c));
  return deadwood;
}

module.exports = {
  validateHand,
  validateDeclare,
  calculateDeadwood,
  isWild,
  normalizeCard,
};
