/**
 * Scoring utilities: card points, deadwood calculation.
 */

const CARD_POINTS = {
  'A': 10, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, 'J': 10, 'Q': 10, 'K': 10,
};

function cardPoint(card) {
  if (card === 'JOKER' || card === 'J1' || card === 'J2') return 0;
  const rank = card.includes('-') ? card.split('-')[0] : (card.length >= 2 ? card.substring(0, card.length - 1) : '');
  return CARD_POINTS[rank] || 10;
}

function deadwoodPoints(cards, groupedCards) {
  const grouped = new Set();
  if (Array.isArray(groupedCards)) {
    for (const group of groupedCards) {
      if (Array.isArray(group.cards)) {
        for (const card of group.cards) {
          grouped.add(card);
        }
      }
    }
  }
  let points = 0;
  for (const card of cards) {
    if (!grouped.has(card)) {
      points += cardPoint(card);
    }
  }
  return points;
}

module.exports = {
  cardPoint,
  deadwoodPoints,
};
