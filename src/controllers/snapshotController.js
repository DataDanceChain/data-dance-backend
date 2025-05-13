const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Create a new snapshot
const createSnapshot = async (req, res) => {
  try {
    const { name, description, activityId, tags } = req.body;
    const merchantId = req.user.id;

    // Verify activity exists and belongs to merchant
    const activity = await prisma.activity.findFirst({
      where: {
        id: activityId,
        creatorId: merchantId
      }
    });

    if (!activity) {
      return res.status(404).json({ error: 'Activity not found or not authorized' });
    }

    // Create snapshot with tags
    const snapshot = await prisma.snapshot.create({
      data: {
        name,
        description,
        activityId,
        merchantId,
        tags: {
          connect: tags?.map(tagId => ({ id: tagId })) || []
        }
      },
      include: {
        activity: true,
        merchant: true,
        tags: true
      }
    });

    res.status(201).json(snapshot);
  } catch (error) {
    console.error('Error creating snapshot:', error);
    res.status(500).json({ error: 'Failed to create snapshot' });
  }
};

// Get all snapshots with pagination and filters
const getSnapshots = async (req, res) => {
  try {
    const { page = 1, limit = 10, activityId, search } = req.query;
    const skip = (page - 1) * limit;
    const merchantId = req.user.id;

    const where = { merchantId };
    if (activityId) where.activityId = activityId;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } }
      ];
    }

    const [snapshots, total] = await Promise.all([
      prisma.snapshot.findMany({
        where,
        skip: parseInt(skip),
        take: parseInt(limit),
        include: {
          activity: true,
          merchant: true,
          tags: true
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.snapshot.count({ where })
    ]);

    res.json({
      snapshots,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching snapshots:', error);
    res.status(500).json({ error: 'Failed to fetch snapshots' });
  }
};

// Get a specific snapshot
const getSnapshotById = async (req, res) => {
  try {
    const { id } = req.params;
    const snapshot = await prisma.snapshot.findUnique({
      where: { id },
      include: {
        activity: true,
        merchant: true,
        tags: true
      }
    });

    if (!snapshot) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }

    res.json(snapshot);
  } catch (error) {
    console.error('Error fetching snapshot:', error);
    res.status(500).json({ error: 'Failed to fetch snapshot' });
  }
};

// Update a snapshot
const updateSnapshot = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, tags } = req.body;
    const merchantId = req.user.id;

    // Verify snapshot exists and belongs to merchant
    const existingSnapshot = await prisma.snapshot.findFirst({
      where: {
        id,
        merchantId
      }
    });

    if (!existingSnapshot) {
      return res.status(404).json({ error: 'Snapshot not found or not authorized' });
    }

    const snapshot = await prisma.snapshot.update({
      where: { id },
      data: {
        name,
        description,
        tags: {
          set: tags?.map(tagId => ({ id: tagId })) || []
        }
      },
      include: {
        activity: true,
        merchant: true,
        tags: true
      }
    });

    res.json(snapshot);
  } catch (error) {
    console.error('Error updating snapshot:', error);
    res.status(500).json({ error: 'Failed to update snapshot' });
  }
};

// Delete a snapshot
const deleteSnapshot = async (req, res) => {
  try {
    const { id } = req.params;
    const merchantId = req.user.id;

    // Verify snapshot exists and belongs to merchant
    const snapshot = await prisma.snapshot.findFirst({
      where: {
        id,
        merchantId
      }
    });

    if (!snapshot) {
      return res.status(404).json({ error: 'Snapshot not found or not authorized' });
    }

    await prisma.snapshot.delete({
      where: { id }
    });

    res.json({ message: 'Snapshot deleted successfully' });
  } catch (error) {
    console.error('Error deleting snapshot:', error);
    res.status(500).json({ error: 'Failed to delete snapshot' });
  }
};

// Get snapshots by activity
const getSnapshotsByActivity = async (req, res) => {
  try {
    const { activityId } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    const [snapshots, total] = await Promise.all([
      prisma.snapshot.findMany({
        where: { activityId },
        skip: parseInt(skip),
        take: parseInt(limit),
        include: {
          merchant: true,
          tags: true
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.snapshot.count({ where: { activityId } })
    ]);

    res.json({
      snapshots,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching snapshots by activity:', error);
    res.status(500).json({ error: 'Failed to fetch snapshots' });
  }
};

// Get snapshots by merchant
const getSnapshotsByMerchant = async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    const [snapshots, total] = await Promise.all([
      prisma.snapshot.findMany({
        where: { merchantId },
        skip: parseInt(skip),
        take: parseInt(limit),
        include: {
          activity: true,
          tags: true
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.snapshot.count({ where: { merchantId } })
    ]);

    res.json({
      snapshots,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching snapshots by merchant:', error);
    res.status(500).json({ error: 'Failed to fetch snapshots' });
  }
};

module.exports = {
  createSnapshot,
  getSnapshots,
  getSnapshotById,
  updateSnapshot,
  deleteSnapshot,
  getSnapshotsByActivity,
  getSnapshotsByMerchant,
}; 