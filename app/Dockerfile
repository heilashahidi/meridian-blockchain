# Meridian web app (Next.js) — Railway service.
# Build context = this directory (app/). Set the Railway service Root Directory
# to "app". NEXT_PUBLIC_* are inlined at BUILD time, so they must be present as
# build args (Railway exposes service variables to the Docker build).

# ── deps ────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ── build ───────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* must be set at build time (inlined into the client bundle).
ARG NEXT_PUBLIC_RPC_URL
ARG NEXT_PUBLIC_PROGRAM_ID
ARG NEXT_PUBLIC_USDC_MINT
ARG NEXT_PUBLIC_DEMO_WALLET
ARG NEXT_PUBLIC_HERMES_URL
ENV NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL \
    NEXT_PUBLIC_PROGRAM_ID=$NEXT_PUBLIC_PROGRAM_ID \
    NEXT_PUBLIC_USDC_MINT=$NEXT_PUBLIC_USDC_MINT \
    NEXT_PUBLIC_DEMO_WALLET=$NEXT_PUBLIC_DEMO_WALLET \
    NEXT_PUBLIC_HERMES_URL=$NEXT_PUBLIC_HERMES_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── run ─────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# `output: "standalone"` produces a minimal server in .next/standalone.
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
EXPOSE 3000
# ANTHROPIC_API_KEY / ANTHROPIC_MODEL are read server-side at request time, so
# they are RUNTIME env (set them on the Railway service, not as build args).
CMD ["node", "server.js"]
