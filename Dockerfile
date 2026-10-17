# A imagem base vai fixada por digest (o índice multi-arquitetura de
# `node:22-alpine`), e não só pela tag: a tag é móvel, e um build de hoje e um
# de amanhã poderiam sair de bases diferentes sem nenhuma linha mudar aqui. O
# Dependabot (.github/dependabot.yml) abre o PR quando sai um digest novo.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS frontend-build

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --include=dev
COPY frontend/ ./
# Os manuais de cobrança entram no bundle (`?raw` em src/lib/help-docs.ts),
# lidos de `../docs` — por isso os dois, e só eles, vêm para `/app/docs`.
COPY docs/manual-cobranca.md docs/guia-provedor-cobranca.md /app/docs/
RUN npm run build

# The backend's dependencies are installed in a stage of their own because
# `better-sqlite3` ships no prebuilt binary for Alpine's musl libc and has to
# be compiled, and the compiler belongs in a stage the runtime image never
# carries: python, make and g++ are a build-time need, not a thing to ship.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS backend-deps

RUN apk add --no-cache python3 make g++
WORKDIR /app/backend
COPY backend/package*.json ./
# O `postinstall` do backend roda `scripts/install-cli.js`, que instala a CLI
# `skygenpanel` num install de produção e se recusa educadamente em qualquer
# outro lugar — inclusive aqui. Ele precisa EXISTIR para poder se recusar: sem
# esta linha o npm morre com "Cannot find module" antes de o script decidir
# nada. Só o diretório de scripts, e antes do install, para a camada de
# dependências continuar valendo por hash de package-lock.
COPY backend/scripts ./scripts
RUN npm ci --omit=dev

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime

ENV APP_ENV=production \
    APP_HOST=0.0.0.0 \
    APP_PORT=5890 \
    PORTAL_PORT=5891 \
    DATA_DIR=/var/lib/skygenpanel

WORKDIR /app/backend
COPY --from=backend-deps /app/backend/node_modules ./node_modules
COPY backend/ ./
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist
# O instalador do agente do GenieACS, que o painel serve em
# `/api/genieacs-agent/install.sh`. A imagem não leva `deploy/` (o
# `.dockerignore` o exclui: é o instalador do self-hosted, o compose e o proxy,
# nada que rode aqui dentro), mas este arquivo é conteúdo servido pelo painel, e
# a rota o procura relativo ao próprio módulo — `/app/backend/src/routes` →
# `/app/deploy`. Só ele, e com a exceção correspondente no `.dockerignore`.
COPY deploy/install-agent.sh /app/deploy/install-agent.sh

RUN mkdir -p /var/lib/skygenpanel && chown -R node:node /var/lib/skygenpanel

USER node
EXPOSE 5890 5891
VOLUME ["/var/lib/skygenpanel"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5890/api/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
