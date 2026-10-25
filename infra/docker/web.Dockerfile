# syntax=docker/dockerfile:1

# ─── build: Vite genera el bundle estático del HUD ───────────────────
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install
# VITE_API_URL se hornea en el bundle en tiempo de build.
ARG VITE_API_URL=http://localhost:8787
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @jarvis/web build

# ─── runtime: nginx sirviendo SPA con fallback ───────────────────────
FROM nginx:alpine AS runtime
RUN printf '%s\n' \
  'server {' \
  '  listen 80;' \
  '  server_name _;' \
  '  root /usr/share/nginx/html;' \
  '  index index.html;' \
  '  location / {' \
  '    try_files $uri $uri/ /index.html;' \
  '  }' \
  '}' > /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
