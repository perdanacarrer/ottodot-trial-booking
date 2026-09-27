import Fastify from "fastify";
import type { AppDatabase } from "./db.js";
import { studentsRoutes } from "./routes/students.js";
import { trialClassesRoutes } from "./routes/trialClasses.js";
import { bookingsRoutes } from "./routes/bookings.js";

export function buildServer(db: AppDatabase) {
  const app = Fastify({ logger: false });

  app.get("/api/health", async () => ({ ok: true }));

  app.register(studentsRoutes, { db });
  app.register(trialClassesRoutes, { db });
  app.register(bookingsRoutes, { db });

  // Centralized error handler: anything not already caught and turned into
  // a structured response by a route becomes a clean 500 instead of leaking
  // stack traces.
  app.setErrorHandler((error, _req, reply) => {
    app.log?.error?.(error);
    if (reply.statusCode && reply.statusCode !== 200 && reply.statusCode !== 500) {
      return reply.send({ error: { code: "ERROR", message: error.message } });
    }
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } });
  });

  return app;
}
