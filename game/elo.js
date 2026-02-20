/**
 * ELO rating system for multiplayer Rummy.
 * K factor: 40 if totalGames < 30, else 32
 * Expected score: Ea = 1 / (1 + 10^((Rb - Ra)/400))
 */

function getKFactor(totalGames) {
  return totalGames < 30 ? 40 : 32;
}

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Calculate new ELO rating for a player in a multiplayer game.
 * @param {number} currentRating - Current rating
 * @param {number} totalGames - Total games played
 * @param {boolean} won - Did this player win?
 * @param {Array<{userId: string, rating: number, won: boolean}>} opponents - Other real players
 * @returns {number} New rating
 */
function calculateNewRating(currentRating, totalGames, won, opponents) {
  if (opponents.length === 0) return currentRating;

  const K = getKFactor(totalGames);
  let expectedSum = 0;
  let actualSum = 0;

  for (const opponent of opponents) {
    const expected = expectedScore(currentRating, opponent.rating);
    expectedSum += expected;
    // Winner: Sa = 1 against all opponents
    // Loser: Sa = 0 against winner, Sa = 0.5 against other losers (tie for losing)
    if (won) {
      actualSum += 1;
    } else {
      actualSum += opponent.won ? 0 : 0.5;
    }
  }

  const expectedAvg = expectedSum / opponents.length;
  const actualAvg = actualSum / opponents.length;

  const ratingChange = K * (actualAvg - expectedAvg);
  return Math.round(currentRating + ratingChange);
}

/**
 * Get tier from rating.
 * @param {number} rating - Current ELO rating
 * @returns {string} Tier name
 */
function getTierFromRating(rating) {
  if (rating < 900) return 'Bronze';
  if (rating < 1100) return 'Silver';
  if (rating < 1300) return 'Gold';
  if (rating < 1500) return 'Platinum';
  return 'Diamond';
}

module.exports = {
  getKFactor,
  expectedScore,
  calculateNewRating,
  getTierFromRating,
};
