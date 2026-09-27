# Ottodot Trial Booking - Web image
#
# Stage 1: build the static React/Vite bundle.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: serve the built bundle with nginx, which also reverse-proxies
# /api/* to the api container (see nginx.conf) so the frontend can keep
# using relative "/api/..." fetch calls, same as in local dev.
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
