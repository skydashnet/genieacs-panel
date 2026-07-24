FROM node:22-alpine AS frontend-build

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --include=dev
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS runtime

ENV APP_ENV=production \
    APP_HOST=0.0.0.0 \
    APP_PORT=5890 \
    PORTAL_PORT=5891 \
    DATA_DIR=/var/lib/skygenpanel

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/ ./
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

RUN mkdir -p /var/lib/skygenpanel && chown -R node:node /var/lib/skygenpanel

USER node
EXPOSE 5890 5891
VOLUME ["/var/lib/skygenpanel"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5890/api/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
