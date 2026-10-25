# The pool runner image (spec §3 Job containers): GitHub's actions-runner at a pinned version, plus build tools,
# xvfb, and the system libraries Electron and Chromium need. Built on the bake's builder; one container per job.
# The runner self-updates when GitHub requires a newer version; bump the pin here to keep that off the boot path.
FROM ghcr.io/actions/actions-runner:2.338.0@sha256:4ffadc0002b2581327e06101fc8c06cd189232baf79fe561fac9caeb76f5e807

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential python3 pkg-config ca-certificates curl wget jq unzip zip xz-utils rsync file \
      xvfb xauth \
      libgtk-3-0t64 libnss3 libnspr4 libasound2t64 libgbm1 libdrm2 libxss1 libxtst6 libxshmfence1 libxkbcommon0 \
      libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libcups2t64 libdbus-1-3 libpango-1.0-0 libcairo2 \
      libx11-xcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxcb-dri3-0 libsecret-1-0 libnotify4 \
      libglib2.0-0t64 libgl1 libegl1 xdg-utils fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/ci-kit-entrypoint
COPY job-started.sh /usr/local/bin/ci-kit-job-started.sh
RUN chmod 0755 /usr/local/bin/ci-kit-entrypoint /usr/local/bin/ci-kit-job-started.sh
USER runner
ENTRYPOINT ["/usr/local/bin/ci-kit-entrypoint"]
