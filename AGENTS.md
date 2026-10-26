# Data Dance Backend agent entry

Read README.md, then the affected API/SSO contract under docs/. This repository
owns the Express API, PostgreSQL/Prisma schema and authorization enforcement.
Use Node 22 and the packageManager-declared Yarn 1.22.22 with
`yarn install --frozen-lockfile`; do not regenerate either lockfile during setup.
Use the actual `yarn test` and `yarn build` scripts for relevant verification.
Database tests (`yarn test:db`) need a separately configured isolated test DB.

Cloud receives only committed repository files, not the Mac's .env, Docker
containers, credentials or database. Use env.example for configuration names;
supply approved test-only values through Cloud configuration, never chat/Git.
Do not run Prisma migrations, seed users, real SSO/login flows or production
queries merely to prepare an environment. Preserve PKCE, audience/scope,
revocation, cookie and identity boundaries from the owning contracts.
Record the exact revision, checks and missing dependencies; a unit result is
not App-to-Planet acceptance or deployment. Preserve other agents' work.
Artifacts/handoffs are English; summarize to Sloan in Chinese. Push/deployment
and changes to production secrets require the owner's explicit authorization.
