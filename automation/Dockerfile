# Meridian automation worker — Railway service (no public port).
# Runs the scheduler daemon: create-strikes ~08:00 ET, settle ~16:05 ET.
# Build context = this directory (automation/). Set the Railway service Root
# Directory to "automation".

# ── build (compile TS → dist, then drop devDeps) ────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ── run ─────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
# Entrypoint materializes the admin keypair from ADMIN_KEYPAIR_JSON, then runs
# the scheduler daemon.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js", "schedule"]
