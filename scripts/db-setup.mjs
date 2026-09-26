import { existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

if (!existsSync('.env')) {
  writeFileSync('.env', 'DATABASE_URL="file:./dev.db"\nAPI_PORT=3000\nWEB_ORIGIN="http://localhost:5173"\n');
  console.log('Created local .env with a SQLite development database path.');
}

execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', 'generate'], { stdio: 'inherit' });
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit' });
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', 'db', 'seed'], { stdio: 'inherit' });
