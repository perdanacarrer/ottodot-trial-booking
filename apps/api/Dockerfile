# Ottodot Trial Booking - API image
#
# Uses a Debian-based (glibc) Node image rather than Alpine: better-sqlite3
# is a native addon, and glibc gives it the broadest chance of finding a
# matching prebuilt binary; the build tools below are a fallback so
# `npm install` still succeeds by compiling from source if no prebuild
# matches this image's architecture/Node version (e.g. some ARM hosts).
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first (better layer caching on rebuilds).
COPY package.json package-lock.json* ./
RUN npm install

# Now copy the rest of the source.
COPY . .

# The container writes its SQLite file under /app/data so it can be backed
# by a named volume (see docker-compose.yml) and survive container restarts.
ENV DATABASE_URL=file:/app/data/dev.db
ENV PORT=4000

EXPOSE 4000

# Runs the TypeScript source directly via tsx - the same tool used for
# local `npm run dev` - so there is no separate compiled-output path to
# keep in sync with source changes.
CMD ["npx", "tsx", "src/index.ts"]
