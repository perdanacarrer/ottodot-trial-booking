import type { FastifyInstance } from "fastify";
import type { AppDatabase } from "../db.js";
import { z } from "zod";
import {
  AppError,
  createBooking,
  payForBooking,
  getBookingWithDetails,
  getBookingById,
  BOOKING_STATUS,
} from "../services/bookingService.js";

const createBookingSchema = z.object({
  studentId: z.string().min(1),
  trialClassId: z.string().min(1),
});

const paySchema = z.object({
  result: z.enum(["success", "failure"]),
});

export async function bookingsRoutes(app: FastifyInstance, opts: { db: AppDatabase }) {
  const { db } = opts;

  // POST /api/bookings - create a pending_payment booking.
  app.post("/api/bookings", async (req, reply) => {
    const parsed = createBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: "INVALID_INPUT", message: parsed.error.issues.map((i) => i.message).join(", ") } });
    }

    try {
      const booking = createBooking(db, parsed.data);
      return reply.code(201).send(booking);
    } catch (err) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  // GET /api/bookings/:id
  app.get<{ Params: { id: string } }>("/api/bookings/:id", async (req, reply) => {
    const booking = getBookingWithDetails(db, req.params.id);
    if (!booking) {
      return reply.code(404).send({ error: { code: "BOOKING_NOT_FOUND", message: "Booking not found." } });
    }
    return booking;
  });

  // POST /api/bookings/:id/pay - mock payment provider callback.
  app.post<{ Params: { id: string } }>("/api/bookings/:id/pay", async (req, reply) => {
    const parsed = paySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: "INVALID_INPUT", message: parsed.error.issues.map((i) => i.message).join(", ") } });
    }

    try {
      const booking = payForBooking(db, req.params.id, parsed.data.result);
      return booking;
    } catch (err) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  // POST /api/bookings/:id/cancel - optional convenience endpoint.
  app.post<{ Params: { id: string } }>("/api/bookings/:id/cancel", async (req, reply) => {
    const booking = getBookingById(db, req.params.id);
    if (!booking) {
      return reply.code(404).send({ error: { code: "BOOKING_NOT_FOUND", message: "Booking not found." } });
    }
    if (booking.status === BOOKING_STATUS.CANCELLED) {
      return booking;
    }
    db.prepare("UPDATE bookings SET status = ?, updatedAt = ? WHERE id = ?").run(
      BOOKING_STATUS.CANCELLED,
      new Date().toISOString(),
      booking.id
    );
    return getBookingById(db, booking.id);
  });
}
