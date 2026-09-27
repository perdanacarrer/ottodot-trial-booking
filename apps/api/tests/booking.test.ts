import { describe, it, expect } from "vitest";
import { db } from "./setup.js";
import { makeParentWithStudent, makeTrialClass, makeConfirmedBookings } from "./factories.js";
import { createBooking, payForBooking, getRoster, BOOKING_STATUS } from "../src/services/bookingService.js";

describe("A. Successful booking + payment", () => {
  it("confirms the booking, records a succeeded payment attempt, and adds the student to the roster", () => {
    const { studentId } = makeParentWithStudent(db, "Amara Test");
    const trialClass = makeTrialClass(db, 4);

    const booking = createBooking(db, { studentId, trialClassId: trialClass.id });
    expect(booking.status).toBe(BOOKING_STATUS.PENDING_PAYMENT);

    const confirmed = payForBooking(db, booking.id, "success");
    expect(confirmed.status).toBe(BOOKING_STATUS.CONFIRMED);

    const attempts = db.prepare("SELECT * FROM payment_attempts WHERE bookingId = ?").all(booking.id) as Array<{
      status: string;
    }>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("succeeded");

    const roster = getRoster(db, trialClass.id);
    expect(roster.confirmedCount).toBe(1);
    expect(roster.roster.map((r) => r.studentId)).toContain(studentId);
  });
});

describe("B. Payment failure", () => {
  it("marks the booking payment_failed and never adds the student to the confirmed roster", () => {
    const { studentId } = makeParentWithStudent(db, "Ethan Test");
    const trialClass = makeTrialClass(db, 4);

    const booking = createBooking(db, { studentId, trialClassId: trialClass.id });
    const result = payForBooking(db, booking.id, "failure");

    expect(result.status).toBe(BOOKING_STATUS.PAYMENT_FAILED);

    const attempts = db.prepare("SELECT * FROM payment_attempts WHERE bookingId = ?").all(booking.id) as Array<{
      status: string;
    }>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("failed");

    const roster = getRoster(db, trialClass.id);
    expect(roster.confirmedCount).toBe(0);
    expect(roster.roster.map((r) => r.studentId)).not.toContain(studentId);
  });
});

describe("C. Duplicate booking", () => {
  it("rejects a duplicate confirmed booking for the same student + class, leaving exactly one confirmed booking", () => {
    const { studentId } = makeParentWithStudent(db, "Anika Test");
    const trialClass = makeTrialClass(db, 4);

    const firstBooking = createBooking(db, { studentId, trialClassId: trialClass.id });
    payForBooking(db, firstBooking.id, "success");

    // Attempting to create a second booking for the same student + class
    // must be rejected at the createBooking step.
    let thrown: unknown;
    try {
      createBooking(db, { studentId, trialClassId: trialClass.id });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: "DUPLICATE_BOOKING" });

    const confirmedBookings = db
      .prepare("SELECT * FROM bookings WHERE studentId = ? AND trialClassId = ? AND status = ?")
      .all(studentId, trialClass.id, BOOKING_STATUS.CONFIRMED);
    expect(confirmedBookings).toHaveLength(1);
  });

  it("also rejects at the database level via the partial unique index if application checks were bypassed", () => {
    const { studentId } = makeParentWithStudent(db, "Noah Test");
    const trialClass = makeTrialClass(db, 4);

    db.prepare("INSERT INTO bookings (id, studentId, trialClassId, status) VALUES (?, ?, ?, ?)").run(
      "booking-1",
      studentId,
      trialClass.id,
      BOOKING_STATUS.CONFIRMED
    );

    // Simulate application code incorrectly trying to insert a second
    // confirmed booking directly, bypassing createBooking()'s own check.
    expect(() =>
      db
        .prepare("INSERT INTO bookings (id, studentId, trialClassId, status) VALUES (?, ?, ?, ?)")
        .run("booking-2", studentId, trialClass.id, BOOKING_STATUS.CONFIRMED)
    ).toThrow();
  });
});

describe("D. Capacity: class already at capacity (4/4)", () => {
  it("rejects a new confirmation with CLASS_FULL and keeps the confirmed count at 4", () => {
    const trialClass = makeTrialClass(db, 4);
    makeConfirmedBookings(db, trialClass.id, 4);

    const { studentId } = makeParentWithStudent(db, "Overflow Student");
    const booking = createBooking(db, { studentId, trialClassId: trialClass.id });

    let thrown: unknown;
    try {
      payForBooking(db, booking.id, "success");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: "CLASS_FULL" });

    const roster = getRoster(db, trialClass.id);
    expect(roster.confirmedCount).toBe(4);

    const failedBooking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(booking.id) as { status: string };
    expect(failedBooking.status).toBe(BOOKING_STATUS.PAYMENT_FAILED);
  });
});

describe("E. Three confirmed students (3/4): one more seat available", () => {
  it("allows a fourth confirmation to succeed", () => {
    const trialClass = makeTrialClass(db, 4);
    makeConfirmedBookings(db, trialClass.id, 3);

    const { studentId } = makeParentWithStudent(db, "Fourth Student");
    const booking = createBooking(db, { studentId, trialClassId: trialClass.id });
    const confirmed = payForBooking(db, booking.id, "success");

    expect(confirmed.status).toBe(BOOKING_STATUS.CONFIRMED);

    const roster = getRoster(db, trialClass.id);
    expect(roster.confirmedCount).toBe(4);
    expect(roster.seatsRemaining).toBe(0);
  });
});
