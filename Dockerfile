FROM node:24.18.0-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY plugin/package.json plugin/package.json
COPY scripts/package.json scripts/package.json
COPY server/package.json server/package.json
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY server server
RUN pnpm --filter @reflection/server build
RUN pnpm --filter @reflection/server deploy --prod --legacy /deploy

FROM node:24.18.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/migrations

WORKDIR /app
COPY --from=build --chown=node:node /deploy ./
COPY --chown=node:node migrations ./migrations

USER node
EXPOSE 8000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=10 \
    CMD node -e "fetch('http://127.0.0.1:8000/healthz').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"

CMD ["node", "dist/main.js"]
