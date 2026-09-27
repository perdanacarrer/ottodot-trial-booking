import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db.js";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const BOOKING_STATUS = {
  PENDING_PAYMENT: "pending_payment",
  CONFIRMED: "confirmed",
  PAYMENT_FAILED: "payment_failed",
  CANCELLED: "cancelled",
} as const;

export const PAYMENT_STATUS = {
  PENDING: "pending",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
} as const;

interface BookingRow {
  id: string;
  studentId: string;
  trialClassId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface TrialClassRow {
  id: string;
  title: string;
  startsAt: string;
  capacity: number;
  createdAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function getBookingById(db: AppDatabase, id: string): BookingRow | undefined {
  return db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as BookingRow | undefined;
}

export function getBookingWithDetails(db: AppDatabase, id: string) {
  const booking = getBookingById(db, id);
  if (!booking) return undefined;
  const paymentAttempts = db
    .prepare("SELECT * FROM payment_attempts WHERE bookingId = ? ORDER BY createdAt ASC")
    .all(id);
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(booking.studentId);
  const trialClass = db.prepare("SELECT * FROM trial_classes WHERE id = ?").get(booking.trialClassId);
  return { ...booking, paymentAttempts, student, trialClass };
}

/**
 * Create a new pending_payment booking for a student + trial class.
 *
 * Duplicate prevention: we check in application code first (for a clear,
 * specific error message), but the authoritative guard is the database-
 * level partial unique index on bookings(studentId, trialClassId)
 * WHERE status = 'confirmed' (see db/schema.sql). A pending_payment
 * booking is allowed to exist even if the student has no confirmed
 * booking yet - only "confirmed" is protected, since that's the state
 * that occupies a roster seat.
 */
export function createBooking(
  db: AppDatabase,
  input: { studentId: string; trialClassId: string }
): BookingRow {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(input.studentId);
  if (!student) {
    throw new AppError(404, "STUDENT_NOT_FOUND", "Student not found.");
  }

  const trialClass = db.prepare("SELECT * FROM trial_classes WHERE id = ?").get(input.trialClassId);
  if (!trialClass) {
    throw new AppError(404, "CLASS_NOT_FOUND", "Trial class not found.");
  }

  const existingConfirmed = db
    .prepare("SELECT id FROM bookings WHERE studentId = ? AND trialClassId = ? AND status = ?")
    .get(input.studentId, input.trialClassId, BOOKING_STATUS.CONFIRMED);
  if (existingConfirmed) {
    throw new AppError(
      409,
      "DUPLICATE_BOOKING",
      "This student already has a confirmed booking for this trial class."
    );
  }

  const id = randomUUID();
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO bookings (id, studentId, trialClassId, status, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, input.studentId, input.trialClassId, BOOKING_STATUS.PENDING_PAYMENT, timestamp, timestamp);

  return getBookingById(db, id)!;
}

function recordPaymentAttempt(db: AppDatabase, bookingId: string, status: string, failureReason: string | null) {
  db.prepare(
    `INSERT INTO payment_attempts (id, bookingId, status, failureReason, createdAt)
     VALUES (?, ?, ?, ?, ?)`
  ).run(randomUUID(), bookingId, status, failureReason, nowIso());
}

function setBookingStatus(db: AppDatabase, bookingId: string, status: string) {
  db.prepare("UPDATE bookings SET status = ?, updatedAt = ? WHERE id = ?").run(status, nowIso(), bookingId);
}

/**
 * THE critical section for the last-seat race condition.
 *
 * Why a naive "count confirmed seats, then insert if there's room" is
 * unsafe: if that check-then-write sequence contains an `await` (as it
 * would with almost any async database driver), two concurrent requests
 * for the same class's last seat can both execute the "count" step before
 * either executes the "write" step. Both observe confirmedCount = 3 out
 * of capacity 4, both conclude a seat is free, and both write - producing
 * 5 confirmed students in a class capped at 4.
 *
 * How this implementation avoids that: `better-sqlite3` is a *synchronous*
 * driver, and this whole function contains no `await`/asynchronous gaps.
 * Node.js is single-threaded, so once this function starts running it
 * runs to completion - "count then write" - before the event loop can
 * hand control to any other request, including another call to this same
 * function. There is no window in which two callers can both observe the
 * same stale seat count. `db.transaction(...)` additionally wraps the
 * statements in a real SQL transaction, so if anything throws partway
 * through, all writes are rolled back together (crash/consistency safety
 * - not the concurrency safety, which comes from synchronous execution).
 *
 * On top of that, the database's partial unique index (see db/schema.sql)
 * is a second, independent backstop: even if this application-level logic
 * had a bug, SQLite itself would reject a write that created a second
 * confirmed booking for the same (studentId, trialClassId).
 *
 * Honest limitation: this guarantee is per Node.js *process*. If this API
 * were horizontally scaled across multiple processes/machines sharing one
 * SQLite file, synchronous single-threaded execution alone would no longer
 * be enough - each process would need to force writers to serialize (e.g.
 * `BEGIN IMMEDIATE`) rather than relying on in-process ordering. For a
 * single-process deployment (true here, and typical for a service this
 * size), the synchronous approach is sufficient and does not overclaim
 * database semantics SQLite doesn't actually provide.
 */
type PaymentSuccessResult =
  | { ok: true; booking: BookingRow }
  | { ok: false; statusCode: number; code: string; message: string };

const runPaymentSuccess = (db: AppDatabase, bookingId: string) =>
  db.transaction((): PaymentSuccessResult => {
    const booking = getBookingById(db, bookingId);
    if (!booking) {
      // Nothing to write/roll back; safe to throw directly - there's no
      // partial state that needs to survive this transaction.
      throw new AppError(404, "BOOKING_NOT_FOUND", "Booking not found.");
    }
    if (booking.status === BOOKING_STATUS.CONFIRMED) {
      throw new AppError(409, "ALREADY_CONFIRMED", "This booking is already confirmed.");
    }
    if (booking.status === BOOKING_STATUS.CANCELLED) {
      throw new AppError(409, "BOOKING_CANCELLED", "This booking has been cancelled.");
    }

    const trialClass = db.prepare("SELECT * FROM trial_classes WHERE id = ?").get(booking.trialClassId) as
      | TrialClassRow
      | undefined;
    if (!trialClass) {
      throw new AppError(404, "CLASS_NOT_FOUND", "Trial class not found.");
    }

    // Belt-and-suspenders duplicate check (the DB partial unique index is
    // the ultimate backstop, but we want a clean, specific error here).
    //
    // IMPORTANT: from here on, if we need to reject this payment we must
    // *return* a failure result rather than `throw`, and let the caller
    // throw once we're back outside `db.transaction(...)`. better-sqlite3
    // rolls back every write made inside a transaction callback if that
    // callback throws - so throwing here would silently undo the
    // "mark this booking payment_failed" write we're about to make,
    // leaving it stuck in pending_payment instead.
    const existingConfirmed = db
      .prepare("SELECT id FROM bookings WHERE studentId = ? AND trialClassId = ? AND status = ? AND id != ?")
      .get(booking.studentId, booking.trialClassId, BOOKING_STATUS.CONFIRMED, booking.id);
    if (existingConfirmed) {
      recordPaymentAttempt(db, booking.id, PAYMENT_STATUS.FAILED, "DUPLICATE_BOOKING");
      setBookingStatus(db, booking.id, BOOKING_STATUS.PAYMENT_FAILED);
      return {
        ok: false,
        statusCode: 409,
        code: "DUPLICATE_BOOKING",
        message: "This student already has a confirmed booking for this trial class.",
      };
    }

    const { count } = db
      .prepare("SELECT COUNT(*) as count FROM bookings WHERE trialClassId = ? AND status = ?")
      .get(trialClass.id, BOOKING_STATUS.CONFIRMED) as { count: number };

    if (count >= trialClass.capacity) {
      // The seat was taken by someone else while this booking was pending
      // payment. Record the failed attempt and return a deterministic,
      // explicit error - never a confirmed booking.
      recordPaymentAttempt(db, booking.id, PAYMENT_STATUS.FAILED, "CLASS_FULL");
      setBookingStatus(db, booking.id, BOOKING_STATUS.PAYMENT_FAILED);
      return { ok: false, statusCode: 409, code: "CLASS_FULL", message: "No seats remaining in this trial class." };
    }

    recordPaymentAttempt(db, booking.id, PAYMENT_STATUS.SUCCEEDED, null);
    setBookingStatus(db, booking.id, BOOKING_STATUS.CONFIRMED);

    return { ok: true, booking: getBookingById(db, booking.id)! };
  });

const runPaymentFailure = (db: AppDatabase, bookingId: string) =>
  db.transaction(() => {
    const booking = getBookingById(db, bookingId);
    if (!booking) {
      throw new AppError(404, "BOOKING_NOT_FOUND", "Booking not found.");
    }
    if (booking.status === BOOKING_STATUS.CONFIRMED) {
      throw new AppError(409, "ALREADY_CONFIRMED", "This booking is already confirmed.");
    }
    if (booking.status === BOOKING_STATUS.CANCELLED) {
      throw new AppError(409, "BOOKING_CANCELLED", "This booking has been cancelled.");
    }

    recordPaymentAttempt(db, booking.id, PAYMENT_STATUS.FAILED, "Simulated payment failure");
    setBookingStatus(db, booking.id, BOOKING_STATUS.PAYMENT_FAILED);

    return getBookingById(db, booking.id)!;
  });

/**
 * Process a (mocked) payment result for a booking. See runPaymentSuccess
 * above for the full explanation of the concurrency guarantee.
 */
export function payForBooking(db: AppDatabase, bookingId: string, result: "success" | "failure"): BookingRow {
  if (result === "failure") {
    return runPaymentFailure(db, bookingId)();
  }
  const outcome = runPaymentSuccess(db, bookingId)();
  if (!outcome.ok) {
    throw new AppError(outcome.statusCode, outcome.code, outcome.message);
  }
  return outcome.booking;
}

export function getRoster(db: AppDatabase, trialClassId: string) {
  const trialClass = db.prepare("SELECT * FROM trial_classes WHERE id = ?").get(trialClassId) as
    | TrialClassRow
    | undefined;
  if (!trialClass) {
    throw new AppError(404, "CLASS_NOT_FOUND", "Trial class not found.");
  }

  const confirmedBookings = db
    .prepare(
      `SELECT b.id as bookingId, b.studentId, b.updatedAt as confirmedAt, s.name as studentName, p.name as parentName
       FROM bookings b
       JOIN students s ON s.id = b.studentId
       JOIN parents p ON p.id = s.parentId
       WHERE b.trialClassId = ? AND b.status = ?
       ORDER BY b.createdAt ASC`
    )
    .all(trialClassId, BOOKING_STATUS.CONFIRMED) as Array<{
    bookingId: string;
    studentId: string;
    confirmedAt: string;
    studentName: string;
    parentName: string;
  }>;

  return {
    trialClass,
    capacity: trialClass.capacity,
    confirmedCount: confirmedBookings.length,
    seatsRemaining: Math.max(0, trialClass.capacity - confirmedBookings.length),
    roster: confirmedBookings,
  };
}
