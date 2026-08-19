FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ imagemagick librsvg2-bin zip \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
COPY extension ./extension
COPY scripts/package-extension.sh ./scripts/package-extension.sh

RUN npm run build:local \
  && EXTENSION_OUTPUT_PATH=/app/release/aliashub-outlook-extension.zip \
    bash scripts/package-extension.sh "" "http://127.0.0.1:4180" \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium chromium-sandbox \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=4180 \
  DATA_DIR=/app/data \
  DATABASE_PATH=/app/data/outlook-alias-hub.db \
  MAILCOM_BROWSER_EXECUTABLE=/usr/bin/chromium

WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/release ./release
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server ./server

RUN mkdir -p /app/data/attachments && chown -R node:node /app
USER node

EXPOSE 4180
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4180/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server/index.js"]
