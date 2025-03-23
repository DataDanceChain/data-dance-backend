FROM --platform=linux/amd64 node:20-bookworm-slim AS base

# 1. Install dependencies only when needed
FROM base AS deps

RUN apt-get update && apt-get install -y build-essential python3
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./
RUN \
    if [ -f yarn.lock ]; then yarn --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    elif [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm i; \
    else echo "Lockfile not found." && exit 1; \
    fi

COPY . .
RUN npx prisma generate

FROM base AS runner
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app .
ENV NODE_ENV=production

ENV PORT 3000
ENV HOSTNAME 0.0.0.0

CMD ["node", "src/server.js"]