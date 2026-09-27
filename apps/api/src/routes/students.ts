import type { FastifyInstance } from "fastify";
import type { AppDatabase } from "../db.js";

export async function studentsRoutes(app: FastifyInstance, opts: { db: AppDatabase }) {
  const { db } = opts;

  // GET /api/students - list all students with their parent, for the "choose a child" UI step.
  app.get("/api/students", async () => {
    return db
      .prepare(
        `SELECT s.id as id, s.name as name, p.name as parentName, p.email as parentEmail
         FROM students s
         JOIN parents p ON p.id = s.parentId
         ORDER BY s.name ASC`
      )
      .all();
  });
}
