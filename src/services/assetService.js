const prisma = require('../utils/prisma');
const web3Service = require('./web3Service');

/**
 * Get the count of NFTs owned by a user
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getUserNFTCount(userId) {
  return prisma.nFTDataAsset.count({ where: { ownerId: userId } });
}

/**
 * Get the count of badges collected by a user
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getUserBadgeCount(userId) {
  return prisma.userBadge.count({ where: { userId } });
}

/**
 * Get the DDC token balance for a user
 * For now, calls web3Service internally
 * @param {string} walletAddress
 * @returns {Promise<number>}
 */
async function getDDCBalance(userId) {
  // assume we stored walletAddress on user
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const balance = await web3Service.getDDCBalance(user.walletAddress);
  return balance;
}

module.exports = { getUserNFTCount, getUserBadgeCount, getDDCBalance };