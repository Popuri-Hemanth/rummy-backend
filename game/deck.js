/**
 * Deck creation utilities.
 */

function createDeck(numDecks = 2, useJokers = true) {
  const suits = ['H', 'D', 'C', 'S'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck = [];

  for (let d = 0; d < numDecks; d++) {
    for (const suit of suits) {
      for (const rank of ranks) {
        deck.push(`${rank}-${suit}`);
      }
    }
  }

  if (useJokers) {
    deck.push('JOKER');
    deck.push('JOKER');
  }

  return deck;
}

function getDecksForPlayers(playerCount, cardsPerPlayer, numDecks = 2, useJokers = true) {
  const deck = createDeck(numDecks, useJokers);
  const totalCardsNeeded = playerCount * cardsPerPlayer + 1; // +1 for discard pile starter
  if (deck.length < totalCardsNeeded) {
    throw new Error(`Not enough cards: need ${totalCardsNeeded}, have ${deck.length}`);
  }
  return deck;
}

module.exports = {
  createDeck,
  getDecksForPlayers,
};
