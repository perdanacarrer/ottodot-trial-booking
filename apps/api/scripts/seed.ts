/**
 * Deterministic synthetic seed data for local demo / manual walkthrough.
 * Re-running this script wipes and recreates all rows (safe for local dev only).
 *
 * Run with: npm run db:seed (which sets DATABASE_URL from .env via dotenv-cli,
 * or just: DATABASE_URL="file:./dev.db" tsx scripts/seed.ts)
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/db.js";
import { BOOKING_STATUS, PAYMENT_STATUS } from "../src/services/bookingService.js";

const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db";
const db = openDatabase(databaseUrl);

function isoInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function insertParent(name: string, email: string) {
  const id = randomUUID();
  db.prepare("INSERT INTO parents (id, name, email) VALUES (?, ?, ?)").run(id, name, email);
  return id;
}

function insertStudent(parentId: string, name: string) {
  const id = randomUUID();
  db.prepare("INSERT INTO students (id, parentId, name) VALUES (?, ?, ?)").run(id, parentId, name);
  return id;
}

function insertTrialClass(title: string, startsAt: string, capacity = 4) {
  const id = randomUUID();
  db.prepare("INSERT INTO trial_classes (id, title, startsAt, capacity) VALUES (?, ?, ?, ?)").run(
    id,
    title,
    startsAt,
    capacity
  );
  return id;
}

function insertConfirmedBooking(studentId: string, trialClassId: string) {
  const id = randomUUID();
  db.prepare("INSERT INTO bookings (id, studentId, trialClassId, status) VALUES (?, ?, ?, ?)").run(
    id,
    studentId,
    trialClassId,
    BOOKING_STATUS.CONFIRMED
  );
  db.prepare("INSERT INTO payment_attempts (id, bookingId, status) VALUES (?, ?, ?)").run(
    randomUUID(),
    id,
    PAYMENT_STATUS.SUCCEEDED
  );
  return id;
}

function main() {
  db.exec(
    "DELETE FROM payment_attempts; DELETE FROM bookings; DELETE FROM trial_classes; DELETE FROM students; DELETE FROM parents;"
  );

  // --- Parents & students ---------------------------------------------------
  const amara = insertParent("Amara Chen", "amara.chen@example-mail.test");
  const daniel = insertParent("Daniel Osei", "daniel.osei@example-mail.test");
  const priya = insertParent("Priya Nair", "priya.nair@example-mail.test");
  const lucas = insertParent("Lucas Silva", "lucas.silva@example-mail.test");
  const grace = insertParent("Grace Tan", "grace.tan@example-mail.test");

  const mia = insertStudent(amara, "Mia Chen");
  const zoe = insertStudent(amara, "Zoe Chen");
  const ethan = insertStudent(daniel, "Ethan Osei");
  const kofi = insertStudent(daniel, "Kofi Osei");
  const anika = insertStudent(priya, "Anika Nair");
  const noah = insertStudent(lucas, "Noah Silva");
  const ivy = insertStudent(grace, "Ivy Tan");

  // --- Trial classes ---------------------------------------------------------

  // 1. Class with available seats (capacity 4, 1 confirmed -> 3 open)
  const classScienceOpen = insertTrialClass("Intro to Chemistry Lab (Trial)", isoInDays(3));

  // 2. Class with exactly 3 confirmed students (1 seat left) - last-seat race demo.
  const classMathLastSeat = insertTrialClass("Fun with Fractions (Trial)", isoInDays(5));

  // 3. Class that is already completely full (capacity test).
  const classFull = insertTrialClass("Robotics Starter (Trial)", isoInDays(7));

  // 4. A class with zero bookings, used for a clean payment-failure demo.
  const classAstronomy = insertTrialClass("Stargazing 101 (Trial)", isoInDays(10));

  // --- Bookings ----------------------------------------------------------------

  // classScienceOpen: 1 confirmed booking (Mia). This also sets up the
  // duplicate-booking demo: booking Mia into classScienceOpen again via the
  // API should be rejected with DUPLICATE_BOOKING.
  insertConfirmedBooking(mia, classScienceOpen);

  // classMathLastSeat: 3 confirmed bookings -> 1 seat left.
  insertConfirmedBooking(ethan, classMathLastSeat);
  insertConfirmedBooking(anika, classMathLastSeat);
  insertConfirmedBooking(noah, classMathLastSeat);

  // classFull: 4 confirmed bookings (fully booked). Reusing students across
  // different classes is fine - the unique constraint is per (student, class).
  insertConfirmedBooking(zoe, classFull);
  insertConfirmedBooking(kofi, classFull);
  insertConfirmedBooking(ivy, classFull);
  insertConfirmedBooking(mia, classFull);

  // Payment-failure demo: a booking on classAstronomy for Zoe with a failed
  // payment attempt already on record; the roster stays empty.
  const failedBookingId = randomUUID();
  db.prepare("INSERT INTO bookings (id, studentId, trialClassId, status) VALUES (?, ?, ?, ?)").run(
    failedBookingId,
    zoe,
    classAstronomy,
    BOOKING_STATUS.PAYMENT_FAILED
  );
  db.prepare(
    "INSERT INTO payment_attempts (id, bookingId, status, failureReason) VALUES (?, ?, ?, ?)"
  ).run(randomUUID(), failedBookingId, PAYMENT_STATUS.FAILED, "Card declined (simulated)");

  console.log("Seed complete. Key trial class ids:");
  console.log({ classScienceOpen, classMathLastSeat, classFull, classAstronomy });
}

main();
db.close();
