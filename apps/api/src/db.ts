import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "..", "db", "schema.sql");

/**
 * DATABASE_URL uses the familiar `file:./path/to.db` shape (same convention
 * Prisma uses) purely so the .env file reads naturally; we parse it
 * ourselves since we talk to SQLite directly via better-sqlite3.
 */
function resolveDbPath(databaseUrl: string): string {
  const withoutScheme = databaseUrl.startsWith("file:") ? databaseUrl.slice(5) : databaseUrl;
  return path.resolve(process.cwd(), withoutScheme);
}

export function openDatabase(databaseUrl: string): Database.Database {
  const filePath = resolveDbPath(databaseUrl);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);

  return db;
}

export type AppDatabase = Database.Database;
