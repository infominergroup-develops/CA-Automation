FROM node:24-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm run agent:build

ENV NODE_ENV=production API_PORT=3001 DATA_DIR=/data
# /app/data too, in case the host sets DATA_DIR=./data (e.g. App Platform env copied from a dev .env)
RUN mkdir -p /data /app/data && chown node:node /data /app/data
USER node
EXPOSE 3001
# Firestore + Cloud Storage server (Cloud Run). The SQLite server is server/index.ts.
CMD ["node_modules/.bin/tsx", "server/index-fs.ts"]
