FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-slim

# Instalar utilidades básicas y dumb-init
RUN apt-get update && \
    apt-get install -y dumb-init procps && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# OpSec: Usuario sin privilegios
RUN useradd -m hocker
USER hocker

# Usar dumb-init para evitar procesos zombies (Vital para scripts de puppeteer o casino)
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]