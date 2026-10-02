# Runs the server in HTTP mode, for use as a claude.ai custom connector.
# Builds on amd64, arm64 and 32-bit arm/v7 (e.g. a Raspberry Pi) alike.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3000 \
    MCP_STATE_FILE=/data/oauth-state.json
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/.well-known/oauth-authorization-server || exit 1
CMD ["node", "dist/index.js"]
