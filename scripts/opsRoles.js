#!/usr/bin/env node
/**
 * Ops role grants from the command line (admin issue #2). The first ddc_admin accounts are
 * granted here after a deploy; after that, ddc_admin accounts manage roles on the ops site.
 *
 * Usage:
 *   node scripts/opsRoles.js list   [--role <role>]
 *   node scripts/opsRoles.js grant  --email <e> --role <role> --reason "<why>" [--apply]
 *   node scripts/opsRoles.js revoke --email <e> --role <role> --reason "<why>" [--apply]
 *
 * Roles: ddc_admin | operator | developer. A grant or revoke is a dry run unless --apply is
 * given: it checks everything and prints what would change, and writes nothing. Applied, it uses
 * the same rules as the ops API (disabled and organization accounts refused, LAST_ADMIN) and
 * writes an audit row (actor kind `system`, label `script`, surface `script`).
 */
const { ROLES, isRole, cleanReason } = require('../src/constants/opsRoles');

const USAGE = [
  'Usage:',
  '  node scripts/opsRoles.js list   [--role <role>]',
  '  node scripts/opsRoles.js grant  --email <e> --role <role> --reason "<why>" [--apply]',
  '  node scripts/opsRoles.js revoke --email <e> --role <role> --reason "<why>" [--apply]',
  `Roles: ${ROLES.join(' | ')}`,
].join('\n');

class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['list', 'grant', 'revoke'].includes(command)) throw new UsageError(USAGE);
  const opts = { command, apply: false, email: null, role: null, reason: null };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--apply') {
      opts.apply = true;
    } else if (['--email', '--role', '--reason'].includes(arg)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value.\n${USAGE}`);
      opts[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new UsageError(`Unknown argument: ${arg}\n${USAGE}`);
    }
  }
  if (opts.role !== null && !isRole(opts.role)) throw new UsageError(`--role must be one of ${ROLES.join(', ')}.`);
  if (command !== 'list') {
    if (!opts.email) throw new UsageError(`--email is required.\n${USAGE}`);
    if (!opts.role) throw new UsageError(`--role is required.\n${USAGE}`);
    if (!cleanReason(opts.reason)) throw new UsageError('--reason must be 3 to 200 characters.');
  }
  return opts;
}

/** Exactly one account with this e-mail (case-insensitive), or an error. */
async function findAccount(db, email) {
  const rows = await db.user.findMany({
    where: { email: { equals: String(email).trim(), mode: 'insensitive' } },
    select: { id: true, email: true, disabledAt: true, isOrganization: true, userType: true },
    take: 2,
  });
  if (rows.length === 0) throw new Error(`No account uses ${email}.`);
  if (rows.length > 1) throw new Error(`More than one account matches ${email} (case-insensitive); resolve it first.`);
  return rows[0];
}

async function run(opts, { db, log = console.log } = {}) {
  const userRoles = require('../src/services/userRoles');
  const { SCRIPT_ACTOR, OpsError } = require('../src/services/opsAudit');
  if (opts.command === 'list') {
    const items = await userRoles.listGrants({ role: opts.role || undefined }, db);
    if (!items.length) log('No grants.');
    for (const item of items) {
      const status = item.disabledAt ? ' (disabled)' : '';
      log(`${item.role}\t${item.email}${status}\t${item.userId}\tby ${item.grantedBy}\t${new Date(item.grantedAt).toISOString()}\t${item.reason}`);
    }
    return { command: 'list', count: items.length };
  }

  const account = await findAccount(db, opts.email);
  const roles = await userRoles.activeRoles(account.id, db);
  const holds = roles.includes(opts.role);
  if (!opts.apply) {
    let outcome;
    if (opts.command === 'grant') {
      if (account.disabledAt) outcome = 'refused: ACCOUNT_DISABLED';
      else if (account.isOrganization || account.userType === 'organization') outcome = 'refused: ORG_NOT_ALLOWED';
      else outcome = holds ? 'refused: ALREADY_GRANTED' : 'would grant';
    } else if (!holds) {
      outcome = 'refused: NOT_GRANTED';
    } else if (opts.role === 'ddc_admin' && !account.disabledAt) {
      const others = await userRoles.otherEnabledAdmins(db, account.id);
      outcome = others === 0 ? 'refused: LAST_ADMIN' : 'would revoke';
    } else {
      outcome = 'would revoke';
    }
    log(`DRY RUN ${opts.command} ${opts.role} for ${account.email} (${account.id}): ${outcome}. Nothing written; add --apply.`);
    return { command: opts.command, applied: false, outcome, userId: account.id };
  }

  const input = {
    userId: account.id,
    role: opts.role,
    reason: opts.reason,
    actor: SCRIPT_ACTOR,
    surface: 'script',
    requestId: null,
  };
  try {
    const result = opts.command === 'grant'
      ? await userRoles.grantRole(input, db)
      : await userRoles.revokeRole(input, db);
    log(`${opts.command === 'grant' ? 'Granted' : 'Revoked'} ${opts.role} for ${account.email} (${account.id}); audit ${result.auditId}.`);
    return { command: opts.command, applied: true, userId: account.id, auditId: result.auditId };
  } catch (error) {
    if (error instanceof OpsError) throw new Error(`${error.code}: ${error.message}`);
    throw error;
  }
}

async function main(argv = process.argv.slice(2), { db, log = console.log, logError = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    logError(error.message);
    return 2;
  }
  const client = db || require('../src/utils/prisma');
  try {
    await run(opts, { db: client, log });
    return 0;
  } catch (error) {
    logError(error.message);
    return 1;
  } finally {
    if (!db && typeof client.$disconnect === 'function') await client.$disconnect();
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { parseArgs, run, main, findAccount, UsageError };
