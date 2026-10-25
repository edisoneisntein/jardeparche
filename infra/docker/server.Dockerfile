# syntax=docker/dockerfile:1

# ─── build: compila el monorepo (packages primero, luego apps) ───────
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
# El contexto es la raíz del monorepo para que pnpm resuelva los workspaces.
COPY . .
# Usa pnpm-lock.yaml si existe; si no, lo genera. Para builds reproducibles,
# commitea el lockfile.
RUN pnpm install
RUN pnpm build

# ─── runtime: imagen mínima, usuario no root ─────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
# Copiamos el workspace completo porque pnpm usa node_modules con symlinks.
COPY --from=build /app /app
RUN chown -R node:node /app
USER node
EXPOSE 8787
CMD ["node", "apps/server/dist/index.js"]
