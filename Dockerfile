# Margin API — zero npm dependencies (uses built-in node:http + node:sqlite).
FROM node:24-alpine
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/v1/health >/dev/null || exit 1
CMD ["node", "src/index.js"]
