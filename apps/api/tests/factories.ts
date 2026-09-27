import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../src/db.js";
import { BOOKING_STATUS, PAYMENT_STATUS } from "../src/services/bookingService.js";

let counter = 0;
function unique(prefix: string) {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

export function makeParentWithStudent(db: AppDatabase, name = "Test Student") {
  const parentId = randomUUID();
  db.prepare("INSERT INTO parents (id, name, email) VALUES (?, ?, ?)").run(
    parentId,
    `${name} Parent`,
    `${unique("parent")}@example-mail.test`
  );
  const studentId = randomUUID();
  db.prepare("INSERT INTO students (id, parentId, name) VALUES (?, ?, ?)").run(studentId, parentId, name);
  return { parentId, studentId };
}

export function makeTrialClass(db: AppDatabase, capacity = 4, title = "Test Trial Class") {
  const id = randomUUID();
  const startsAt = new Date(Date.now() + 86_400_000).toISOString();
  db.prepare("INSERT INTO trial_classes (id, title, startsAt, capacity) VALUES (?, ?, ?, ?)").run(
    id,
    title,
    startsAt,
    capacity
  );
  return { id, title, startsAt, capacity };
}

/**
 * Creates `count` confirmed bookings (with succeeded payment attempts) for
 * distinct new students against the given trial class - used to set up
 * "class with N confirmed students" scenarios quickly.
 */
export function makeConfirmedBookings(db: AppDatabase, trialClassId: string, count: number) {
  const bookingIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const { studentId } = makeParentWithStudent(db, `Filler Student ${i}-${unique("s")}`);
    const bookingId = randomUUID();
    db.prepare("INSERT INTO bookings (id, studentId, trialClassId, status) VALUES (?, ?, ?, ?)").run(
      bookingId,
      studentId,
      trialClassId,
      BOOKING_STATUS.CONFIRMED
    );
    db.prepare("INSERT INTO payment_attempts (id, bookingId, status) VALUES (?, ?, ?)").run(
      randomUUID(),
      bookingId,
      PAYMENT_STATUS.SUCCEEDED
    );
    bookingIds.push(bookingId);
  }
  return bookingIds;
}
