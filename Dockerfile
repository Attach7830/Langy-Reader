FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY server ./server
COPY shared ./shared
COPY scripts/build-thesaurus.js scripts/build-wiktionary.js scripts/build-mandarin.js ./scripts/
RUN npm run build:thesaurus
COPY index.html ./
COPY src ./src
COPY shared ./shared
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 READER_DATA=/data
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional && mkdir /data && chown node:node /data
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY --from=build /app/server/thesaurus-data ./server/thesaurus-data
USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
