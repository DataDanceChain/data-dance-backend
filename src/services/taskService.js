const prisma = require('../utils/prisma');

async function getTasksByAward(userId, awardId) {
  // fetch all tasks for award
  const tasks = await prisma.task.findMany({ where: { awardId } });
  // fetch user progress for these tasks
  const userTasks = await prisma.userTask.findMany({ where: { userId, task: { awardId } }, include: { task: true } });
  return tasks.map(task => {
    const ut = userTasks.find(u => u.taskId === task.id);
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      type: task.type,
      totalCount: task.totalCount,
      points: task.points,
      requirement: task.requirement,
      order: task.order,
      progress: ut?.progress || 0,
      completed: ut?.completed || false,
      claimed: ut?.claimed || false,
      completedAt: ut?.completedAt || null
    };
  });
}

async function recordTaskProgress(userId, taskId, delta) {
  // upsert userTask progress
  const ut = await prisma.userTask.upsert({
    where: { userId_taskId: { userId, taskId } },
    update: { progress: { increment: delta } },
    create: { userId, taskId, progress: delta }
  });
  // check completion
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (ut.progress >= task.totalCount && !ut.completed) {
    await prisma.userTask.update({ where: { userId_taskId: { userId, taskId } }, data: { completed: true, completedAt: new Date() } });
  }
  return await prisma.userTask.findUnique({ where: { userId_taskId: { userId, taskId } } });
}

async function claimTask(userId, taskId) {
  const ut = await prisma.userTask.findUnique({ where: { userId_taskId: { userId, taskId } }, include: { task: true } });
  if (!ut || !ut.completed) throw new Error('Task not completed');
  if (ut.claimed) throw new Error('Task already claimed');
  // mark claimed and award points
  await prisma.userTask.update({ where: { userId_taskId: { userId, taskId } }, data: { claimed: true } });
  await prisma.point.create({ data: { userId, amount: ut.task.points, source: 'TASK_CLAIM', sourceId: taskId } });
  return { claimedAt: new Date(), points: ut.task.points };
}

module.exports = { getTasksByAward, recordTaskProgress, claimTask };