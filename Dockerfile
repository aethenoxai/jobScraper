# Job Scraper in one container: the web UI and the background worker (PRD §55).
# Applying on websites runs with a hidden browser here; use the native install to watch it apply.

# 1. Install dependencies (with build tools for native modules) and build the web UI.
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_HOME=/corepack CI=true NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack install && pnpm install --frozen-lockfile
COPY . .
# node_modules moves aside so the runtime image can copy it on its own (before the code, without a second copy).
RUN pnpm build && mkdir /deps && mv node_modules /deps/

# 2. The runtime image: Node, pnpm (prepared now, so starting needs no internet), Chromium, then the app.
FROM node:24-bookworm-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_HOME=/corepack CI=true NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
# Chromium and its system libraries come first: this layer is reused when only the app's code changes.
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /deps/node_modules ./node_modules
COPY --from=build /corepack /corepack
RUN corepack enable \
  && pnpm exec playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && chmod -R a+rX /corepack /ms-playwright
# Scrapling (Python) reads job pages for web discovery and "Add by link", with its own Chromium build.
COPY --from=build /app/python/requirements.txt /tmp/scrapling-requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv \
  && python3 -m venv /opt/scrapling \
  && /opt/scrapling/bin/pip install --no-cache-dir -r /tmp/scrapling-requirements.txt \
  && /opt/scrapling/bin/python -m patchright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* /tmp/scrapling-requirements.txt \
  && chmod -R a+rX /opt/scrapling /ms-playwright
ENV SCRAPLING_PYTHON=/opt/scrapling/bin/python
COPY --from=build /app /app
RUN mkdir -p /app/data && chown -R node:node /app/data /app/.next

# Inside the container the server listens on all interfaces; docker-compose.yml publishes it on 127.0.0.1 only.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data \
    JOB_SCRAPER_IN_DOCKER=true JOB_SCRAPER_BROWSER_HEADLESS=true
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["pnpm", "start"]
