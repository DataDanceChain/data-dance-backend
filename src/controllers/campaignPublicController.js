const { listActivePublic } = require('../services/campaignEffects');

exports.listActive = async (req, res) => {
  try {
    const items = await listActivePublic();
    return res.json({ status: 'success', data: { items } });
  } catch (error) {
    console.error('Active campaigns error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};
