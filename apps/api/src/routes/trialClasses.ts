import type { FastifyInstance } from "fastify";
import type { AppDatabase } from "../db.js";
import { AppError, getRoster, BOOKING_STATUS } from "../services/bookingService.js";

interface TrialClassRow {
  id: string;
  title: string;
  startsAt: string;
  capacity: number;
}

export async function trialClassesRoutes(app: FastifyInstance, opts: { db: AppDatabase }) {
  const { db } = opts;

  function withSeatCounts(trialClass: TrialClassRow) {
    const { count } = db
      .prepare("SELECT COUNT(*) as count FROM bookings WHERE trialClassId = ? AND status = ?")
      .get(trialClass.id, BOOKING_STATUS.CONFIRMED) as { count: number };
    return {
      ...trialClass,
      confirmedCount: count,
      seatsRemaining: Math.max(0, trialClass.capacity - count),
    };
  }

  // GET /api/trial-classes - list classes with seats remaining, for the "pick a trial class" UI step.
  app.get("/api/trial-classes", async () => {
    const classes = db.prepare("SELECT * FROM trial_classes ORDER BY startsAt ASC").all() as TrialClassRow[];
    return classes.map(withSeatCounts);
  });

  // GET /api/trial-classes/:id
  app.get<{ Params: { id: string } }>("/api/trial-classes/:id", async (req, reply) => {
    const trialClass = db.prepare("SELECT * FROM trial_classes WHERE id = ?").get(req.params.id) as
      | TrialClassRow
      | undefined;
    if (!trialClass) {
      return reply.code(404).send({ error: { code: "CLASS_NOT_FOUND", message: "Trial class not found." } });
    }
    return withSeatCounts(trialClass);
  });

  // GET /api/trial-classes/:id/roster - what an admin/teacher sees before class starts.
  app.get<{ Params: { id: string } }>("/api/trial-classes/:id/roster", async (req, reply) => {
    try {
      return getRoster(db, req.params.id);
    } catch (err) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });
}
