const prisma = require('../utils/prisma');

// 从数据库读取奖项列表
exports.getAwards = async (req, res) => {
  const awards = await prisma.award.findMany({
    select: {
      id: true,
      title: true,
      description: true,
      rewards: true,
      icon: true,
      color: true,
      comingSoon: true,
      completionType: true,
      metadata: true,
      createdAt: true,
      updatedAt: true
    }
  });
  return res.json({ status: 'success', data: { awards } });
};

exports.getUserAwards = async (req, res) => {
  const userId = req.user.id;
  // 预加载当前用户在所有任务上的进度
  const allUserTasks = await prisma.userTask.findMany({ where: { userId }, include: { task: true } });
  // 查询用户所有奖项及进度
  const userAwards = await prisma.userAward.findMany({
    where: { userId },
    include: { Award: true }
  });
  // 格式化为前端所需结构
  const awards = userAwards.map(ua => {
    // 当前奖项下的所有子任务进度
    const tasksForAward = allUserTasks.filter(ut => ut.task.awardId === ua.awardId);
    return {
      awardId: ua.awardId,
      title: ua.Award.title,
      description: ua.Award.description,
      icon: ua.Award.icon,
      color: ua.Award.color,
      comingSoon: ua.Award.comingSoon,
      completionType: ua.Award.completionType,
      rewards: ua.Award.rewards,
      tasks: tasksForAward.map(ut => ({
        id: ut.taskId,
        title: ut.task.title,
        description: ut.task.description,
        type: ut.task.type,
        totalCount: ut.task.totalCount,
        points: ut.task.points,
        requirement: ut.task.requirement,
        order: ut.task.order,
        progress: ut.progress,
        completed: ut.completed,
        completedAt: ut.completedAt
      })),
      status: ua.status,
      progress: ua.progress,
      claimed: ua.claimed,
      claimedAt: ua.claimedAt
    };
  });
  return res.json({ status: 'success', data: { awards } });
};