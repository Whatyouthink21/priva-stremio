# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

# Dependencies first for better layer caching (this project has none, but keeps
# the pattern correct if you add some later).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund || true

COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY test/ ./test/

ENV NODE_ENV=production
ENV PORT=7000
ENV HOST=0.0.0.0

EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
