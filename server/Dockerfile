# Build from the repo root:  docker compose -f server/docker-compose.yml build
# Google's mirror of Docker Hub: Hub often rate-limits shared cloud IPs
FROM mirror.gcr.io/library/node:22-alpine

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# the Safari engine (rammerhead.cjs) is not started in Docker: see docs/06-backend.md
COPY server/*.mjs server/rammerhead.cjs ./
COPY site /app/site

RUN mkdir /cache /data && chown node:node /cache /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 SITE_DIR=/app/site CACHE_DIR=/cache STATS_DIR=/data
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
