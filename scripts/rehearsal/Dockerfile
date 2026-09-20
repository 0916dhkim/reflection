FROM node:24-bookworm

USER root

# The Bookworm archive ships PostgreSQL 15 clients. Install the matching PG17
# clients from PGDG so pg_dump and pg_restore can operate on the fixture PG17
# server used by the rehearsal.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl gnupg \
    && install -d --mode=0755 /usr/share/keyrings \
    && curl --fail --silent --show-error --location \
        https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        --output /usr/share/keyrings/postgresql.asc \
    && printf '%s\n' \
        'deb [signed-by=/usr/share/keyrings/postgresql.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install --yes --no-install-recommends postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*

RUN corepack disable && npm install --global pnpm@10.33.0

COPY old /versions/old
COPY new /versions/new

# Each archived revision resolves its own workspace dependencies. In particular,
# neither install may use the other revision's workspace links or node_modules.
RUN cd /versions/old && pnpm install --frozen-lockfile --ignore-scripts \
    && cd /versions/new && pnpm install --frozen-lockfile --ignore-scripts

COPY harness /harness
COPY provenance.json /harness/provenance.json

RUN cd /versions/old \
    && pnpm exec esbuild /harness/backend.mjs \
        --bundle \
        --platform=node \
        --format=esm \
        --target=node24 \
        --external:fastify \
        --external:@fastify/swagger \
        --external:@fastify/swagger-ui \
        --external:pg \
        --alias:@fixture/server=/versions/old/server/src \
        --alias:@fixture/shared=/versions/old/packages/shared/src \
        --outfile=/versions/old/server/rehearsal.mjs \
        --metafile=/versions/old/backend-meta.json \
    && pnpm --filter opencode-reflection-plugin build

RUN cd /versions/new \
    && pnpm exec esbuild /harness/backend.mjs \
        --bundle \
        --platform=node \
        --format=esm \
        --target=node24 \
        --external:fastify \
        --external:@fastify/swagger \
        --external:@fastify/swagger-ui \
        --external:pg \
        --alias:@fixture/server=/versions/new/server/src \
        --alias:@fixture/shared=/versions/new/packages/shared/src \
        --outfile=/versions/new/server/rehearsal.mjs \
        --metafile=/versions/new/backend-meta.json \
    && pnpm --filter opencode-reflection-plugin build

# Resolve relative metafile paths before checking cross-revision isolation, and
# record exact hashes of the artifacts that the scenario will execute.
RUN node /harness/build-provenance.mjs

ENV PATH="/usr/lib/postgresql/17/bin:${PATH}"

USER node
