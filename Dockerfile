# Rescue Room defender (Fly.io): watcher, relayer, alerts, Telegram linking, demo/sandbox defenders and the
# attack simulator. No keys in the image: they arrive at runtime as the RR_KEYS Fly secret.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY watcher/package.json watcher/
COPY alerts/package.json alerts/
COPY attacker/package.json attacker/
COPY scripts/package.json scripts/
COPY server/package.json server/
RUN npm ci --omit=dev --workspaces --include-workspace-root --no-audit --no-fund && npm cache clean --force
COPY watcher/src watcher/src
COPY alerts/src alerts/src
COPY scripts/lib scripts/lib
COPY scripts/relayer.mjs scripts/
COPY server/src server/src
COPY fly/state.json fly/state.json
USER node
EXPOSE 8080
CMD ["node", "server/src/defender.js"]
