# Browser preview image. Desktop bundles are built by the CI matrix.

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.node.json Dockerfile .dockerignore ./
COPY scripts/third-party-notices.mjs scripts/docker-context.check.mjs scripts/bundle-boundaries.check.mjs ./scripts/
COPY src-tauri/Cargo.lock ./src-tauri/
COPY src ./src
COPY public ./public
RUN npm run build

FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:ed04ec1ff34502c339ee5c3ae3f855442398edc1d05591e2b98981dcbbd20b1e AS serve
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
