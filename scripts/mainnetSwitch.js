#!/usr/bin/env node
/**
 * Web3Auth network switch, phase 1 (Sapphire devnet -> Sapphire mainnet): the one-step user
 * migration that lets every existing account log back into the SAME User.id after the Wallet and
 * the TGE login move to the mainnet project.
 *
 * What it does NOT do: change any wallet. A wallet changes only when its owner logs in on the new
 * network and the token proves the new address (web3authIdentity.resolveUser, "network re-bind",
 * active while WEB3AUTH_NETWORK_REBIND=on). This script only records which accounts may re-bind,
 * and how:
 *
 *   --plan      read-only report: counts per authType / login key / pair state, wallets, server
 *               keys, external-wallet rows, e-mails shared case-insensitively by several rows,
 *               and the accounts that will NOT re-bind automatically, with the reason. Ends with
 *               GO or NO-GO (environment and database readiness).
 *   --apply     one transaction: copies the affected User columns (walletAddress, web3authVerifier,
 *               web3authVerifierId, web3authLinkedAt) into a new table
 *               mainnet_switch_backup_<runId>, records the run in Web3AuthNetworkRebindRun, writes
 *               one Web3AuthNetworkRebind row per account (old pair, old address, walletPolicy,
 *               evidence, status pending) and clears old-network pairs (they can never match a
 *               new-network token, and would block the re-bind). Idempotent: an account with a
 *               record, or linked to a current connection, is never selected again; a run with
 *               nothing to do writes nothing.
 *   --rollback  restores the four columns of every account of one run from its backup table
 *               (re-binds since the run included), deletes the run's records and marks the run
 *               rolled back. Idempotent.
 *
 * Which accounts: authType `web3auth`, regular (not organization), not disabled, without a
 * record, and either unlinked or linked to an old-network connection (any verifier that is
 * neither `external-wallet` nor in WEB3AUTH_ALLOWED_VERIFIERS). Accounts linked to
 * `external-wallet` keep their pair and wallet untouched: that identity does not depend on the
 * network.
 *
 * walletPolicy, decided per account (first match):
 *   keep     operator_keep          user id listed in --keep-wallet-ids <file> (one id per line)
 *   keep     server_wallet          a server-held key (privateKey set): not a Web3Auth address
 *   replace  devnet_pair            linked to an old-network social connection
 *   keep     external_wallet_email  the e-mail column holds a wallet address (external wallet)
 *   replace  x_verifier_id          the e-mail column holds `twitter|<id>` (X login)
 *   replace  no_wallet              nothing bound yet
 *   replace  email_unpaired         e-mail keyed, wallet from the old network. An external-wallet
 *                                   user who typed an e-mail looks the same in the database (and
 *                                   so does a pre-P0 squatter's wallet). Once a re-bind replaced
 *                                   that address it never logs in again (409 replaced_wallet, no
 *                                   duplicate): list real external-wallet owners in
 *                                   --keep-wallet-ids before --apply.
 *
 * Output: counts and user ids only — never an e-mail, wallet address or key.
 *
 * Environment: DATABASE_URL plus the backend's WEB3AUTH_* values for the cut (the readiness check
 * loads them exactly as the server would). See env.example "Web3Auth network switch".
 *
 * Usage:
 *   node scripts/mainnetSwitch.js --plan [--json] [--all-ids] [--keep-wallet-ids FILE]
 *   node scripts/mainnetSwitch.js --apply --yes [--json] [--keep-wallet-ids FILE]
 *   node scripts/mainnetSwitch.js --rollback --run RUN_ID --yes [--json]
 *   options: --from-network sapphire_devnet (default) --to-network sapphire_mainnet (default)
 *
 * Exit codes: 0 GO / done · 1 NO-GO (readiness failed, or the step was refused) · 2 usage ·
 *             3 unexpected error (nothing committed).
 */
const fs = require('fs');
const crypto = require('crypto');
const { isAddress } = require('ethers');

const EXIT = { GO: 0, NO_GO: 1, USAGE: 2, ERROR: 3 };
const EXTERNAL_WALLET = 'external-wallet';
const BACKUP_PREFIX = 'mainnet_switch_backup_';
const RUN_ID_PATTERN = /^\d{14}_[0-9a-f]{4}$/;
const APPLE_RELAY = /@privaterelay\.appleid\.com$/i;
const ID_PREVIEW = 50;

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    mode: null,
    json: false,
    allIds: false,
    yes: false,
    run: null,
    keepWalletIds: null,
    fromNetwork: 'sapphire_devnet',
    toNetwork: 'sapphire_mainnet',
  };
  const modes = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--plan': modes.push('plan'); break;
      case '--apply': modes.push('apply'); break;
      case '--rollback': modes.push('rollback'); break;
      case '--json': opts.json = true; break;
      case '--all-ids': opts.allIds = true; break;
      case '--yes': opts.yes = true; break;
      case '--run': opts.run = value(); break;
      case '--keep-wallet-ids': opts.keepWalletIds = value(); break;
      case '--from-network': opts.fromNetwork = value(); break;
      case '--to-network': opts.toNetwork = value(); break;
      default: throw new UsageError(`unknown argument ${arg}`);
    }
  }
  if (modes.length !== 1) throw new UsageError('give exactly one of --plan, --apply, --rollback');
  opts.mode = modes[0];
  if (opts.mode === 'rollback' && !opts.run) throw new UsageError('--rollback needs --run RUN_ID');
  if (opts.run && !RUN_ID_PATTERN.test(opts.run)) throw new UsageError('--run must look like 20261005120000_ab12');
  for (const n of [opts.fromNetwork, opts.toNetwork]) {
    if (!/^[a-z0-9_]{1,40}$/.test(n)) throw new UsageError(`bad network name ${n}`);
  }
  if (opts.fromNetwork === opts.toNetwork) throw new UsageError('--from-network and --to-network must differ');
  return opts;
}

function readKeepIds(file) {
  if (!file) return new Set();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read --keep-wallet-ids file (${err.code || err.message})`);
  }
  return new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, '').trim())
      .filter(Boolean)
  );
}

// ---------------------------------------------------------------------------
// Readiness (environment + database)
// ---------------------------------------------------------------------------

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const networkSuffix = (network) => network.replace(/_/g, '-'); // sapphire_devnet -> sapphire-devnet

/**
 * The cut is only safe when the backend would boot with this environment AND the re-bind is on
 * AND nothing of the old network is still accepted. Returns { config, blockers[], warnings[] }.
 */
function checkEnvironment(env, { fromNetwork, toNetwork }) {
  const blockers = [];
  const warnings = [];
  let config = null;
  try {
    const { _internals } = loadIdentityModule();
    config = _internals.assertBootConfig(env);
  } catch (err) {
    blockers.push(`backend would not boot with this environment: ${err.message}`);
    return { config, blockers, warnings };
  }
  if (!config.networkRebind) blockers.push('WEB3AUTH_NETWORK_REBIND is not "on"');
  const oldSuffix = networkSuffix(fromNetwork);
  const newSuffix = networkSuffix(toNetwork);
  const stale = config.allowedVerifiers.filter((v) => v.includes(oldSuffix));
  if (stale.length) blockers.push(`WEB3AUTH_ALLOWED_VERIFIERS still names ${oldSuffix} connections: ${stale.join(', ')}`);
  // An explicit external audience that is not the new client id would refuse every
  // external-wallet login after the cut (typically the old devnet id left in place).
  const externalAudience = csv(env.WEB3AUTH_EXTERNAL_AUDIENCE);
  if (externalAudience.length && !externalAudience.includes(config.clientId)) {
    blockers.push('WEB3AUTH_EXTERNAL_AUDIENCE is set and does not include WEB3AUTH_CLIENT_ID: empty it or set it to the new client id');
  }
  if (!config.allowedVerifiers.includes(EXTERNAL_WALLET)) {
    warnings.push(`WEB3AUTH_ALLOWED_VERIFIERS has no ${EXTERNAL_WALLET}: external-wallet accounts cannot log in`);
  }
  const foreign = config.rebindVerifiers.filter((v) => !v.includes(newSuffix));
  if (foreign.length) {
    warnings.push(`WEB3AUTH_REBIND_VERIFIERS entries without "${newSuffix}" (check them against a real token): ${foreign.join(', ')}`);
  }
  if (!config.rebindVerifiers.some((v) => /twitter|(^|-)x(-|$)/i.test(v))) {
    warnings.push('no X/twitter connection in WEB3AUTH_REBIND_VERIFIERS: X accounts will not re-bind');
  }
  if (!config.emailTrustedVerifiers.length) {
    warnings.push('WEB3AUTH_EMAIL_TRUSTED_VERIFIERS is empty: no e-mail-keyed account will re-bind');
  }
  if (config.mode !== 'enforce') warnings.push(`WEB3AUTH_VERIFY_MODE is ${config.mode}, not enforce (SSO requires enforce)`);
  if (config.pinMode !== 'enforce') warnings.push(`WEB3AUTH_JWKS_PIN_MODE is ${config.pinMode}, not enforce (SSO requires enforce)`);
  return { config, blockers, warnings };
}

let identityModule = null;
function loadIdentityModule() {
  if (!identityModule) {
    // Loading it runs the server's own boot assertion against process.env; a failure there is
    // exactly the answer readiness needs, so it is reported, not thrown.
    // eslint-disable-next-line global-require
    identityModule = require('../src/services/web3authIdentity');
  }
  return identityModule;
}

async function tablesReady(db) {
  const rows = await db.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('Web3AuthNetworkRebind', 'Web3AuthNetworkRebindRun')`
  );
  return rows.length === 2;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function loginKey(email) {
  const e = String(email || '');
  if (isAddress(e)) return 'wallet_address';
  if (/^twitter\|/i.test(e)) return 'x';
  if (e.includes('@')) return APPLE_RELAY.test(e) ? 'apple_relay' : 'email';
  return 'other';
}

/** Pair state of one row against the current allow-list. */
function pairState(row, allowed) {
  if (row.web3authVerifier == null && row.web3authVerifierId == null) return 'unlinked';
  if (row.web3authVerifier === EXTERNAL_WALLET) return 'external_wallet';
  if (allowed.includes(row.web3authVerifier)) return 'current';
  return 'old_network';
}

/** The record --apply writes for one selected row (see the header for the order). */
function classify(row, { keepIds = new Set(), allowed = [] } = {}) {
  const state = pairState(row, allowed);
  const base = {
    oldVerifier: state === 'old_network' ? row.web3authVerifier : null,
    oldVerifierId: state === 'old_network' ? row.web3authVerifierId : null,
    oldAddress: row.walletAddress || null,
  };
  const key = loginKey(row.email);
  if (keepIds.has(row.id)) return { ...base, walletPolicy: 'keep', evidence: 'operator_keep' };
  if (row.hasServerKey) return { ...base, walletPolicy: 'keep', evidence: 'server_wallet' };
  if (state === 'old_network') return { ...base, walletPolicy: 'replace', evidence: 'devnet_pair' };
  if (key === 'wallet_address') return { ...base, walletPolicy: 'keep', evidence: 'external_wallet_email' };
  if (key === 'x') return { ...base, walletPolicy: 'replace', evidence: 'x_verifier_id' };
  if (!row.walletAddress) return { ...base, walletPolicy: 'replace', evidence: 'no_wallet' };
  return { ...base, walletPolicy: 'replace', evidence: 'email_unpaired' };
}

const SELECT_USERS = `
  SELECT u.id, u.email, u."walletAddress", u."authType", u."userType", u."isOrganization",
         (u."disabledAt" IS NOT NULL) AS "disabled", (u."privateKey" IS NOT NULL) AS "hasServerKey",
         u."web3authVerifier", u."web3authVerifierId",
         r.status AS "rebindStatus", r."runId" AS "rebindRunId"
    FROM "User" u
    LEFT JOIN "Web3AuthNetworkRebind" r ON r."userId" = u.id`;

function isTarget(row, allowed) {
  if (row.authType !== 'web3auth') return false;
  if (row.userType === 'organization' || row.isOrganization) return false;
  if (row.disabled) return false;
  if (row.rebindStatus) return false;
  const state = pairState(row, allowed);
  return state === 'unlinked' || state === 'old_network';
}

const inc = (obj, key, by = 1) => {
  obj[key] = (obj[key] || 0) + by;
};

function idList(ids, all) {
  return all || ids.length <= ID_PREVIEW ? ids : ids.slice(0, ID_PREVIEW);
}

/** The read-only report. `rows` come from SELECT_USERS. */
function buildPlan(rows, { allowed, keepIds, allIds, rebindVerifiers = [], emailTrustedVerifiers = [] }) {
  const report = {
    users_total: rows.length,
    by_auth_type: {},
    web3auth_regular: { total: 0, by_login_key: {}, by_pair_state: {}, with_wallet: 0, with_server_key: 0 },
    organizations: 0,
    disabled: 0,
    records: { pending: 0, rebound: 0 },
    to_record: { total: 0, by_evidence: {}, by_policy: {}, old_network_pairs_cleared: 0 },
    duplicate_emails: { groups: 0, rows: 0, ids: [] },
    not_automatic: {},
  };
  const notAuto = {};
  const addNotAuto = (reason, id) => {
    notAuto[reason] = notAuto[reason] || [];
    notAuto[reason].push(id);
  };

  // E-mails several rows share once case is ignored: the token cannot say which one is meant.
  const byLower = new Map();
  for (const row of rows) {
    const k = String(row.email || '').toLowerCase();
    if (!byLower.has(k)) byLower.set(k, []);
    byLower.get(k).push(row.id);
  }
  const duplicateIds = new Set();
  for (const ids of byLower.values()) {
    if (ids.length > 1) {
      report.duplicate_emails.groups += 1;
      report.duplicate_emails.rows += ids.length;
      ids.forEach((id) => duplicateIds.add(id));
    }
  }
  report.duplicate_emails.ids = idList([...duplicateIds], allIds);

  const xConfigured = rebindVerifiers.some((v) => /twitter|(^|-)x(-|$)/i.test(v));
  const appleConfigured = emailTrustedVerifiers.some((v) => /apple/i.test(v));

  for (const row of rows) {
    inc(report.by_auth_type, row.authType || 'null');
    if (row.disabled) report.disabled += 1;
    const org = row.userType === 'organization' || row.isOrganization;
    if (org) report.organizations += 1;
    if (row.rebindStatus) inc(report.records, row.rebindStatus);
    if (row.authType !== 'web3auth') continue;
    if (org) {
      addNotAuto('organization', row.id);
      continue;
    }
    const w = report.web3auth_regular;
    w.total += 1;
    const key = loginKey(row.email);
    inc(w.by_login_key, key);
    const state = pairState(row, allowed);
    inc(w.by_pair_state, state);
    if (row.walletAddress) w.with_wallet += 1;
    if (row.hasServerKey) w.with_server_key += 1;
    if (row.disabled) {
      addNotAuto('disabled', row.id);
      continue;
    }
    if (!isTarget(row, allowed)) continue;

    const rec = classify(row, { keepIds, allowed });
    report.to_record.total += 1;
    inc(report.to_record.by_evidence, rec.evidence);
    inc(report.to_record.by_policy, rec.walletPolicy);
    if (rec.oldVerifier) report.to_record.old_network_pairs_cleared += 1;

    if (duplicateIds.has(row.id) && key !== 'x' && key !== 'wallet_address') addNotAuto('ambiguous_email', row.id);
    if (key === 'apple_relay') addNotAuto(appleConfigured ? 'apple_relay_address_may_differ' : 'apple_not_email_trusted', row.id);
    if (key === 'x' && !xConfigured) addNotAuto('x_not_in_rebind_verifiers', row.id);
    if (key === 'other') addNotAuto('unknown_login_key', row.id);
    if (key === 'wallet_address') addNotAuto('external_wallet_only', row.id);
    if (key === 'email' && !emailTrustedVerifiers.length) addNotAuto('no_email_trusted_verifier', row.id);
  }
  // Rows outside Web3Auth with an e-mail a Web3Auth login could name: refused as before.
  const traditional = rows.filter((r) => r.authType !== 'web3auth').map((r) => r.id);
  if (traditional.length) notAuto.not_web3auth = traditional;

  for (const [reason, ids] of Object.entries(notAuto)) {
    report.not_automatic[reason] = { count: ids.length, ids: idList(ids, allIds) };
  }
  return report;
}

const NOT_AUTOMATIC_WHY = {
  not_web3auth: 'password / non-Web3Auth account: a Web3Auth login with its e-mail stays refused (candidate_not_web3auth)',
  organization: 'organization account: Web3Auth login is refused (ORG_NOT_ALLOWED)',
  disabled: 'disabled account: login is refused (ACCOUNT_DISABLED)',
  ambiguous_email: 'its e-mail matches another row case-insensitively: re-bind by e-mail is refused (ambiguous_email) until ops merges or renames one',
  apple_relay_address_may_differ: 'Apple private-relay address: re-binds only if the mainnet Apple connection releases the same relay address; otherwise the login creates a new account',
  apple_not_email_trusted: 'Apple private-relay address and no Apple connection in WEB3AUTH_EMAIL_TRUSTED_VERIFIERS',
  x_not_in_rebind_verifiers: 'X account and no X connection in WEB3AUTH_REBIND_VERIFIERS',
  unknown_login_key: 'e-mail column is neither an e-mail, twitter|<id> nor a wallet: no allowed connection asserts it',
  external_wallet_only: 'external-wallet account: re-binds (wallet kept) only when the user signs in with that wallet',
  no_email_trusted_verifier: 'e-mail account and WEB3AUTH_EMAIL_TRUSTED_VERIFIERS is empty',
};

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function readiness(db, opts, env) {
  const envCheck = checkEnvironment(env, opts);
  const blockers = [...envCheck.blockers];
  if (!(await tablesReady(db))) {
    blockers.push('tables Web3AuthNetworkRebind / Web3AuthNetworkRebindRun missing: run `npx prisma migrate deploy` first');
  }
  return { config: envCheck.config, blockers, warnings: envCheck.warnings };
}

async function plan(db, opts, env = process.env) {
  const ready = await readiness(db, opts, env);
  const allowed = ready.config ? ready.config.allowedVerifiers : csv(env.WEB3AUTH_ALLOWED_VERIFIERS);
  const tables = !ready.blockers.some((b) => b.startsWith('tables '));
  const rows = await db.$queryRawUnsafe(
    tables
      ? SELECT_USERS
      : SELECT_USERS.replace(/,\s*r\.status[\s\S]*$/, `, NULL AS "rebindStatus", NULL AS "rebindRunId" FROM "User" u`)
  );
  const report = buildPlan(rows, {
    allowed,
    keepIds: readKeepIds(opts.keepWalletIds),
    allIds: opts.allIds,
    rebindVerifiers: ready.config ? ready.config.rebindVerifiers : csv(env.WEB3AUTH_REBIND_VERIFIERS),
    emailTrustedVerifiers: ready.config ? ready.config.emailTrustedVerifiers : csv(env.WEB3AUTH_EMAIL_TRUSTED_VERIFIERS),
  });
  const runs = tables
    ? await db.web3AuthNetworkRebindRun.findMany({ orderBy: { appliedAt: 'asc' } })
    : [];
  return {
    mode: 'plan',
    go: ready.blockers.length === 0,
    blockers: ready.blockers,
    warnings: ready.warnings,
    from_network: opts.fromNetwork,
    to_network: opts.toNetwork,
    report,
    runs: runs.map((r) => ({
      id: r.id,
      backup_table: r.backupTable,
      accounts: r.accountCount,
      applied_at: r.appliedAt,
      rolled_back_at: r.rolledBackAt,
    })),
  };
}

function newRunId(now = new Date()) {
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${ts}_${crypto.randomBytes(2).toString('hex')}`;
}

async function apply(db, opts, env = process.env) {
  const ready = await readiness(db, opts, env);
  if (ready.blockers.length) {
    return { mode: 'apply', go: false, applied: false, blockers: ready.blockers, warnings: ready.warnings };
  }
  if (!opts.yes) throw new UsageError('--apply changes the database: add --yes');
  const allowed = ready.config.allowedVerifiers;
  const keepIds = readKeepIds(opts.keepWalletIds);
  const runId = opts.runId || newRunId();
  const backupTable = `${BACKUP_PREFIX}${runId}`;

  const result = await db.$transaction(
    async (tx) => {
      // Lock every candidate so a concurrent login cannot link one between the read and the write.
      const rows = await tx.$queryRawUnsafe(`${SELECT_USERS} FOR UPDATE OF u`);
      const targets = rows.filter((row) => isTarget(row, allowed));
      if (!targets.length) return { runId: null, backupTable: null, targets: [] };
      const ids = targets.map((r) => r.id);

      await tx.$executeRawUnsafe(
        `CREATE TABLE "${backupTable}" AS
           SELECT id, "walletAddress", "web3authVerifier", "web3authVerifierId", "web3authLinkedAt",
                  now() AS "backedUpAt"
             FROM "User" WHERE id = ANY($1::text[])`,
        ids
      );
      await tx.$executeRawUnsafe(`ALTER TABLE "${backupTable}" ADD PRIMARY KEY (id)`);
      const [{ n }] = await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${backupTable}"`);
      if (n !== ids.length) throw new Error(`backup holds ${n} rows, expected ${ids.length}`);

      await tx.web3AuthNetworkRebindRun.create({
        data: {
          id: runId,
          backupTable,
          fromNetwork: opts.fromNetwork,
          toNetwork: opts.toNetwork,
          accountCount: ids.length,
        },
      });
      const records = targets.map((row) => ({
        userId: row.id,
        runId,
        fromNetwork: opts.fromNetwork,
        toNetwork: opts.toNetwork,
        ...classify(row, { keepIds, allowed }),
      }));
      await tx.web3AuthNetworkRebind.createMany({ data: records });
      const stale = records.filter((r) => r.oldVerifier).map((r) => r.userId);
      if (stale.length) {
        await tx.user.updateMany({
          where: { id: { in: stale } },
          data: { web3authVerifier: null, web3authVerifierId: null, web3authLinkedAt: null },
        });
      }
      return { runId, backupTable, targets: records, stale: stale.length };
    },
    { timeout: 120000, maxWait: 10000 }
  );

  if (!result.runId) {
    return { mode: 'apply', go: true, applied: false, nothing_to_do: true, warnings: ready.warnings };
  }
  const byEvidence = {};
  const byPolicy = {};
  for (const r of result.targets) {
    inc(byEvidence, r.evidence);
    inc(byPolicy, r.walletPolicy);
  }
  return {
    mode: 'apply',
    go: true,
    applied: true,
    run_id: result.runId,
    backup_table: result.backupTable,
    accounts: result.targets.length,
    by_evidence: byEvidence,
    by_policy: byPolicy,
    old_network_pairs_cleared: result.stale,
    warnings: ready.warnings,
  };
}

async function rollback(db, opts) {
  if (!(await tablesReady(db))) {
    return { mode: 'rollback', go: false, blockers: ['rebind tables missing: nothing was applied'] };
  }
  const run = await db.web3AuthNetworkRebindRun.findUnique({ where: { id: opts.run } });
  if (!run) return { mode: 'rollback', go: false, blockers: [`run ${opts.run} not found`] };
  if (run.rolledBackAt) {
    return { mode: 'rollback', go: true, rolled_back: false, already_rolled_back_at: run.rolledBackAt, run_id: run.id };
  }
  const [{ present }] = await db.$queryRawUnsafe(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_schema = current_schema() AND table_name = $1) AS present`,
    run.backupTable
  );
  if (!present) return { mode: 'rollback', go: false, blockers: [`backup table ${run.backupTable} is missing`] };
  if (!opts.yes) throw new UsageError('--rollback changes the database: add --yes');

  const result = await db.$transaction(
    async (tx) => {
      const [{ rebound }] = await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS rebound FROM "Web3AuthNetworkRebind" WHERE "runId" = $1 AND status = 'rebound'`,
        run.id
      );
      const restored = await tx.$executeRawUnsafe(
        `UPDATE "User" u
            SET "walletAddress" = b."walletAddress",
                "web3authVerifier" = b."web3authVerifier",
                "web3authVerifierId" = b."web3authVerifierId",
                "web3authLinkedAt" = b."web3authLinkedAt"
           FROM "${run.backupTable}" b
          WHERE u.id = b.id`
      );
      const deleted = await tx.web3AuthNetworkRebind.deleteMany({ where: { runId: run.id } });
      await tx.web3AuthNetworkRebindRun.update({ where: { id: run.id }, data: { rolledBackAt: new Date() } });
      return { restored, rebound, deleted: deleted.count };
    },
    { timeout: 120000, maxWait: 10000 }
  );
  return {
    mode: 'rollback',
    go: true,
    rolled_back: true,
    run_id: run.id,
    backup_table: run.backupTable,
    accounts_restored: result.restored,
    rebinds_reverted: result.rebound,
    records_deleted: result.deleted,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printHuman(out, log = console.log) {
  const line = (s = '') => log(s);
  if (out.mode === 'plan') {
    const r = out.report;
    line(`Web3Auth network switch plan: ${out.from_network} -> ${out.to_network}`);
    line(`users_total ${r.users_total}`);
    line(`by_auth_type ${JSON.stringify(r.by_auth_type)}  organizations ${r.organizations}  disabled ${r.disabled}`);
    const w = r.web3auth_regular;
    line(`web3auth regular accounts ${w.total}: with_wallet ${w.with_wallet}, with_server_key ${w.with_server_key}`);
    line(`  by_login_key ${JSON.stringify(w.by_login_key)}`);
    line(`  by_pair_state ${JSON.stringify(w.by_pair_state)}`);
    line(`existing records ${JSON.stringify(r.records)}`);
    line(`--apply would record ${r.to_record.total} accounts (old-network pairs cleared: ${r.to_record.old_network_pairs_cleared})`);
    line(`  by_evidence ${JSON.stringify(r.to_record.by_evidence)}`);
    line(`  by_policy ${JSON.stringify(r.to_record.by_policy)}`);
    line(`duplicate e-mails (case-insensitive): ${r.duplicate_emails.groups} groups, ${r.duplicate_emails.rows} rows`);
    if (r.duplicate_emails.ids.length) line(`  ids ${r.duplicate_emails.ids.join(' ')}`);
    line('will NOT re-bind automatically:');
    const reasons = Object.entries(r.not_automatic);
    if (!reasons.length) line('  none');
    for (const [reason, { count, ids }] of reasons) {
      line(`  ${reason} ${count} — ${NOT_AUTOMATIC_WHY[reason] || reason}`);
      line(`    ids ${ids.join(' ')}${count > ids.length ? ` … (+${count - ids.length}, --all-ids)` : ''}`);
    }
    if (out.runs.length) {
      line('runs:');
      for (const run of out.runs) {
        line(`  ${run.id} accounts ${run.accounts} backup ${run.backup_table}${run.rolled_back_at ? ' ROLLED BACK' : ''}`);
      }
    }
  } else {
    const { mode, go, blockers, warnings, ...rest } = out;
    line(`${mode}: ${JSON.stringify(rest)}`);
  }
  for (const w of out.warnings || []) line(`WARNING ${w}`);
  for (const b of out.blockers || []) line(`BLOCKER ${b}`);
  line(out.go ? 'GO' : 'NO-GO');
}

async function main(argv = process.argv.slice(2), { db, env = process.env, log = console.log } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      log(`usage error: ${err.message}`);
      return EXIT.USAGE;
    }
    throw err;
  }
  // eslint-disable-next-line global-require
  const prisma = db || require('../src/utils/prisma');
  try {
    let out;
    if (opts.mode === 'plan') out = await plan(prisma, opts, env);
    else if (opts.mode === 'apply') out = await apply(prisma, opts, env);
    else out = await rollback(prisma, opts);
    if (opts.json) log(JSON.stringify(out, null, 2));
    else printHuman(out, log);
    return out.go ? EXIT.GO : EXIT.NO_GO;
  } catch (err) {
    if (err instanceof UsageError) {
      log(`usage error: ${err.message}`);
      return EXIT.USAGE;
    }
    // Messages only: a Prisma error can carry row values.
    log(`error: ${err && err.code ? `${err.code} ` : ''}${String((err && err.message) || err).split('\n')[0]}`);
    return EXIT.ERROR;
  } finally {
    if (!db) await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`error: ${String((err && err.message) || err).split('\n')[0]}`);
      process.exit(EXIT.ERROR);
    }
  );
}

module.exports = {
  EXIT,
  parseArgs,
  classify,
  loginKey,
  pairState,
  buildPlan,
  checkEnvironment,
  plan,
  apply,
  rollback,
  main,
  newRunId,
};
