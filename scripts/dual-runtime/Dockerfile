FROM --platform=linux/arm64 node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

USER root
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY . /repo/
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate \
  && pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm --filter @reflection/server build \
  && pnpm --filter opencode-reflection-plugin build \
  && pnpm --filter @reflection/opencode-v2-plugin build \
  && pnpm verify:plugin-bundle \
  && pnpm verify:v2-plugin-bundle
RUN pnpm exec esbuild scripts/dual-runtime/oracle.mjs --bundle --platform=node --format=esm --outfile=/repo/oracle.mjs

# v1's Npm.checkDirty reads package-lock.json, not pnpm-lock.yaml. Generate a
# genuine compatibility lock so its Arborist does not reify on the offline network.
RUN install -d /warm-v1/.config/opencode \
  && cd /warm-v1/.config/opencode \
  && pnpm --config.node-linker=hoisted add --ignore-scripts --save-exact @opencode-ai/plugin@1.18.29 \
  && npm install --package-lock-only --ignore-scripts

RUN curl --fail --silent --show-error --location \
      https://registry.npmjs.org/opencode-linux-arm64/-/opencode-linux-arm64-1.18.29.tgz \
      --output /tmp/opencode-v1.tgz \
  && node -e 'const c=require("node:crypto"),f=require("node:fs"); const expected="sha512-Lr7XXik5wPJZBV5RW+aR6Uogf1n5GogpB565m+D/jiO/vRXr9LhvCpixgAr1tiwuH1ZfMsqOOlbFQz5jgH3Tqg=="; const actual="sha512-"+c.createHash("sha512").update(f.readFileSync("/tmp/opencode-v1.tgz")).digest("base64"); if (actual !== expected) throw new Error("v1 tarball integrity mismatch")' \
  && install -d /opt/opencode-v1 \
  && tar -xzf /tmp/opencode-v1.tgz -C /opt/opencode-v1 --strip-components=1 \
  && test -x /opt/opencode-v1/bin/opencode \
  && rm /tmp/opencode-v1.tgz

RUN curl --fail --silent --show-error --location \
      https://registry.npmjs.org/@opencode/cli-linux-arm64/-/cli-linux-arm64-2.0.8.tgz \
      --output /tmp/opencode-v2.tgz \
  && node -e 'const c=require("node:crypto"),f=require("node:fs"); const expected=Buffer.from("i1afIoAe79WLkaFSG2HwxVmXXxT2zbgC4IqP0srd+HD3cXS9veAgoEKnPFKW4Eb8eIrqQ+vJPh4D/PufOZ3CJw==","base64"); const actual=c.createHash("sha512").update(f.readFileSync("/tmp/opencode-v2.tgz")).digest(); if(actual.length!==expected.length||!c.timingSafeEqual(actual,expected)) throw new Error("v2 tarball integrity mismatch")' \
  && install -d /opt/opencode-v2 \
  && tar -xzf /tmp/opencode-v2.tgz -C /opt/opencode-v2 --strip-components=1 \
  && test -x /opt/opencode-v2/bin/opencode \
  && rm /tmp/opencode-v2.tgz

RUN install -d /bundles /harness \
  && cp /repo/plugin/dist/reflection.js /bundles/reflection.js \
  && cp /repo/packages/opencode-v2-plugin/dist/reflection-v2.js /bundles/reflection-v2.js \
  && cp /repo/scripts/dual-runtime/scenario.mjs /harness/scenario.mjs \
  && cp /repo/scripts/dual-runtime/fixture-env.mjs /harness/fixture-env.mjs \
  && cp /repo/oracle.mjs /harness/oracle.mjs \
  && chown -R node:node /warm-v1 /bundles /harness

USER node
CMD ["node", "/harness/scenario.mjs"]
