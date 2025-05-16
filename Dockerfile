FROM --platform=linux/amd64 node:lts-bookworm-slim AS base

# 1. Install dependencies only when needed
FROM base AS deps

RUN apt-get update && apt-get install -y build-essential python3 libssl-dev ca-certificates
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

RUN apt-get update && apt-get install -y build-essential python3 libssl-dev ca-certificates
WORKDIR /app

# Copy source first
COPY . .
# Then copy node_modules from deps stage to ensure we don't overwrite them
COPY --from=deps /app/node_modules ./node_modules
# Copy the generated Prisma client
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

ENV NODE_ENV=production
ENV PORT 3000
ENV HOSTNAME 0.0.0.0

CMD ["npm", "run", "dev"]