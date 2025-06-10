const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.getAllTags = async (req, res) => {
  try {
    const tags = await prisma.tag.findMany();
    res.status(200).json({ status: 'success', data: tags });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error', error: error.message });
  }
};

exports.createTag = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ status: 'fail', message: 'Tag name is required' });
    }
    const exists = await prisma.tag.findFirst({ where: { name } });
    if (exists) {
      return res.status(400).json({ status: 'fail', message: 'Tag already exists' });
    }
    const tag = await prisma.tag.create({ data: { name } });
    res.status(201).json({ status: 'success', data: tag });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error', error: error.message });
  }
}; 