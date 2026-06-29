FROM node:20-bookworm-slim AS base

# Build arguments for engine configuration
ARG ENABLE_PUPPETEER=true
# Access build-time architecture and puppeteer toggle
ARG TARGETARCH

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_OPTIONS="--max_old_space_size=30000 --max-http-header-size=80000"
ENV NODE_ENV=production

LABEL org.opencontainers.image.source=https://github.com/any4ai/AnyCrawl
LABEL org.opencontainers.image.description="AnyCrawl All-in-One Server"
LABEL org.opencontainers.image.licenses=MIT

# Install system dependencies
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    procps \
    redis-server \
    supervisor \
    bash \
    build-essential python3 make g++ \
    && corepack enable \
    && npx playwright install-deps \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /usr/src/app

# Copy package files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/libs/package.json ./packages/libs/
COPY packages/scrape/package.json ./packages/scrape/
COPY packages/search/package.json ./packages/search/
COPY packages/ai/package.json ./packages/ai/
COPY packages/db/package.json ./packages/db/
COPY packages/template-client/package.json ./packages/template-client/
COPY packages/eslint-config/package.json ./packages/eslint-config/
COPY packages/typescript-config/package.json ./packages/typescript-config/

# Install dependencies (include devDependencies for build toolchain)
RUN --mount=type=cache,id=pnpm-glibc,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts --prod=false

# Copy typescript config files (needed for build)
COPY packages/typescript-config/ ./packages/typescript-config/
COPY packages/eslint-config/ ./packages/eslint-config/

# Copy source code and build dependencies first
COPY . .
# Build base libraries, template-client, then scrape
# - libs/db provide shared types
# - template-client must be built before scrape because scrape depends on it
RUN pnpm build --filter=@anycrawl/libs --filter=@anycrawl/db --filter=@anycrawl/template-client --filter=@anycrawl/scrape
# Build remaining packages (search, ai depend on scrape)
RUN pnpm build --filter=@anycrawl/search --filter=@anycrawl/ai
# Build API
RUN pnpm build --filter=api

# Remove dev dependencies
RUN rm -rf node_modules

# Migration stage - keep dev dependencies for running drizzle-kit
FROM base AS migration
WORKDIR /usr/src/app

# Copy built files and dependencies from build stage
COPY --from=build /usr/src/app/pnpm-lock.yaml ./
COPY --from=build /usr/src/app/pnpm-workspace.yaml ./
COPY --from=build /usr/src/app/package.json ./
COPY --from=build /usr/src/app/packages ./packages

# Install all dependencies including devDependencies for drizzle-kit
RUN --mount=type=cache,id=pnpm-glibc,target=/pnpm/store pnpm install --frozen-lockfile --filter=@anycrawl/db --prod=false

FROM base AS runtime
WORKDIR /usr/src/app

# Set default environment variables
ENV ANYCRAWL_API_DB_TYPE=sqlite
ENV ANYCRAWL_API_DB_CONNECTION=/usr/src/app/storage/anycrawl.db
ENV ANYCRAWL_API_PORT=8080
ENV ANYCRAWL_API_AUTH_ENABLED=false
ENV REDIS_URL=redis://localhost:6379
ENV CLOAKBROWSER_CACHE_DIR=/usr/src/app/.cache/cloakbrowser
ENV CLOAKBROWSER_AUTO_UPDATE=false

# Create engine configuration script (disable puppeteer on non-amd64)
RUN if [ "$ENABLE_PUPPETEER" = "true" ] && [ "$TARGETARCH" = "amd64" ]; then \
        echo "export ANYCRAWL_AVAILABLE_ENGINES=playwright,cheerio,puppeteer" > /usr/src/app/set-engines.sh; \
    else \
        echo "export ANYCRAWL_AVAILABLE_ENGINES=playwright,cheerio" > /usr/src/app/set-engines.sh; \
    fi && \
    chmod +x /usr/src/app/set-engines.sh

# Copy built files and necessary package files
COPY --from=build /usr/src/app/pnpm-lock.yaml ./
COPY --from=build /usr/src/app/pnpm-workspace.yaml ./
COPY --from=build /usr/src/app/package.json ./

# Copy all package.json files for workspace resolution
COPY --from=build /usr/src/app/packages/eslint-config/package.json ./packages/eslint-config/
COPY --from=build /usr/src/app/packages/typescript-config/package.json ./packages/typescript-config/
COPY --from=build /usr/src/app/packages/search/package.json ./packages/search/
COPY --from=build /usr/src/app/packages/ai/package.json ./packages/ai/
COPY --from=build /usr/src/app/packages/db/package.json ./packages/db/

# Copy built packages
COPY --from=build /usr/src/app/packages/libs/dist ./packages/libs/dist
COPY --from=build /usr/src/app/packages/libs/package.json ./packages/libs/
COPY --from=build /usr/src/app/packages/template-client/dist ./packages/template-client/dist
COPY --from=build /usr/src/app/packages/template-client/package.json ./packages/template-client/
COPY --from=build /usr/src/app/packages/scrape/dist ./packages/scrape/dist
COPY --from=build /usr/src/app/packages/scrape/package.json ./packages/scrape/
COPY --from=build /usr/src/app/packages/search/dist ./packages/search/dist
COPY --from=build /usr/src/app/packages/search/package.json ./packages/search/
COPY --from=build /usr/src/app/packages/ai/dist ./packages/ai/dist
COPY --from=build /usr/src/app/packages/ai/package.json ./packages/ai/
COPY --from=build /usr/src/app/packages/db/dist ./packages/db/dist
COPY --from=build /usr/src/app/packages/db/package.json ./packages/db/

# Copy migration files from migration stage
COPY --from=migration /usr/src/app/packages/db/drizzle ./packages/db/drizzle
COPY --from=migration /usr/src/app/packages/db/drizzle.config.ts ./packages/db/

# Copy API app
COPY --from=build /usr/src/app/apps/api/dist ./apps/api/dist
COPY --from=build /usr/src/app/apps/api/package.json ./apps/api/
COPY --from=build /usr/src/app/apps/api/scripts/run-generate-api-key.mjs ./apps/api/scripts/

# Install production dependencies
RUN --mount=type=cache,id=pnpm-glibc,target=/pnpm/store pnpm install --prod --frozen-lockfile
# Ensure native modules rebuilt for current platform (in case scripts were skipped earlier due to cache)
RUN pnpm rebuild better-sqlite3
RUN cd /usr/src/app/packages/scrape && npx cloakbrowser install

# Bring in dev tooling (drizzle-kit) from migration stage so we can run migrations without npx
COPY --from=migration /usr/src/app/node_modules ./node_modules
COPY --from=migration /usr/src/app/packages/db/node_modules ./packages/db/node_modules

# Install browser binaries for playwright (always)
RUN cd /usr/src/app/packages/scrape && npx playwright install chromium

# Install puppeteer browser only if enabled and running on amd64
RUN if [ "$ENABLE_PUPPETEER" = "true" ] && [ "$TARGETARCH" = "amd64" ]; then \
        cd /usr/src/app/packages/scrape && npx puppeteer browsers install chrome; \
    else \
        echo "Skipping Puppeteer browser installation"; \
    fi

    # Create supervisor configuration directory
RUN mkdir -p /etc/supervisor/conf.d /var/log/supervisor

# Copy supervisor configuration
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Copy and setup API startup script
COPY docker/start-api.sh /usr/src/app/start-api.sh
RUN chmod +x /usr/src/app/start-api.sh && \
mkdir -p /usr/src/app/storage

# Set working directory
WORKDIR /usr/src/app

# Expose ports
EXPOSE 8080

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=30s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start supervisord
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
