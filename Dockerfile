# Dockerfile untuk folder server (sudah include built frontend di public/)
FROM node:20-alpine
WORKDIR /app

# Copy package.json dan install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy semua file server (termasuk public/ yang sudah ada built frontend)
COPY . .

# Set environment & port
ENV NODE_ENV=production
EXPOSE 1997

# Jalankan server
CMD ["node", "server.js"]
