const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

class TransactionService {
  async getTransactions(organizationId, query) {
    const { page = 1, limit = 10, type, status, startDate, endDate } = query;
    const skip = (page - 1) * limit;

    const where = {
      OR: [
        { fromOrganizationId: organizationId },
        { toOrganizationId: organizationId },
      ],
      ...(type && { type }),
      ...(status && { status }),
      ...(startDate && endDate && {
        createdAt: {
          gte: new Date(startDate),
          lte: new Date(endDate),
        },
      }),
    };

    const [transactions, total] = await Promise.all([
      prisma.organizationTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.organizationTransaction.count({ where }),
    ]);

    return {
      transactions,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getBalance(organizationId) {
    const transactions = await prisma.organizationTransaction.findMany({
      where: {
        OR: [
          { fromOrganizationId: organizationId },
          { toOrganizationId: organizationId },
        ],
        status: 'COMPLETED',
      },
    });

    const balance = transactions.reduce((acc, tx) => {
      if (tx.fromOrganizationId === organizationId) {
        return acc - Number(tx.amount);
      }
      return acc + Number(tx.amount);
    }, 0);

    return {
      balance,
      currency: 'USDT',
      lastUpdated: new Date(),
    };
  }

  async createDepositTransaction(organizationId, data) {
    const transaction = await prisma.organizationTransaction.create({
      data: {
        amount: data.amount,
        type: 'DEPOSIT',
        status: 'PENDING',
        description: data.description,
        toOrganizationId: organizationId,
        metadata: data.metadata,
      },
    });

    return transaction;
  }

  async createWithdrawTransaction(organizationId, data) {
    const { balance } = await this.getBalance(organizationId);
    
    if (balance < data.amount) {
      throw new Error('Insufficient balance');
    }

    const transaction = await prisma.organizationTransaction.create({
      data: {
        amount: data.amount,
        type: 'WITHDRAW',
        status: 'PENDING',
        description: data.description,
        fromOrganizationId: organizationId,
        metadata: data.metadata,
      },
    });

    return transaction;
  }

  async createTransferTransaction(organizationId, data) {
    const { balance } = await this.getBalance(organizationId);
    
    if (balance < data.amount) {
      throw new Error('Insufficient balance');
    }

    const targetOrganization = await prisma.user.findUnique({
      where: { id: data.toOrganizationId },
    });

    if (!targetOrganization || !targetOrganization.isOrganization) {
      throw new Error('Target organization not found');
    }

    const transaction = await prisma.organizationTransaction.create({
      data: {
        amount: data.amount,
        type: 'TRANSFER',
        status: 'PENDING',
        description: data.description,
        fromOrganizationId: organizationId,
        toOrganizationId: data.toOrganizationId,
        metadata: data.metadata,
      },
    });

    return transaction;
  }

  async updateTransactionStatus(transactionId, data) {
    const transaction = await prisma.organizationTransaction.findUnique({
      where: { id: transactionId },
    });

    if (!transaction) {
      throw new Error('Transaction not found');
    }

    const updatedTransaction = await prisma.organizationTransaction.update({
      where: { id: transactionId },
      data: {
        status: data.status,
        metadata: {
          ...transaction.metadata,
          ...data.metadata,
        },
      },
    });

    return updatedTransaction;
  }
}

module.exports = new TransactionService(); 