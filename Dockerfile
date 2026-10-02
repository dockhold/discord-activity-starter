# Discord Activity starter: one image that serves the game page, the Discord
# sign-in and the game's WebSocket on $PORT.
#
# Stage 1 builds the page with Vite. Nothing Discord-specific goes into it:
# the page asks the server for the client ID when it loads, so the same image
# works for any Discord application. Both installs skip package install
# scripts (--ignore-scripts): no dependency here needs one.
FROM node:22-alpine AS client
WORKDIR /build/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY client/ ./
RUN npm run build

# Stage 2 runs the server: Node and the one dependency (ws), no build tools.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY server/src ./src
COPY --from=client /build/client/dist /app/client/dist
# Everything above is owned by root and read-only to the app. The server
# writes nothing to disk.
USER 1001:1001
EXPOSE 8080
# Node is the main process and handles SIGTERM itself (src/index.js).
CMD ["node", "src/index.js"]
