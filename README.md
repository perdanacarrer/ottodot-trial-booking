# Ottodot Trial Booking

A minimal, correctness-first implementation of the Ottodot trial-booking take-home:
a parent books a trial class for their child, pays (mocked), and an admin/teacher
can see the confirmed roster with duplicate bookings, overbooking, payment
failure, and the last-seat race condition all handled at the backend/database
level, not just in the UI.

## Overview

- A parent picks a child and an available trial class, creates a booking, and
  submits a mock payment result.
- Payment success atomically confirms the booking **if and only if** a seat is
  still available; payment failure never touches the confirmed roster.
- An admin/teacher can view the confirmed roster for any trial class.
- Trial classes are hard-capped at **4 confirmed students**, enforced by the
  backend and backstopped by the database.

Only trial booking is implemented. Regular enrollment, authentication, and
payment-provider integration are explicitly out of scope (see "Scope").

## Tech Stack

- **Backend:** Node.js, TypeScript, Fastify, SQLite (via `better-sqlite3`), Zod, Vitest
- **Frontend:** React, Vite, TypeScript, plain CSS, no UI framework
- **Project:** npm workspaces, single repository

### A deliberate deviation from the requested stack: `better-sqlite3` instead of Prisma

The brief asks for Prisma. I built the schema and service layer in Prisma
first, but when I actually tried to run `prisma generate` / `prisma db push`
in my build/verification environment, it failed: Prisma downloads native
query-engine binaries from `binaries.prisma.sh` at generate time, and that
host was blocked by my environment's network policy. I could not get Prisma
to actually run, which meant I could not verify the implementation actually
worked and shipping unverified code contradicts the whole point of this
exercise (backend correctness, verified by tests).

Rather than hand over code I hadn't run, I switched the data layer to
`better-sqlite3`: still SQLite, still relational, zero native-binary network
dependency, and it installed and ran cleanly. It also turned out to make the
core challenge (the last-seat race) *simpler and more airtight* to reason
about see "Last-Seat Race Condition" below. This should work fine with
Prisma too on a machine with normal internet access; this is a note about
what I could verify, not a claim that Prisma itself is broken.

Everything else about the stack (Fastify, SQLite, TypeScript, Vitest, React +
Vite) matches the brief.

## Architecture

```
ottodot-trial-booking/
├── apps/
│   ├── api/
│   │   ├── db/schema.sql          # raw SQL schema + the partial unique index
│   │   ├── scripts/seed.ts        # synthetic seed data
│   │   ├── src/
│   │   │   ├── db.ts              # opens the SQLite file, applies schema
│   │   │   ├── server.ts          # Fastify app factory
│   │   │   ├── index.ts           # process entrypoint
│   │   │   ├── routes/            # students, trial-classes, bookings
│   │   │   └── services/
│   │   │       └── bookingService.ts   # all booking/payment/roster logic
│   │   ├── tests/                 # Vitest suite (see "Testing")
│   │   └── Dockerfile
│   └── web/
│       ├── src/                   # React UI (App.tsx, api.ts client)
│       ├── nginx.conf             # reverse-proxies /api/* when containerized
│       └── Dockerfile
├── docker-compose.yml             # optional: run both services in containers
├── README.md
└── AI_USAGE.md
```

The service layer (`bookingService.ts`) is the single place that touches
booking/payment state routes are thin, and tests call the service directly
(as well as through real HTTP requests) so the important logic is covered
regardless of transport.

## Data Model

```
parents            students             trial_classes
─────────           ─────────            ─────────────
id (PK)      ┌──────id (PK)               id (PK)
name         │      parentId (FK)         title
email        │      name                  startsAt
             │                            capacity
             └──────────────┐
                             │
                        bookings
                        ─────────────────────
                        id (PK)
                        studentId (FK)
                        trialClassId (FK)
                        status            -- pending_payment | confirmed | payment_failed | cancelled
                        createdAt / updatedAt
                             │
                             │
                     payment_attempts
                     ─────────────────
                     id (PK)
                     bookingId (FK)
                     status              -- pending | succeeded | failed
                     failureReason
                     createdAt
```

**The key constraint:** a partial unique index

```sql
CREATE UNIQUE INDEX unique_confirmed_booking_per_student_class
  ON bookings(studentId, trialClassId)
  WHERE status = 'confirmed';
```

means SQLite itself refuses to store a second `confirmed` row for the same
`(studentId, trialClassId)` pair. Non-confirmed bookings (pending/failed/
cancelled) are unaffected, since only a confirmed booking occupies a seat.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/students` | List students (for "choose a child") |
| GET | `/api/trial-classes` | List classes with `confirmedCount` / `seatsRemaining` |
| GET | `/api/trial-classes/:id` | Get one class |
| GET | `/api/trial-classes/:id/roster` | Confirmed roster for a class |
| POST | `/api/bookings` | Create a `pending_payment` booking |
| GET | `/api/bookings/:id` | Get a booking + its payment attempts |
| POST | `/api/bookings/:id/pay` | Mock payment callback: `{ "result": "success" \| "failure" }` |
| POST | `/api/bookings/:id/cancel` | Cancel a booking (convenience, optional) |

Example flow:

```bash
curl -X POST localhost:4000/api/bookings \
  -H 'Content-Type: application/json' \
  -d '{"studentId":"<id>","trialClassId":"<id>"}'
# → { "id": "...", "status": "pending_payment", ... }

curl -X POST localhost:4000/api/bookings/<bookingId>/pay \
  -H 'Content-Type: application/json' \
  -d '{"result":"success"}'
# → { "id": "...", "status": "confirmed", ... }  (or 409 CLASS_FULL)
```

Errors are returned as `{ "error": { "code": "...", "message": "..." } }`
with a meaningful HTTP status (404, 409, 400).

## Booking Lifecycle

```
pending_payment
   │
   ├── pay(success), seat available   → confirmed
   ├── pay(success), class full       → payment_failed  (error: CLASS_FULL)
   ├── pay(failure)                   → payment_failed
   └── cancel()                       → cancelled
```

`confirmed` and `cancelled` are terminal for the payment flow (you can't pay
again for an already-confirmed or cancelled booking).

## Duplicate Booking Protection

Two layers, deliberately redundant:

1. **Application check** (`createBooking` and inside the payment critical
   section): look up an existing `confirmed` booking for the same student +
   class and reject with `409 DUPLICATE_BOOKING` before touching anything
   else. This gives a specific, friendly error message.
2. **Database constraint** (the partial unique index above): the ultimate
   backstop. Even if application logic had a bug, or something inserted a
   row directly, SQLite would reject a second confirmed row for the same
   pair. `tests/booking.test.ts` includes a test that bypasses the
   application check entirely and proves the database rejects the insert.

## Capacity Protection

Every payment-success attempt re-counts confirmed bookings for the class
**inside the same synchronous critical section that writes the result** (see
below) and compares against `trialClass.capacity` (default 4). If the count
is already at capacity, the booking is marked `payment_failed` with
`failureReason: "CLASS_FULL"` and the API returns `409 CLASS_FULL` the
confirmed roster is never touched.

## Last-Seat Race Condition

**Scenario:** User A and User B both hold a `pending_payment` booking for the
same class's last seat. Both submit payment at (approximately) the same
moment. At most one may end up `confirmed`; the other must fail
deterministically.

**Why a naive implementation breaks this:** "count confirmed seats, then
insert if there's room" is unsafe whenever the check and the write are
separated by an `await` (as they are with almost any async database driver,
Prisma included). Two concurrent requests can both execute the "count" step both see `confirmedCount = 3` out of `capacity = 4` before either
executes the "write" step. Both conclude a seat is free and both write,
producing 5 confirmed students in a 4-seat class.

**What this implementation does instead:** `better-sqlite3` is a
**synchronous** driver. The entire seat-check-and-confirm sequence
(`runPaymentSuccess` in `bookingService.ts`) is one plain synchronous
function with **zero `await` gaps**. Node.js is single-threaded, so once
that function starts running, it runs to completion count, then write
before the event loop can hand control to *any* other request, including a
second concurrent call to pay for the competing booking. There is no window
in which two callers can observe the same stale seat count. The whole
sequence is also wrapped in `db.transaction(...)` for crash/consistency
safety (all writes commit or roll back together) but the concurrency
safety comes from the synchronous execution, not the SQL transaction alone.

The database's partial unique index is a second, independent backstop for
the same invariant, specifically for duplicate bookings.

**Tradeoffs accepted:**
- This guarantee is **per Node.js process**. If this API were horizontally
  scaled across multiple processes/machines sharing one SQLite file,
  single-threaded synchronous execution alone would no longer be sufficient
  each process would need to force writers to serialize at the database
  level (e.g. `BEGIN IMMEDIATE`), and at real scale you'd likely move to
  Postgres with `SELECT ... FOR UPDATE` or a `SERIALIZABLE` transaction. For
  a single-process deployment (true here, and typical for a service this
  size), the synchronous approach is sufficient, and I've tried not to claim
  a stronger guarantee than what's actually implemented.
- `better-sqlite3` blocks the event loop for the duration of each query.
  For this workload (small, fast, local SQLite queries) that's a non-issue;
  it would matter for a high-throughput or slow-query workload.

`tests/race.test.ts` proves this holds under **real concurrent HTTP
requests** (two separate sockets, fired via `Promise.all` against a live
server on a random port not sequential awaits, and not just two function
calls in the same synchronous stack frame) for both a 2-contender and a
6-contender scenario, then re-queries the database directly to assert the
final confirmed count.

## Payment Failure

A failed payment (`{ "result": "failure" }`, or a success that loses the
seat race) records a `payment_attempts` row with `status: "failed"` and sets
the booking to `payment_failed`. The booking is never transitioned to
`confirmed` on a failure path, so it can never appear in `getRoster()`,
which only ever selects `status = 'confirmed'` rows.

## Frontend

A deliberately simple React app (`apps/web`) that exercises every required
step: pick a student → pick a trial class (with live seat counts) → create a
booking → simulate payment success/failure → see the resulting status → view
the roster for any class. No design system, no client-side routing it's
meant to support a 5–8 minute walkthrough, not to be a polished product.

## Testing

```bash
npm test   # from the repo root, or `apps/api` directly
```

This resets a dedicated `tests/test.db` file (never the dev database), then
runs Vitest. Included:

- **A. Successful booking + payment** confirms, records a succeeded
  payment attempt, appears on the roster.
- **B. Payment failure** `payment_failed`, failed payment attempt,
  student absent from the roster.
- **C. Duplicate booking** rejected at the application layer with
  `DUPLICATE_BOOKING`, *and* a second test that bypasses the app layer and
  proves the database's partial unique index rejects it independently.
- **D. Capacity (4/4)** a new confirmation attempt is rejected with
  `CLASS_FULL`; confirmed count stays at 4.
- **E. Three confirmed (3/4)** a fourth confirmation succeeds.
- **F. Last-seat race (mandatory)** two, then six, real concurrent HTTP
  requests race for one remaining seat; exactly one succeeds, the rest fail
  with `CLASS_FULL`, and the database's confirmed count is asserted
  directly afterward.
- An HTTP-level integration test exercising the full flow and a 409 case
  through real Fastify routes (not just the service functions).

## Seed Data

`npm run db:setup` (or `db:seed`) populates:

- **Intro to Chemistry Lab** capacity 4, 1 confirmed (Mia Chen) → open
  seats, and also the fixture for a duplicate-booking demo (try booking Mia
  into this class again via the API).
- **Fun with Fractions** capacity 4, 3 confirmed → exactly one seat left,
  for demonstrating the last-seat race live (open two browser tabs / two
  terminal requests and pay for two different pending bookings at once).
- **Robotics Starter** capacity 4, 4 confirmed → fully booked, for the
  capacity-rejection case.
- **Stargazing 101** no confirmed bookings, with one `payment_failed`
  booking already on record (Zoe Chen) for a clean payment-failure demo.

All names/emails are synthetic (`*.example-mail.test`), no real personal data.

## How To Run

```bash
npm install
npm run db:setup   # creates apps/api/dev.db and seeds it
npm test           # runs the full Vitest suite (isolated test database)
npm run dev        # starts the API (port 4000) and the web app (port 5173)
```

Then open http://localhost:5173. The Vite dev server proxies `/api/*` to the
API on port 4000 (see `apps/web/vite.config.ts`), so no extra configuration
is needed.

To run the pieces individually: `npm run dev:api` / `npm run dev:web`.

Copy `apps/api/.env.example` to `apps/api/.env` first if you want to
customize the port or database file location; sensible defaults are used
otherwise.

## Running with Docker

The whole thing also runs as two containers via Docker Compose - no local
Node.js install required.

```bash
docker compose up --build
```

- **API** Fastify server, built and run from `apps/api/Dockerfile`.
  Exposed on **http://localhost:4000**.
- **Web** the React app is built to static files and served by nginx
  (`apps/web/Dockerfile`), which also reverse-proxies `/api/*` to the `api`
  container (see `apps/web/nginx.conf`) so the frontend's `fetch("/api/...")`
  calls work unchanged, the same way Vite's dev-server proxy does locally.
  Exposed on **http://localhost:8080** open this in your browser.

The API's SQLite file is written to `/app/data/dev.db` inside the container,
backed by a named volume (`api_data` in `docker-compose.yml`) so data
survives `docker compose down` / restarts.

**Seed the database** (once the containers are up, in another terminal):

```bash
docker compose exec api npm run db:setup
```

**Run the test suite inside the container:**

```bash
docker compose exec api npm test
```

**Convenience npm scripts** (thin wrappers around the commands above):

```bash
npm run docker:up     # docker compose up --build
npm run docker:seed   # docker compose exec api npm run db:setup
npm run docker:test   # docker compose exec api npm test
npm run docker:down   # docker compose down
```

**Starting fresh** (wipe the persisted database volume entirely):

```bash
docker compose down -v
```

## Assumptions

- A "parent chooses a child" step assumes each student belongs to exactly
  one parent (no shared custody / multiple guardians modeled).
- `capacity` is per trial class and defaults to 4, but is stored per-row
  rather than hardcoded, in case a future class needs a different cap.
- A student may hold at most one *confirmed* booking per class, but can have
  multiple non-confirmed (failed/cancelled) booking rows for the same class
  over time (e.g. retrying after a failed payment creates a new booking).
- No authentication: anyone can call any endpoint. Explicitly out of scope
  per the brief; a real deployment would need to scope "my children" to a
  logged-in parent and gate the roster endpoint to staff.
- The mock payment endpoint takes the result as direct input
  (`{"result": "success"|"failure"}`), simulating a payment provider
  webhook/callback rather than implementing an actual provider SDK.

## Scope / What Was Deliberately Cut

- No regular enrollment, only trial booking (per the brief).
- No authentication or authorization.
- No real payment provider integration (Stripe etc.) payment is fully mocked.
- No email/notification system.
- No admin role system the roster endpoint is open, not gated to "teacher" accounts.
- No pagination on list endpoints (dataset is small and synthetic).
- No multi-process/horizontal-scaling story for the concurrency guarantee
  (see the explicit tradeoff called out in "Last-Seat Race Condition").
- Prisma was swapped for `better-sqlite3` for the reason explained under
  "Tech Stack" above everything else in the required stack is unchanged.

## Monitoring After Release

In production I'd track, at minimum:

- **Booking funnel:** booking-created rate, payment-attempt rate,
  payment-success rate, payment-failure rate (split by declared vs.
  CLASS_FULL vs. DUPLICATE_BOOKING reasons).
- **Class-full rejection rate** per class, especially spikes right before a
  popular class starts a leading indicator of demand vs. capacity.
- **Duplicate-booking attempt rate** a sudden rise could indicate a buggy
  client retry loop rather than a real invariant violation.
- **Confirmed-count-vs-capacity invariant check** a scheduled job that
  periodically asserts no trial class ever shows `confirmedCount > capacity`
  in the database, as a live canary for the very bug this take-home is
  about.
- **API latency and error rate** on `/api/bookings/:id/pay` specifically,
  since it's the highest-stakes, most contended endpoint.
- **SQLite lock/busy events** if this ever moved to a multi-process
  deployment, as an early warning that the concurrency story needs
  revisiting (see the scaling tradeoff above).

## What I Would Do With More Time

- Add a scheduled/background job to auto-expire `pending_payment` bookings
  that never receive a payment result, freeing up implicitly-reserved
  seats (right now a seat is only truly "reserved" once confirmed, but a
  pile of stale pending bookings would be worth cleaning up or surfacing).
- Add authentication and scope "my children" / "my bookings" to a logged-in
  parent, and gate the roster endpoint to a teacher/admin role.
- Add pagination and search to the students/classes list endpoints.
- Add an idempotency key to `POST /api/bookings/:id/pay` so an accidental
  client-side retry of the *same* payment attempt can't be double-counted
  as two separate payment attempts (today it's safe because the seat check
  is exclusive, but a dedicated idempotency key is a cleaner primitive).
- If moving to multiple API processes/instances, revisit the concurrency
  approach as described above (`BEGIN IMMEDIATE` or a real
  `SELECT ... FOR UPDATE` on Postgres).
- Swap `better-sqlite3` back to Prisma on a machine with normal network
  access, if the team has a strong preference for Prisma's migration
  tooling and type-safety over raw SQL the service-layer interface would
  not need to change much.

## Time Spent

Time spent: approximately 4 hours (including the mid-course pivot away from
Prisma once its native-engine download was found to be blocked in my build
environment).
