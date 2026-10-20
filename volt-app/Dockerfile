# Volt control plane + console, one image.
# ============================================================================
# THE BUILD CONTEXT IS THE REPOSITORY ROOT, not volt-app, because this image
# needs both projects: the API and the console it serves.
#
#     docker build -f volt-app/Dockerfile .
#
# run from the directory holding volt-app and volt-web. Compose is configured
# that way already.
#
# WHY ONE IMAGE. The console is a static bundle and could be a second container
# behind a proxy, but then every deployment needs that proxy configured, CORS
# opened between two origins, and the two kept in step. Serving it from the
# control plane makes it same-origin, takes CORS out of the picture, and makes
# `docker compose up` produce something you can actually log into. It is also
# what volt-web's router has always documented as the production arrangement.

# --- the player SDK -----------------------------------------------------------
# Built first: the API serves its bundle (/player/volt-player.js) and the
# console imports its source (@volt/player -> ../volt-player/src/sdk), so the
# console stage needs it beside it with its node_modules (Shaka).
FROM node:20-slim AS player
WORKDIR /w/volt-player
COPY volt-player/package.json volt-player/package-lock.json* ./
RUN npm install
COPY volt-player/ ./
RUN npm run build

# --- the console ------------------------------------------------------------
FROM node:20-slim AS web
COPY --from=player /w/volt-player /w/volt-player
WORKDIR /w/volt-web
COPY volt-web/package.json volt-web/package-lock.json* ./
RUN npm install
COPY volt-web/ ./
# `npm run build` is `tsc -b && vite build`, so a type error fails the IMAGE
# BUILD rather than shipping a bundle nobody typechecked.
RUN npm run build

# --- the control plane ------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app
COPY volt-app/package.json ./
RUN npm install
COPY volt-app/tsconfig.json ./
COPY volt-app/src ./src
RUN npm run build

# --- runtime ----------------------------------------------------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY volt-app/package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY volt-app/migrations ./migrations
COPY volt-app/scripts ./scripts
COPY volt-app/public ./public
# Volt default graphics templates, seeded into the library at boot (services/graphics/defaults.ts)
COPY volt-app/assets ./assets
# The console, where config.webDistDir looks for it by default.
COPY --from=web /w/volt-web/dist ./web
# the embed bundle, found by config.player.bundleDir at <cwd>/player
COPY --from=player /w/volt-player/dist ./player
EXPOSE 8080
CMD ["node", "dist/index.js"]
