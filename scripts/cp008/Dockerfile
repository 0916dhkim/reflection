FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS deps

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/opencode-v2-core/package.json packages/opencode-v2-core/package.json
COPY packages/opencode-v2-plugin/package.json packages/opencode-v2-plugin/package.json
COPY plugin/package.json plugin/package.json
COPY scripts/package.json scripts/package.json
COPY server/package.json server/package.json
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate && pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY server server
RUN pnpm --filter @reflection/server deploy --prod --legacy /deploy

FROM pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f

WORKDIR /app
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
COPY --from=deps --chown=postgres:postgres /deploy ./
COPY --chown=postgres:postgres scripts/cp008/backup.mjs ./backup.mjs
RUN install -d -o postgres -g postgres -m 0700 /backup /reports

USER postgres
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/backup.mjs"]
