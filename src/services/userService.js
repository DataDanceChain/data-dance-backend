const prisma = require('../utils/prisma');

class UserService {

  /**
   * Find user by primary credentials (email, wallet, xid)
   */
  async findUserByCredentials({ email, walletAddress, xid }) {
    if (xid) {
      return await prisma.user.findUnique({ where: { xid } });
    }
    if (walletAddress) {
      return await prisma.user.findFirst({ where: { walletAddress } });
    }
    if (email) {
      return await prisma.user.findUnique({ where: { email } });
    }
    return null;
  }

  /**
   * Check for credential conflicts
   */
  async checkCredentialConflicts({ email, walletAddress, xid }) {
    const conflicts = [];
    
    if (email) {
      const existingEmail = await prisma.user.findUnique({ 
        where: { email },
        select: { id: true, xid: true }
      });
      if (existingEmail) {
        if (xid && existingEmail.xid !== xid) {
          conflicts.push({
            type: 'EMAIL_X_MISMATCH',
            message: 'Email already associated with different X account'
          });
        } else {
          conflicts.push({
            type: 'EMAIL_IN_USE',
            message: 'Email already registered'
          });
        }
      }
    }

    if (walletAddress) {
      const existingWallet = await prisma.user.findFirst({
        where: { walletAddress }
      });
      if (existingWallet) {
        conflicts.push({
          type: 'WALLET_IN_USE',
          message: 'Wallet address already registered'
        });
      }
    }

    if (xid) {
      const existingX = await prisma.user.findUnique({
        where: { xid }
      });
      if (existingX) {
        conflicts.push({
          type: 'X_ACCOUNT_IN_USE',
          message: 'X account already linked'
        });
      }
    }

    return conflicts;
  }
}

module.exports = new UserService();
