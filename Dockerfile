FROM node:22-bookworm-slim

WORKDIR /app

# Necessaire si better-sqlite3 doit etre compile
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        poppler-utils \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data /app/downloads /app/exports

CMD ["node", "index.js"]
