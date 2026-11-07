FROM myoung34/github-runner:latest

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
  && mkdir -p /opt/ms-playwright \
  && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright bunx playwright@1.64.1 install-deps chromium \
  && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright bunx playwright@1.64.1 install chromium \
  && chmod -R a+rX /opt/ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
