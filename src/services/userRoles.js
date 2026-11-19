/** Current role grants for dedicated developer-host authorization. No role mutation routes. */
const prisma = require('../utils/prisma');
const { ROLES, isRole } = require('../constants/opsRoles');
async function activeRoles(userId, db = prisma) {
  if (typeof userId !== 'string' || !userId) return [];
  const rows = await db.userRoleGrant.findMany({ where: { userId }, select: { role: true } });
  return [...new Set(rows.map(row => row.role).filter(isRole))].sort((a, b) => ROLES.indexOf(a) - ROLES.indexOf(b));
}
module.exports = { activeRoles };
