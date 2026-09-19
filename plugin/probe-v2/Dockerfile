FROM node:24-bookworm

ADD https://registry.npmjs.org/@opencode/cli-linux-arm64/-/cli-linux-arm64-2.0.8.tgz /tmp/opencode.tgz
RUN node -e 'const crypto=require("node:crypto");const fs=require("node:fs");const expected=Buffer.from("i1afIoAe79WLkaFSG2HwxVmXXxT2zbgC4IqP0srd+HD3cXS9veAgoEKnPFKW4Eb8eIrqQ+vJPh4D/PufOZ3CJw==","base64");const actual=crypto.createHash("sha512").update(fs.readFileSync("/tmp/opencode.tgz")).digest();if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected)){throw new Error("opencode tarball SHA512 mismatch")} ' \
  && mkdir -p /opt/opencode \
  && tar -xzf /tmp/opencode.tgz -C /opt/opencode --strip-components=1 \
  && test -x /opt/opencode/bin/opencode \
  && rm /tmp/opencode.tgz

COPY workspace/ /workspace/
COPY harness.mjs /harness/harness.mjs
RUN chown -R node:node /workspace /harness

WORKDIR /workspace
USER node
CMD ["node", "/harness/harness.mjs"]
