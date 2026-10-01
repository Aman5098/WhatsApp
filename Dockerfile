# whatsapp-gateway — one headless Chromium per connected tenant.
# Uses Debian's chromium package rather than Puppeteer's downloaded build, so
# the browser is installed system-wide (visible to the non-root user) and
# matches the OS libraries it links against.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    WWEBJS_AUTH_PATH=/data/.wwebjs_auth \
    TENANT_OWNERSHIP_FILE=/data/tenant-ownership.json

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN groupadd --gid 1001 nodejs \
  && useradd --uid 1001 --gid nodejs --shell /bin/false --create-home appuser \
  && mkdir -p /data && chown -R appuser:nodejs /data /app
USER appuser

# /data holds sessions + tenant ownership — mount a volume there.
# projects.json (per-project API keys) is mounted at /app/projects.json.
VOLUME ["/data"]
EXPOSE 4100
CMD ["node", "src/server.js"]
