import { describe, it, expect } from "vitest";
import { db } from "./setup.js";
import { buildServer } from "../src/server.js";
import { makeParentWithStudent, makeTrialClass } from "./factories.js";

describe("HTTP API (end-to-end, via Fastify inject)", () => {
  it("supports the full parent flow: list students, list classes, book, pay, view roster", async () => {
    const app = buildServer(db);
    const { studentId } = makeParentWithStudent(db, "HTTP Test Student");
    const trialClass = makeTrialClass(db, 4, "HTTP Test Class");

    const studentsRes = await app.inject({ method: "GET", url: "/api/students" });
    expect(studentsRes.statusCode).toBe(200);
    expect(studentsRes.json().some((s: { id: string }) => s.id === studentId)).toBe(true);

    const classesRes = await app.inject({ method: "GET", url: "/api/trial-classes" });
    expect(classesRes.statusCode).toBe(200);
    const found = classesRes.json().find((c: { id: string }) => c.id === trialClass.id);
    expect(found.seatsRemaining).toBe(4);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/bookings",
      payload: { studentId, trialClassId: trialClass.id },
    });
    expect(createRes.statusCode).toBe(201);
    const booking = createRes.json();
    expect(booking.status).toBe("pending_payment");

    const payRes = await app.inject({
      method: "POST",
      url: `/api/bookings/${booking.id}/pay`,
      payload: { result: "success" },
    });
    expect(payRes.statusCode).toBe(200);
    expect(payRes.json().status).toBe("confirmed");

    const rosterRes = await app.inject({ method: "GET", url: `/api/trial-classes/${trialClass.id}/roster` });
    expect(rosterRes.statusCode).toBe(200);
    const roster = rosterRes.json();
    expect(roster.confirmedCount).toBe(1);
    expect(roster.roster[0].studentId).toBe(studentId);

    await app.close();
  });

  it("returns a 409 with a clear error code when the class is full", async () => {
    const app = buildServer(db);
    const trialClass = makeTrialClass(db, 1, "Tiny Class");
    const { studentId: seatTaker } = makeParentWithStudent(db, "Seat Taker");
    const { studentId: latecomer } = makeParentWithStudent(db, "Latecomer");

    const b1 = (
      await app.inject({
        method: "POST",
        url: "/api/bookings",
        payload: { studentId: seatTaker, trialClassId: trialClass.id },
      })
    ).json();
    await app.inject({ method: "POST", url: `/api/bookings/${b1.id}/pay`, payload: { result: "success" } });

    const b2 = (
      await app.inject({
        method: "POST",
        url: "/api/bookings",
        payload: { studentId: latecomer, trialClassId: trialClass.id },
      })
    ).json();
    const payRes = await app.inject({
      method: "POST",
      url: `/api/bookings/${b2.id}/pay`,
      payload: { result: "success" },
    });

    expect(payRes.statusCode).toBe(409);
    expect(payRes.json().error.code).toBe("CLASS_FULL");

    await app.close();
  });
});
