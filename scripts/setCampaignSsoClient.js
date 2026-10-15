#!/usr/bin/env node
/**
 * Sets or clears the partner SSO client of one campaign card (config.ssoClientId): the client the
 * App hands the signed-in user off to when the card is opened, so the partner page opens already
 * signed in (see docs/TGE_SSO.md "App hand-off"). The admin form has no field for it.
 *
 * Only an EXTERNAL home card (HOME_CARD) or directory item (DIRECTORY_ITEM) carries one. The id
 * must pass the rule the ops API applies when a card is saved (campaignRules.campaignSsoClientIds):
 * the partner client this deployment is configured with (SSO_TGE_CLIENT_ID), or an enabled
 * first-party partner client stored in the database. Developer clients and the retired ids are
 * refused.
 *
 * Dry run by default: prints the card and the id before and after, and writes nothing. --apply
 * writes it with a campaign event (actor "ops-script"). The App reads the id from the public card
 * list, so a change takes effect without a restart. The "app hand-off" line says whether that client
 * can hand off now (it also needs its initiate_login_uri, SSO_TGE_ENABLED on and
 * SSO_SESSION_SECRET set); a client that cannot yet is reported, not refused.
 *
 * Usage (inside the api container, where DATABASE_URL and the SSO_* settings are loaded):
 *   node scripts/setCampaignSsoClient.js --slug <slug>                          show only
 *   node scripts/setCampaignSsoClient.js --slug <slug> --client-id <id> [--apply]
 *   node scripts/setCampaignSsoClient.js --slug <slug> --clear [--apply]
 *
 * Exit codes: 0 shown / dry run / written / already set · 1 refused (unknown card, a card that cannot
 * carry a client, an id that is not accepted; nothing written) · 2 usage · 3 unexpected error.
 *
 * Output: the card's slug, template, status and CTA, and client ids. Never a secret hash or an e-mail.
 */
const { readPartnerConfig, samePartnerClientId, isRetiredPartnerClientId } = require('../src/constants/partnerClient');
const { campaignSsoClientIds, ssoClientIdProblem } = require('../src/utils/campaignRules');
const { listFirstPartyClientIds } = require('../src/services/ssoDeveloperClient');
const { handoffState } = require('./setPartnerInitiateLoginUri');

const EXIT = { OK: 0, REFUSED: 1, USAGE: 2, ERROR: 3 };
const USAGE = 'usage: node scripts/setCampaignSsoClient.js --slug <slug> [--client-id <id> | --clear] [--apply]';
const ACTOR = 'ops-script';
const SSO_TEMPLATES = ['HOME_CARD', 'DIRECTORY_ITEM'];

class UsageError extends Error {}
class Refusal extends Error {}

function parseArgs(argv) {
  const opts = { slug: '', clientId: null, clear: false, apply: false };
  const args = [...argv];
  const valueOf = (name, arg) => {
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    const next = args.shift();
    if (next === undefined || next.startsWith('--')) throw new UsageError(`${name} needs a value`);
    return next;
  };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--slug' || arg.startsWith('--slug=')) opts.slug = valueOf('--slug', arg).trim();
    else if (arg === '--client-id' || arg.startsWith('--client-id=')) opts.clientId = valueOf('--client-id', arg).trim();
    else if (arg === '--clear') opts.clear = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--help' || arg === '-h') throw new UsageError('');
    else throw new UsageError(`unknown argument "${arg}"`);
  }
  if (!opts.slug) throw new UsageError('--slug is required');
  if (opts.clientId !== null && opts.clear) throw new UsageError('--client-id and --clear cannot be combined');
  if (opts.clientId === '') throw new UsageError('--client-id needs a value (use --clear to remove the client)');
  if (opts.apply && opts.clientId === null && !opts.clear) throw new UsageError('--apply needs --client-id or --clear');
  return opts;
}

function storedId(config) {
  const value = config && typeof config === 'object' ? config.ssoClientId : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** What /api/sso/app-ticket will answer for `clientId` now, under the settings `env`. */
async function clientHandoffState(prisma, clientId, env) {
  if (clientId === null) return 'none (the card opens the plain link)';
  const cfg = readPartnerConfig(env);
  if (cfg.clientId && !isRetiredPartnerClientId(cfg.clientId) && samePartnerClientId(cfg.clientId, clientId)) {
    if (!cfg.enabled) return 'refused (CLIENT_DISABLED): SSO_TGE_ENABLED is off';
    if (!String(env.SSO_SESSION_SECRET || '').trim()) return 'refused (CLIENT_DISABLED): SSO_SESSION_SECRET is not set';
    if (!cfg.initiateLoginUri) return 'refused (CLIENT_DISABLED): SSO_TGE_INITIATE_LOGIN_URI is not set';
    return 'available';
  }
  const row = await prisma.ssoDeveloperClient.findUnique({ where: { clientId } });
  if (!row) return 'refused: no such client';
  return handoffState(row, row.initiateLoginUri, env);
}

/**
 * Runs one invocation. `prisma` is the client to use; `env` the settings the accepted ids and the
 * hand-off state are read from; `out` receives each output line. Resolves to an exit code and never
 * throws.
 */
async function run(argv, { prisma, env = process.env, out = (line) => console.log(line) } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    if (error.message) out(`error: ${error.message}`);
    out(USAGE);
    return EXIT.USAGE;
  }
  try {
    const row = await prisma.campaign.findUnique({ where: { slug: opts.slug } });
    if (!row) throw new Refusal(`no campaign with slug "${opts.slug}"`);
    const before = storedId(row.config);

    out(`slug:        ${row.slug}`);
    out(`template:    ${row.template}`);
    out(`status:      ${row.status}`);
    out(`cta:         ${row.ctaKind} ${row.ctaValue}`);
    out(`before:      ${before ?? '(none)'}`);
    if (opts.clientId === null && !opts.clear) {
      out(`app hand-off: ${await clientHandoffState(prisma, before, env)}`);
      return EXIT.OK;
    }

    let next = null;
    if (opts.clientId !== null) {
      if (!SSO_TEMPLATES.includes(row.template) || row.ctaKind !== 'EXTERNAL') {
        throw new Refusal(
          `"${row.slug}" is a ${row.template} card with a ${row.ctaKind} link: only an EXTERNAL home card or directory item hands off`,
        );
      }
      const problem = ssoClientIdProblem(opts.clientId, campaignSsoClientIds(await listFirstPartyClientIds(prisma), env));
      if (problem) throw new Refusal(problem);
      next = opts.clientId;
    }

    out(`after:       ${next ?? '(none)'}`);
    out(`app hand-off: ${await clientHandoffState(prisma, before, env)} -> ${await clientHandoffState(prisma, next, env)}`);
    if (before === next) {
      out('unchanged: nothing to write');
      return EXIT.OK;
    }
    if (!opts.apply) {
      out('dry run: nothing written. Re-run with --apply to write.');
      return EXIT.OK;
    }
    // updatedAt is part of the write, so a card saved in between is not overwritten.
    const config = { ...(row.config && typeof row.config === 'object' ? row.config : {}), ssoClientId: next };
    const { count } = await prisma.campaign.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt },
      data: { config, updatedBy: ACTOR },
    });
    if (count !== 1) throw new Refusal('the card changed while this ran; nothing written');
    await prisma.campaignEvent.create({
      data: {
        campaignId: row.id,
        actor: ACTOR,
        action: 'set-sso-client',
        fromStatus: row.status,
        toStatus: row.status,
        note: `ssoClientId ${before ?? '(none)'} -> ${next ?? '(none)'}`,
      },
    });
    const stored = await prisma.campaign.findUnique({ where: { id: row.id } });
    out(`written:     ${storedId(stored ? stored.config : null) ?? '(none)'}`);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof Refusal) {
      out(`refused: ${error.message}`);
      return EXIT.REFUSED;
    }
    out(`error: ${error && error.message ? error.message : String(error)}`);
    return EXIT.ERROR;
  }
}

if (require.main === module) {
  const prisma = require('../src/utils/prisma');
  run(process.argv.slice(2), { prisma })
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`error: ${error && error.message ? error.message : String(error)}`);
      process.exitCode = EXIT.ERROR;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { run, parseArgs, EXIT };
