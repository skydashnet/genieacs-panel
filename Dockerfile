FROM node:18-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

FROM node:18-alpine
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY . .

EXPOSE 3000

CMD ["node", "src/server.js"]