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
      },
      include: {
        claims: {
          select: {
            id: true,
            userId: true,
            status: true,
            claimedAt: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true
              }
            }
          }
        }
      }
    });

    if (!activity) {
      return res.status(404).json({ error: 'Activity not found or not authorized' });
    }

    // 格式化 claims 数据
    const formattedClaims = activity.claims.map(claim => ({
      id: claim.id,
      userId: claim.userId,
      status: claim.status,
      claimedAt: claim.claimedAt,
      user: {
        id: claim.user.id,
        name: claim.user.name,
        email: claim.user.email
      }
    }));

    // Create snapshot with tags and claims
    const snapshot = await prisma.snapshot.create({
      data: {
        name,
        description,
        activityId,
        merchantId,
        claims: formattedClaims, // 保存格式化后的 claims 信息
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

// Create snapshot from CSV upload (standalone data pack, no activity required)
const createSnapshotFromCSV = async (req, res) => {
  try {
    const { name, description, tags } = req.body;
    const merchantId = req.user.id;
    const csvFile = req.file;

    if (!csvFile) {
      return res.status(400).json({ error: 'CSV file is required' });
    }

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // Parse CSV file
    const fs = require('fs');
    const csvContent = fs.readFileSync(csvFile.path, 'utf-8');
    
    // Simple CSV parser (supports quoted fields)
    function parseCSVLine(line) {
      const result = [];
      let current = '';
      let inQuotes = false;
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          result.push(current);
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current);
      return result.map(item => item.replace(/^"|"$/g, '').trim());
    }

    const lines = csvContent.split('\n').filter(line => line.trim());
    if (lines.length < 2) {
      return res.status(400).json({ error: 'CSV file must contain at least a header row and one data row' });
    }

    const headers = parseCSVLine(lines[0]);
    const data = [];
    
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      if (values.length === headers.length) {
        const record = {};
        headers.forEach((header, index) => {
          const trimmedHeader = header.trim();
          const trimmedValue = values[index].trim();
          if (trimmedHeader && trimmedValue) {
            record[trimmedHeader] = trimmedValue;
          }
        });
        data.push(record);
      }
    }

    // Find email field
    const emailField = headers.find(h => 
      h.toLowerCase().includes('email') || 
      h.toLowerCase().includes('邮箱') ||
      h.toLowerCase().includes('mail')
    );

    if (!emailField) {
      return res.status(400).json({ error: 'CSV must contain an email field (邮箱/email/mail)' });
    }

    // Filter valid records (must have email)
    const validRecords = data.filter(record => record[emailField] && record[emailField].trim());
    const recordsWithoutEmail = data.length - validRecords.length;

    if (validRecords.length === 0) {
      return res.status(400).json({ error: 'No valid records with email found in CSV' });
    }

    // Create snapshot data
    const snapshotData = {
      name,
      description: description || `Data pack imported from ${csvFile.originalname}`,
      merchantId,
      claims: {
        source: csvFile.path,
        fileName: csvFile.originalname,
        importDate: new Date().toISOString(),
        recordCount: validRecords.length,
        totalRecords: data.length,
        skippedRecords: recordsWithoutEmail,
        headers: headers,
        emailField: emailField,
        records: validRecords.map((record, index) => ({
          recordId: index + 1,
          email: record[emailField],
          ...record
        }))
      }
    };

    // Create snapshot
    const snapshot = await prisma.snapshot.create({
      data: snapshotData,
      include: {
        merchant: true,
        tags: true
      }
    });

    // Add tags if provided
    if (tags && Array.isArray(tags) && tags.length > 0) {
      await prisma.snapshot.update({
        where: { id: snapshot.id },
        data: {
          tags: {
            connect: tags.map(tagId => ({ id: tagId }))
          }
        }
      });
    }

    // Add "Data Pack" tag
    let dataPackTag = await prisma.tag.findFirst({
      where: { name: "Data Pack" }
    });
    
    if (!dataPackTag) {
      dataPackTag = await prisma.tag.create({
        data: { name: "Data Pack" }
      });
    }

    await prisma.snapshot.update({
      where: { id: snapshot.id },
      data: {
        tags: {
          connect: { id: dataPackTag.id }
        }
      }
    });

    // Clean up uploaded file
    fs.unlinkSync(csvFile.path);

    // Fetch updated snapshot with tags
    const finalSnapshot = await prisma.snapshot.findUnique({
      where: { id: snapshot.id },
      include: {
        merchant: true,
        tags: true
      }
    });

    res.status(201).json({
      ...finalSnapshot,
      importSummary: {
        totalRecords: data.length,
        validRecords: validRecords.length,
        skippedRecords: recordsWithoutEmail,
        emailField: emailField
      }
    });
  } catch (error) {
    console.error('Error creating snapshot from CSV:', error);
    
    // Clean up file if exists
    if (req.file && req.file.path) {
      try {
        const fs = require('fs');
        fs.unlinkSync(req.file.path);
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    res.status(500).json({ 
      error: 'Failed to create snapshot from CSV',
      message: error.message 
    });
  }
};

module.exports = {
  createSnapshot,
  createSnapshotFromCSV,
  getSnapshots,
  getSnapshotById,
  updateSnapshot,
  deleteSnapshot,
  getSnapshotsByActivity,
  getSnapshotsByMerchant,
}; 