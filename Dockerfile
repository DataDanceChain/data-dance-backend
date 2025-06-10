FROM --platform=linux/amd64 node:lts-bookworm-slim AS base

# 1. Install dependencies only when needed
FROM base AS deps

RUN apt-get update && apt-get install -y build-essential python3 libssl-dev ca-certificates
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

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

# Fix Sharp module for the correct platform
RUN npm uninstall sharp && npm install --platform=linux --arch=x64 sharp

ENV NODE_ENV=production
ENV PORT 3000
ENV HOSTNAME 0.0.0.0

CMD ["npm", "run", "dev"]