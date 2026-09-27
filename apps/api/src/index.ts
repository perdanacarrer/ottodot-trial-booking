import "dotenv/config";
import { openDatabase } from "./db.js";
import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 4000);
const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db";

const db = openDatabase(databaseUrl);
const app = buildServer(db);

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    console.log(`Ottodot Trial Booking API listening on http://localhost:${port}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
