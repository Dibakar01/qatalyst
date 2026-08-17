# syntax=docker/dockerfile:1
#
# One image, two ways to run it:
#   - the app:    npm start        (this file's default CMD)
#   - the worker: npm run send     (docker-compose.yml's `worker` service overrides CMD)
# Same build, same node_modules, no second Dockerfile and no bundler output
# mode change — scripts/send.ts runs as TypeScript source via Node's built-in
# type stripping, exactly as it does outside Docker, so the runner stage keeps
# the real lib/db/scripts tree alongside the compiled .next output.
#
# No credential is ever baked in here. Everything sending needs — DATABASE_URL,
# UNSUBSCRIBE_SECRET, GOOGLE_SERVICE_ACCOUNT_JSON, SEND_TZ, and so on — comes
# from the environment at run time (see docs/runbook.md), never from this build.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# db/index.ts throws at import time if DATABASE_URL is unset, and Next's build
# walks every route (including ones that never touch a database) to collect
# its config. This placeholder satisfies that check only — nothing queries a
# database during build, and this ENV does not carry into the runner stage
# below (each FROM starts a fresh environment). The real value is supplied to
# the running container, not to the image.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/db ./db
COPY --from=builder /app/scripts ./scripts

EXPOSE 3000
CMD ["npm", "start"]
