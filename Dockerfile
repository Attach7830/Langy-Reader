FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY server ./server
COPY shared ./shared
COPY scripts/build-thesaurus.js scripts/build-wiktionary.js scripts/build-mandarin.js scripts/offline-assets.js ./scripts/
RUN npm run build:thesaurus
COPY index.html ./
COPY src ./src
COPY public ./public
COPY shared ./shared
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 READER_DATA=/data
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY licenses/pandoc* /usr/local/share/doc/langy-pandoc/
COPY scripts/install-pandoc.sh /tmp/install-pandoc.sh
RUN sh /tmp/install-pandoc.sh && rm /tmp/install-pandoc.sh
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional && mkdir /data && chown node:node /data
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY --from=build /app/server/thesaurus-data ./server/thesaurus-data
USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
