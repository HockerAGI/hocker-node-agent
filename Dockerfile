# -------- Builder --------
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY README.md .
RUN npm install --no-audit --no-fund
RUN npm run build

# -------- Runner --------
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/README.md ./README.md

EXPOSE 8080
CMD ["node","dist/index.js"]