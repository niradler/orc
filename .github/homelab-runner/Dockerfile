# Future runner image only; compose deliberately blocks registration/network access.
FROM ghcr.io/actions/actions-runner@sha256:759a1d94a15b05941aba5196974ff43fe15b4cbba29b694b35cbc32a1166b232

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash -s "bun-v1.4.4" \
  && ln -sf /opt/bun/bin/bun /usr/local/bin/bun \
  && mkdir -p /opt/ms-playwright \
  && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright bunx playwright@1.64.1 install-deps chromium \
  && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright bunx playwright@1.64.1 install chromium \
  && chmod -R a+rX /opt/ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
USER runner
