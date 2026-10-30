# syntax=docker/dockerfile:1.7
# Every step of this project (install, dev server, tests, asset pipeline, build,
# publish) runs in a container. Nothing needs to be installed on the host.

ARG NODE_VERSION=24
ARG PLAYWRIGHT_VERSION=1.64.1

FROM node:${NODE_VERSION}-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
COPY docker/entrypoint.sh /usr/local/bin/entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint && chmod +x /usr/local/bin/entrypoint
ENTRYPOINT ["entrypoint"]

# Dependencies baked into the image (used by CI and as the seed for the dev volume).
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit \
 && sha1sum package-lock.json | cut -d' ' -f1 > node_modules/.lock-hash

# Interactive development: source is bind-mounted over /app.
FROM deps AS dev
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# Type-check, lint, unit tests, then production build.
FROM deps AS build
COPY . .
RUN npm run check && npm test && npm run build

# `docker build --target dist --output type=local,dest=dist .` exports the site.
FROM scratch AS dist
COPY --from=build /app/dist /

# Headless Chromium for visual smoke tests and media-kit screenshots.
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS browser
WORKDIR /app
COPY docker/entrypoint.sh /usr/local/bin/entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint && chmod +x /usr/local/bin/entrypoint
ENTRYPOINT ["entrypoint"]

# itch.io butler for publishing.
FROM debian:bookworm-slim AS butler
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && curl -fsSL -o /tmp/butler.zip https://broth.itch.zone/butler/linux-amd64/LATEST/archive/default \
 && unzip /tmp/butler.zip -d /opt/butler && chmod +x /opt/butler/butler \
 && ln -s /opt/butler/butler /usr/local/bin/butler && rm /tmp/butler.zip \
 && apt-get purge -y unzip && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["butler"]
