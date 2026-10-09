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

# --- the console ------------------------------------------------------------
FROM node:20-slim AS web
WORKDIR /web
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
# The console, where config.webDistDir looks for it by default.
COPY --from=web /web/dist ./web
EXPOSE 8080
CMD ["node", "dist/index.js"]
