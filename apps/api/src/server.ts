import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

// Keep runtime setup dependency-free: load the small local .env file created by db:setup.
if (!process.env.DATABASE_URL) {
  try {
    const env = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
    for (const line of env.split(/\r?\n/)) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^\"|\"$/g, '');
    }
  } catch {
    // Prisma will report a clear configuration error if DATABASE_URL is absent.
  }
}
import { buildApp } from './app.js';

const prisma = new PrismaClient();
const app = buildApp(prisma);
const port = Number(process.env.API_PORT ?? 3000);

const start = async () => {
  try {
    await app.listen({ port, host: '0.0.0.0' });
  } catch (error) {
    app.log.error(error);
    await prisma.$disconnect();
    process.exit(1);
  }
};

const shutdown = async () => {
  await app.close();
  await prisma.$disconnect();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
start();
