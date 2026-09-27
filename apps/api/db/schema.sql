-- Ottodot Trial Booking - SQLite schema
-- Applied idempotently at startup via `CREATE TABLE IF NOT EXISTS`.

CREATE TABLE IF NOT EXISTS parents (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  email     TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS students (
  id        TEXT PRIMARY KEY,
  parentId  TEXT NOT NULL REFERENCES parents(id),
  name      TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_students_parentId ON students(parentId);

CREATE TABLE IF NOT EXISTS trial_classes (
  id        TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  startsAt  TEXT NOT NULL,
  capacity  INTEGER NOT NULL DEFAULT 4,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- status: 'pending_payment' | 'confirmed' | 'payment_failed' | 'cancelled'
CREATE TABLE IF NOT EXISTS bookings (
  id           TEXT PRIMARY KEY,
  studentId    TEXT NOT NULL REFERENCES students(id),
  trialClassId TEXT NOT NULL REFERENCES trial_classes(id),
  status       TEXT NOT NULL,
  createdAt    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updatedAt    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_trialClassId ON bookings(trialClassId);
CREATE INDEX IF NOT EXISTS idx_bookings_studentId ON bookings(studentId);
CREATE INDEX IF NOT EXISTS idx_bookings_trialClassId_status ON bookings(trialClassId, status);

-- THE key database-level invariant: SQLite will refuse to let a row be
-- written that would create a second 'confirmed' booking for the same
-- (studentId, trialClassId) pair. This is a partial unique index -
-- pending/failed/cancelled bookings are unaffected - so this backstop
-- protects exactly the state that occupies a roster seat.
CREATE UNIQUE INDEX IF NOT EXISTS unique_confirmed_booking_per_student_class
  ON bookings(studentId, trialClassId)
  WHERE status = 'confirmed';

-- status: 'pending' | 'succeeded' | 'failed'
CREATE TABLE IF NOT EXISTS payment_attempts (
  id            TEXT PRIMARY KEY,
  bookingId     TEXT NOT NULL REFERENCES bookings(id),
  status        TEXT NOT NULL,
  failureReason TEXT,
  createdAt     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_bookingId ON payment_attempts(bookingId);
