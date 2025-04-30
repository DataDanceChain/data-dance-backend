const { getTasksByAward, recordTaskProgress, claimTask } = require('../services/taskService');

exports.getTasksByAward = async (req, res) => {
  const { awardId } = req.params;
  try {
    const tasks = await getTasksByAward(req.user.id, awardId);
    return res.json({ status: 'success', data: { tasks } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.recordTaskProgress = async (req, res) => {
  const { taskId } = req.params;
  const { delta } = req.body;
  try {
    const ut = await recordTaskProgress(req.user.id, taskId, delta);
    return res.json({ status: 'success', data: { taskId: ut.taskId, progress: ut.progress, completed: ut.completed } });
  } catch (error) {
    console.error(error);
    return res.status(400).json({ status: 'fail', message: error.message });
  }
};

exports.claimTask = async (req, res) => {
  const { taskId } = req.params;
  try {
    const result = await claimTask(req.user.id, taskId);
    return res.json({ status: 'success', data: { taskId, claimedAt: result.claimedAt, points: result.points } });
  } catch (error) {
    console.error(error);
    return res.status(400).json({ status: 'fail', message: error.message });
  }
};