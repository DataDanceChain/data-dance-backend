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
    // Return updated task status
    return res.json({ status: 'success', data: { taskId: ut.taskId, status: ut.status } });
  } catch (error) {
    console.error(error);
    return res.status(400).json({ status: 'fail', message: error.message });
  }
};

exports.claimTask = async (req, res) => {
  const { taskId } = req.params;
  // Call service
  const serviceResult = await claimTask(req.user.id, taskId);
  if (serviceResult.status !== 'success') {
    // Return error response with appropriate status code
    return res
      .status(serviceResult.status)
      .json({ status: 'fail', message: serviceResult.error.message });
  }
  // Successful claim
  const { taskId: id, claimedAt, points } = serviceResult.data;
  return res.json({ status: 'success', data: { taskId: id, claimedAt, points } });
};