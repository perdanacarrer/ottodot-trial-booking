import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "./setup.js";
import { buildServer } from "../src/server.js";
import { makeParentWithStudent, makeTrialClass, makeConfirmedBookings } from "./factories.js";
import { BOOKING_STATUS } from "../src/services/bookingService.js";

/**
 * This test deliberately goes through *real* HTTP requests over the
 * network (not direct function calls, and not Fastify's in-process
 * `inject()`) so that the two competing payment confirmations are
 * genuinely concurrent from the operating system's point of view: two
 * separate sockets, accepted and processed as interleaved I/O by Node's
 * event loop - not simply two function calls evaluated one after another
 * in the same synchronous stack frame.
 *
 * The implementation still guarantees correctness under this real
 * concurrency because the seat-check-and-confirm critical section itself
 * (see src/services/bookingService.ts) executes synchronously once each
 * request reaches it - see the comment there for the full explanation.
 */

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = buildServer(db);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address && typeof address === "object") {
    baseUrl = `http://127.0.0.1:${address.port}`;
  } else {
    throw new Error("Failed to determine test server address");
  }
});

afterAll(async () => {
  await app.close();
});

async function payViaHttp(bookingId: string, result: "success" | "failure") {
  const res = await fetch(`${baseUrl}/api/bookings/${bookingId}/pay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result }),
  });
  const body = await res.json();
  return { statusCode: res.status, body };
}

describe("F. Last-seat race condition (mandatory, real concurrent HTTP requests)", () => {
  it("lets exactly one of two concurrent final-seat confirmations succeed, and never exceeds capacity", async () => {
    const trialClass = makeTrialClass(db, 4);
    // 3 confirmed already -> exactly one seat left.
    makeConfirmedBookings(db, trialClass.id, 3);

    const { studentId: studentA } = makeParentWithStudent(db, "User A");
    const { studentId: studentB } = makeParentWithStudent(db, "User B");

    // Both users create their pending_payment booking for the same class
    // before either pays - mirroring "User A selects the last seat, User B
    // selects the same seat" from the assignment.
    const createA = await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId: studentA, trialClassId: trialClass.id }),
    }).then((r) => r.json());
    const createB = await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId: studentB, trialClassId: trialClass.id }),
    }).then((r) => r.json());

    // Both complete payment at the same time: two real, concurrent HTTP
    // requests fired without waiting for one another, via Promise.all.
    const [resultA, resultB] = await Promise.all([
      payViaHttp(createA.id, "success"),
      payViaHttp(createB.id, "success"),
    ]);

    const outcomes = [resultA, resultB];
    const succeeded = outcomes.filter((o) => o.statusCode === 200);
    const failed = outcomes.filter((o) => o.statusCode === 409);

    // Exactly one confirmation succeeds...
    expect(succeeded).toHaveLength(1);
    // ...and the other fails deterministically with CLASS_FULL, not a
    // generic/ambiguous error.
    expect(failed).toHaveLength(1);
    expect(failed[0].body.error.code).toBe("CLASS_FULL");

    // The database itself is the source of truth: after the race, query it
    // directly and assert the invariant holds.
    const { count: confirmedCount } = db
      .prepare("SELECT COUNT(*) as count FROM bookings WHERE trialClassId = ? AND status = ?")
      .get(trialClass.id, BOOKING_STATUS.CONFIRMED) as { count: number };
    expect(confirmedCount).toBe(4); // never 5, never over capacity
    expect(confirmedCount).toBeLessThanOrEqual(trialClass.capacity);

    // The losing booking must be explicitly marked payment_failed, not left
    // dangling in pending_payment and not confirmed.
    const freshA = db.prepare("SELECT status FROM bookings WHERE id = ?").get(createA.id) as { status: string };
    const freshB = db.prepare("SELECT status FROM bookings WHERE id = ?").get(createB.id) as { status: string };
    const statuses = [freshA.status, freshB.status].sort();
    expect(statuses).toEqual([BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.PAYMENT_FAILED].sort());
  });

  it("holds the invariant even with many concurrent confirmations racing for one seat", async () => {
    const trialClass = makeTrialClass(db, 4);
    makeConfirmedBookings(db, trialClass.id, 3); // 1 seat left

    const contenderCount = 6;
    const bookingIds: string[] = [];
    for (let i = 0; i < contenderCount; i++) {
      const { studentId } = makeParentWithStudent(db, `Contender ${i}`);
      const created = await fetch(`${baseUrl}/api/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, trialClassId: trialClass.id }),
      }).then((r) => r.json());
      bookingIds.push(created.id);
    }

    const results = await Promise.all(bookingIds.map((id) => payViaHttp(id, "success")));
    const succeededCount = results.filter((r) => r.statusCode === 200).length;
    expect(succeededCount).toBe(1);

    const { count: confirmedCount } = db
      .prepare("SELECT COUNT(*) as count FROM bookings WHERE trialClassId = ? AND status = ?")
      .get(trialClass.id, BOOKING_STATUS.CONFIRMED) as { count: number };
    expect(confirmedCount).toBe(4);
  });
});
