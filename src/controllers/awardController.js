const { getAwardDefinitions, getUserAwards: fetchUserAwards } = require('../services/awardService');

// Fetch platform award definitions
exports.getAwards = async (req, res) => {
  try {
    const awards = await getAwardDefinitions();
    return res.json({ status: 'success', data: { awards } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.getUserAwards = async (req, res) => {
  try {
    const data = await fetchUserAwards(req.user.id);
    return res.json({ status: 'success', data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};