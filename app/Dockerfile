# Meridian web app (Next.js) — Railway service.
# Build context = this directory (app/). Set the Railway service Root Directory
# to "app". NEXT_PUBLIC_* are inlined at BUILD time, so they must be present as
# build args (Railway exposes service variables to the Docker build).

# ── deps ────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# --ignore-scripts: skip native postinstall builds (e.g. `usb`, a Ledger
# hardware-wallet transport pulled in transitively). node-gyp needs Python +
# build tools that aren't in the alpine image, and the web build/SSR server
# never use those native modules (browser-only wallet feature). Packages with
# native accelerators fall back to pure JS.
# `npm install`, not `npm ci`: `ws`'s optional native accelerators
# (bufferutil, utf-8-validate) are pruned from the lockfile when it's
# regenerated on macOS but demanded by npm on linux, so `npm ci`'s strict
# lock-vs-tree match fails the build cross-platform. `npm install` reconciles
# at build time; the accelerators are skipped (--ignore-scripts) and ws falls
# back to pure JS, exactly as intended above.
RUN npm install --ignore-scripts --no-audit --no-fund

# ── build ───────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* must be set at build time (inlined into the client bundle).
# The USDC mint is intentionally NOT here: the app reads it from the on-chain
# Config account (fetchConfig → c.usdcMint), the single source of truth, so a
# build-time value would only drift from on-chain. Don't re-add it.
ARG NEXT_PUBLIC_RPC_URL
ARG NEXT_PUBLIC_PROGRAM_ID
ARG NEXT_PUBLIC_DEMO_WALLET
ARG NEXT_PUBLIC_HERMES_URL
ENV NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL \
    NEXT_PUBLIC_PROGRAM_ID=$NEXT_PUBLIC_PROGRAM_ID \
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
