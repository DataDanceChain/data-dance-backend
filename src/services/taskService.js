const prisma = require('../utils/prisma');

async function getTasksByAward(userId, awardId) {
  const tasks = await prisma.task.findMany({ where: { awardId } });
  const userTasks = await prisma.userTask.findMany({ where: { userId }, include: { task: true } });
  return tasks.map(task => {
    const ut = userTasks.find(u => u.taskId === task.id);
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      type: task.type,
      points: task.points,
      status: ut?.status || task.status,
      claimRecords: ut?.claimRecords || [],
      claimable: (ut?.status || task.status) === 'LIVE'
    };
  });
}

async function recordTaskProgress(userId, taskId, delta) {
  // mark task as available (LIVE) upon progress trigger
  const ut = await prisma.userTask.upsert({
    where: { userId_taskId: { userId, taskId } },
    update: { status: 'LIVE' },
    create: { userId, taskId, status: 'LIVE' }
  });
  return ut;
}

async function claimTask(userId, taskId) {
  const ut = await prisma.userTask.findUnique({ where: { userId_taskId: { userId, taskId } }, include: { task: true } });
  if (!ut || ut.status !== 'LIVE') throw new Error('Task not claimable');
  const now = new Date();
  // append claim timestamp and update status if limit reached
  const updates = { claimRecords: { push: now } };
  if (ut.task.claimLimit != null && (ut.claimRecords.length + 1) >= ut.task.claimLimit) {
    updates.status = 'INVALID';
  }
  await prisma.userTask.update({ where: { userId_taskId: { userId, taskId } }, data: updates });
  // award points
  await prisma.point.create({ data: { userId, amount: ut.task.points, source: 'TASK_CLAIM', sourceId: taskId } });
  return { claimedAt: now, points: ut.task.points };
}

module.exports = { getTasksByAward, recordTaskProgress, claimTask };