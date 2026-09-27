import { beforeEach, afterAll } from "vitest";
import { openDatabase } from "../src/db.js";

// Tests always run against their own SQLite file (set by the "test" npm
// script), never the local dev.db, so running the test suite can never
// touch data you're looking at in the running app.
const databaseUrl = process.env.DATABASE_URL ?? "file:./tests/test.db";

export const db = openDatabase(databaseUrl);

beforeEach(() => {
  db.exec(
    "DELETE FROM payment_attempts; DELETE FROM bookings; DELETE FROM trial_classes; DELETE FROM students; DELETE FROM parents;"
  );
});

afterAll(() => {
  db.close();
});
