#!/bin/sh
set -eu

mkdir -p /app/data

npx prisma migrate deploy

# Seed only when the database is empty. This keeps demo data deterministic without
# wiping bookings every time the API container restarts.
node --input-type=module <<'NODE'
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
try {
  const parentCount = await prisma.parent.count();
  if (parentCount === 0) {
    const { execFileSync } = await import('node:child_process');
    execFileSync('npx', ['prisma', 'db', 'seed'], { stdio: 'inherit' });
  } else {
    console.log('Database already contains data; skipping seed.');
  }
} finally {
  await prisma.$disconnect();
}
NODE

exec npx tsx apps/api/src/server.ts
