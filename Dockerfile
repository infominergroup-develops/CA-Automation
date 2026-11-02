FROM node:24-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm run agent:build

ENV NODE_ENV=production API_PORT=3001 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3001
CMD ["node_modules/.bin/tsx", "server/index.ts"]
