# The provider-neutral preparation shared by the GCE and EC2 builders: Node 22 and 24 in the runner's tool cache
# (22 also on the host), the kit's dependencies, the pool runner image, and the warmed caches.
# Sourced, not run: the builder has installed docker.io, git, jq, curl and xz-utils, checked the kit out at
# /opt/ci-kit, and set CACHE. `step` is set as each part starts, for the builder's failure report. The builder also
# defines warm_token for the multi-cloud bake's credential-free repository clones. A declaration's install warms
# shared caches best effort; its package/script apply is required to succeed.

step=node
mkdir -p "$CACHE/toolcache/node"
# Both providers use the same resolved bake manifest.
for major in 22 24; do
  v=$(jq -er --arg m "$major" '.node[$m] | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))' "$CI_KIT_BAKE_MANIFEST")
  curl -sfL --max-time 300 "https://nodejs.org/dist/$v/node-$v-linux-x64.tar.xz" -o /tmp/node.tar.xz
  dir="$CACHE/toolcache/node/${v#v}/x64"
  mkdir -p "$dir"
  tar -xJf /tmp/node.tar.xz -C "$dir" --strip-components=1
  touch "$CACHE/toolcache/node/${v#v}/x64.complete"
  if [ "$major" = 22 ]; then
    rm -rf /opt/node && cp -a "$dir" /opt/node
    for b in node npm npx corepack; do ln -sf "/opt/node/bin/$b" "/usr/local/bin/$b"; done
  fi
done
rm -f /tmp/node.tar.xz

step=deps
(cd /opt/ci-kit && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

step=image
docker build --quiet -t ci-kit-runner:latest /opt/ci-kit/pool/image

step=caches
mkdir -p "$CACHE"/{npm,pnpm-store,corepack,ms-playwright,electron,work}
chown -R 1001:1001 "$CACHE"

step=job-images
CI_KIT_GH_TOKEN="$(warm_token)" node /opt/ci-kit/pool/bake/job-images.mjs
