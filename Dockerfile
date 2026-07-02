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
COPY . .
RUN npm run build

FROM nginx:alpine AS serve
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
