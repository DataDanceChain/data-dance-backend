const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// 获取交易记录
exports.getTransactions = async (req, res) => {
  try {
    const { page = 1, limit = 10, type, status } = req.query;
    const skip = (page - 1) * limit;

    const where = {
      userId: req.user.id,
      ...(type && { type }),
      ...(status && { status }),
    };

    const [transactions, total] = await Promise.all([
      prisma.organizationTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: Number(skip),
        take: Number(limit),
      }),
      prisma.organizationTransaction.count({ where }),
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        transactions,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
    });
  }
};

// 获取余额
exports.getBalance = async (req, res) => {
  try {
    const transactions = await prisma.organizationTransaction.findMany({
      where: {
        userId: req.user.id,
        status: 'COMPLETED',
      },
    });

    const balance = transactions.reduce((acc, tx) => {
      if (tx.type === 'WITHDRAW') {
        return acc - Number(tx.amount);
      }
      return acc + Number(tx.amount);
    }, 0);

    res.status(200).json({
      status: 'success',
      data: {
        balance,
        currency: 'USDT',
        lastUpdated: new Date(),
      },
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
    });
  }
};

// 创建充值交易
exports.createDepositTransaction = async (req, res) => {
  try {
    const { amount, description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        status: 'fail',
        message: 'Invalid amount',
      });
    }

    const transaction = await prisma.organizationTransaction.create({
      data: {
        amount,
        type: 'DEPOSIT',
        status: 'PENDING',
        description,
        userId: req.user.id,
      },
    });

    res.status(201).json({
      status: 'success',
      data: transaction,
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
    });
  }
};

// 创建提现交易
exports.createWithdrawTransaction = async (req, res) => {
  try {
    const { amount, description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        status: 'fail',
        message: 'Invalid amount',
      });
    }

    // 检查余额
    const transactions = await prisma.organizationTransaction.findMany({
      where: {
        userId: req.user.id,
        status: 'COMPLETED',
      },
    });

    const balance = transactions.reduce((acc, tx) => {
      if (tx.type === 'WITHDRAW') {
        return acc - Number(tx.amount);
      }
      return acc + Number(tx.amount);
    }, 0);

    if (balance < amount) {
      return res.status(400).json({
        status: 'fail',
        message: 'Insufficient balance',
      });
    }

    const transaction = await prisma.organizationTransaction.create({
      data: {
        amount,
        type: 'WITHDRAW',
        status: 'PENDING',
        description,
        userId: req.user.id,
      },
    });

    res.status(201).json({
      status: 'success',
      data: transaction,
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
    });
  }
};

// 更新交易状态
exports.updateTransactionStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['PENDING', 'COMPLETED', 'FAILED'].includes(status)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Invalid status',
      });
    }

    const transaction = await prisma.organizationTransaction.findUnique({
      where: { id },
    });

    if (!transaction) {
      return res.status(404).json({
        status: 'fail',
        message: 'Transaction not found',
      });
    }

    if (transaction.userId !== req.user.id) {
      return res.status(403).json({
        status: 'fail',
        message: 'Not authorized to update this transaction',
      });
    }

    const updatedTransaction = await prisma.organizationTransaction.update({
      where: { id },
      data: { status },
    });

    res.status(200).json({
      status: 'success',
      data: updatedTransaction,
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
    });
  }
}; 