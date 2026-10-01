# Mesa — front-end (browser preview) image.
#
# NOTE: the full desktop app is a native Tauri binary (system webview + Rust) and
# is NOT a Docker target. This image builds and serves the in-browser build —
# useful for a headless demo, front-end CI, or hosting the preview. Native
# Windows/macOS/Linux desktop bundles are produced by the CI matrix instead
# (see .github/workflows/build.yml and docs/cross-platform.md).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.node.json Dockerfile .dockerignore ./
COPY scripts/third-party-notices.mjs scripts/docker-context.check.mjs scripts/bundle-boundaries.check.mjs ./scripts/
COPY src-tauri/Cargo.lock ./src-tauri/
COPY src ./src
COPY public ./public
RUN npm run build

FROM nginxinc/nginx-unprivileged:stable-alpine AS serve
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
