# syntax=docker/dockerfile:1
# trace — single image with the API, the web app and the widget bundle.

# --- build: the official Vite+ toolchain image -------------------------------
FROM ghcr.io/voidzero-dev/vite-plus:latest AS build
WORKDIR /app
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
COPY --chown=vp:vp apps/server/package.json apps/server/
COPY --chown=vp:vp apps/web/package.json apps/web/
COPY --chown=vp:vp packages/widget/package.json packages/widget/
RUN vp install --frozen-lockfile
COPY --chown=vp:vp . .
RUN vp run build
RUN cp "$(vp env which node | head -1)" /tmp/node

# --- deps: production dependencies only --------------------------------------
FROM ghcr.io/voidzero-dev/vite-plus:latest AS deps
WORKDIR /app
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
COPY --chown=vp:vp apps/server/package.json apps/server/
COPY --chown=vp:vp apps/web/package.json apps/web/
COPY --chown=vp:vp packages/widget/package.json packages/widget/
RUN vp install --frozen-lockfile --prod

# --- runtime -------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/.data
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libgomp1 && rm -rf /var/lib/apt/lists/*
COPY --from=build /tmp/node /usr/local/bin/node
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/apps/server/package.json ./apps/server/
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/widget/dist ./packages/widget/dist
RUN mkdir -p /app/.data && chown -R nobody /app/.data
USER nobody
EXPOSE 3000 2525
CMD ["node", "apps/server/dist/index.mjs"]
