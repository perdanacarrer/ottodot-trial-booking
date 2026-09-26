# Ottodot Trial Booking

A small full-stack trial-booking slice for the Ottodot take-home. The implementation focuses on the assignment's core invariants: no duplicate confirmed bookings, a hard maximum of 4 confirmed students per class, payment failures that never enter the roster, and a concurrency-safe last-seat confirmation flow. The official assignment prioritizes backend correctness, data integrity, tests, and explanation over frontend polish.

## Overview

The app has:

- A Fastify + TypeScript API.
- SQLite persistence through Prisma ORM.
- A minimal React/Vite UI.
- A mocked payment result (`success` / `failure`).
- Deterministic synthetic seed data.
- Vitest tests, including concurrent final-seat confirmation.

Only trial booking is implemented; regular enrollment, authentication, real payments, email, and other production features are deliberately out of scope.

## Tech Stack

- Node.js 20+
- TypeScript
- Fastify
- SQLite
- Prisma 6
- Vitest
- React + Vite

## Architecture

```text
React UI (Vite)
      |
      | HTTP JSON
      v
Fastify API
      |
      | Prisma ORM / transactions
      v
SQLite

Booking confirmation critical section:

POST /bookings/:id/pay
        |
        v
  BEGIN transaction
        |
        +--> conditional UPDATE TrialClass
        |    confirmedCount < capacity
        |    -> increment exactly once
        |
        +--> if no row updated -> CLASS_FULL
        |
        +--> confirm Booking + PaymentAttempt
        |
        v
      COMMIT
```

## Data Model

```text
Parent 1 ---- * Student
Student 1 ---- * Booking * ---- 1 TrialClass
Booking 1 ---- * PaymentAttempt
```

### Parent

- `id`
- `name`
- `email`

### Student

- `id`
- `parentId`
- `name`

### TrialClass

- `id`
- `title`
- `startsAt`
- `capacity` (seeded at 4)
- `confirmedCount` (transactionally maintained seat-allocation counter)

### Booking

- `id`
- `studentId`
- `trialClassId`
- `status`
- `createdAt`
- `updatedAt`

Booking statuses:

- `pending_payment`
- `confirmed`
- `payment_failed`
- `cancelled` (schema-compatible status; no cancellation endpoint is needed for this take-home)

### PaymentAttempt

- `id`
- `bookingId`
- `status`: `pending`, `succeeded`, or `failed`
- `createdAt`
- `failureReason`

There is a database-level unique constraint on `(studentId, trialClassId)`. This intentionally uses a simple, stronger invariant: one booking record per student/class. The assignment requires database-level protection against duplicate active/confirmed bookings; this avoids relying on frontend checks.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/students` | List synthetic students/parents |
| GET | `/api/trial-classes` | List classes and remaining seats |
| GET | `/api/trial-classes/:id` | Class detail |
| GET | `/api/trial-classes/:id/roster` | Confirmed roster |
| POST | `/api/bookings` | Create `pending_payment` booking |
| GET | `/api/bookings/:id` | Booking + payment history |
| POST | `/api/bookings/:id/pay` | Apply mock payment result atomically |

### Create booking

```http
POST /api/bookings
Content-Type: application/json

{
  "studentId": "student-id",
  "trialClassId": "class-id"
}
```

Returns a `201` booking with `pending_payment` status.

### Pay

```http
POST /api/bookings/:id/pay
Content-Type: application/json

{
  "result": "success"
}
```

or:

```json
{ "result": "failure" }
```

A successful payment attempts atomic confirmation. A failed mock payment records a failed `PaymentAttempt`, changes the booking to `payment_failed`, and does not increment the class's confirmed count.

## Booking Lifecycle

```text
pending_payment
   |
   +---- payment_failed
   |
   +---- confirmed

cancelled is reserved for a future cancellation flow and is not exposed by this small slice.
```

If the class becomes full between booking creation and payment confirmation, the booking becomes `payment_failed`, the payment attempt records `CLASS_FULL`, and the API returns HTTP `409`.

## Duplicate Booking Protection

The API performs a friendly application-level duplicate check, but correctness does not depend on it. SQLite also enforces `UNIQUE(studentId, trialClassId)` through Prisma's database schema.

Therefore two simultaneous booking requests cannot create two rows for the same student/class: one request can win the database insert and the other receives a conflict.

## Capacity Protection

The frontend displays remaining seats, but that is informational only.

The confirmation path performs this database operation inside a transaction:

```sql
UPDATE TrialClass
SET confirmedCount = confirmedCount + 1
WHERE id = ?
  AND confirmedCount < capacity;
```

The application checks the affected-row count. Exactly one row means one seat was allocated. Zero rows means the class is already full.

This is safer than:

```text
SELECT confirmedCount
if confirmedCount < capacity
  INSERT confirmed booking
```

because two concurrent requests could both observe the same old seat count before either writes.

The counter update, booking status change, and payment attempt are committed together. If the transaction fails, the seat increment is rolled back with the booking/payment changes.

## Last-Seat Race Condition

Consider a class at 3/4 seats:

1. A and B each have `pending_payment` bookings.
2. A and B call `/pay` concurrently.
3. Each confirmation runs the conditional seat increment inside a SQLite write transaction.
4. SQLite serializes conflicting writers.
5. The first transaction changes `confirmedCount` from 3 to 4 and confirms its booking.
6. The other transaction subsequently evaluates `confirmedCount < capacity` as false, records `CLASS_FULL`, changes its booking to `payment_failed`, and returns HTTP `409`.

The important invariant is not derived from a frontend seat display or a separate count query. The seat allocation itself is an atomic conditional database write.

The API retries transient SQLite lock errors with bounded exponential backoff. This is important because concurrent SQLite writers can legitimately encounter temporary locking rather than representing a business-level `CLASS_FULL` result.

The race test uses `Promise.all` for both competing booking/payment requests and verifies the final database state, rather than merely executing two calls sequentially.

## Payment Failure

For `{ "result": "failure" }`:

- A `PaymentAttempt` with `failed` status is recorded.
- `failureReason` is `MOCK_PAYMENT_FAILED`.
- The booking becomes `payment_failed`.
- `confirmedCount` is unchanged.
- The student is absent from the confirmed roster.

For a successful mock payment, confirmation and payment success are written in the same transaction as the seat allocation.

## Validation Responsibilities

### Frontend

- Required selections.
- Displays remaining seats.
- Presents mock payment choices.
- Shows API error/status messages.

### API/backend

- Request shape validation with Zod.
- Student/class/booking existence checks.
- Booking lifecycle checks.
- Duplicate conflict handling.
- Atomic capacity enforcement.
- Payment result recording.

### Database

- Foreign keys.
- Unique student/class booking constraint.
- Transactional seat allocation and booking/payment updates.
- Indexes for common lookups.

### Background jobs

None. The assignment does not require asynchronous jobs.

## Frontend

The UI is intentionally small. A reviewer can:

1. Select a student.
2. Select a trial class and see remaining seats.
3. Create a booking.
4. Select mock payment success/failure.
5. See the resulting booking status/message.
6. Refresh the confirmed roster.

## Seed Data

`npm run db:setup` creates synthetic data including:

- `Space Science — Trial`: 1/4 confirmed.
- `Math Explorers — Trial (3/4 full)`: 3/4 confirmed, suitable for the last-seat demonstration.
- `Robotics Lab — Trial`: 0/4 confirmed.
- `Full Science Lab — Trial (4/4 full)`: full-capacity case.
- Five synthetic students and parents.

No real personal information is used.

## Testing

Run:

```bash
npm test
```

The test suite covers:

- Successful booking/payment.
- Payment failure and no roster entry.
- Duplicate booking rejection.
- Full-capacity confirmation rejection.
- Three-confirmed-student final-seat behavior.
- Concurrent last-seat race with `Promise.all`.

The concurrency test asserts both API outcomes (`200` + `409`) and the final database invariant (`confirmedCount === 4` and exactly four confirmed bookings).

## How To Run

Requirements: Node.js 20+ and npm. Docker is optional; Stripe, Supabase, Firebase, AWS, and other paid services are not required.

```bash
npm install
npm run db:setup
npm test
npm run dev
```

Then open the Vite URL shown by the terminal, normally `http://localhost:5173`.

The API runs on `http://localhost:3000`.

### Run with Docker

Docker support is included as an alternative local-development path. The API container runs Prisma migrations against a persistent SQLite volume and seeds the database only when it is empty. The frontend is built into an nginx image, and nginx proxies `/api/*` to the API container.

Requirements: Docker Engine with Docker Compose v2 (`docker compose`).

Start the complete application:

```bash
docker compose up --build
```

Open the frontend at:

```text
http://localhost:5173
```

The API is also exposed directly at:

```text
http://localhost:3000/api/health
```

Run in the background:

```bash
docker compose up --build -d
```

View logs:

```bash
docker compose logs -f
```

Stop the application:

```bash
docker compose down
```

To remove the persistent demo SQLite volume and start with a fresh seeded database:

```bash
docker compose down -v
docker compose up --build
```

The Docker setup uses two containers:

```text
Browser
   |
   v
web :5173 (nginx + React static build)
   | /api/*
   v
api :3000 (Fastify + Prisma)
   |
   v
SQLite persistent Docker volume
```

For a clean database during development:

```bash
npm run db:reset
```

## Assumptions

- Authentication is intentionally omitted because it is not required by the assignment.
- Parent identity is represented by the selected student's parent in the synthetic dataset; no login/session system is needed.
- A booking row is single-use for a student/class. This stronger database constraint keeps the take-home model simple and prevents duplicate confirmed bookings.
- A mock payment failure is terminal for that booking. A future production flow could create a new payment attempt/retry lifecycle.
- Capacity is represented by a small integer counter on `TrialClass`, maintained transactionally with confirmed bookings.
- SQLite is used as requested and is suitable for this local take-home. It is not presented as a production multi-writer database architecture.

## Scope / What Was Deliberately Cut

Not implemented because they are outside the requested slice:

- Regular enrollment.
- Authentication/authorization.
- Real payment provider integration.
- Email/notifications.
- Admin role system.
- Cancellation UI/API.
- Background jobs.
- Analytics dashboards.
- Production multi-service infrastructure/orchestration beyond the included local Docker Compose setup.

## Monitoring After Release

For a production version I would monitor:

- Booking success rate.
- Payment failure rate and failure reasons.
- Class-full rejection rate.
- Duplicate booking attempts/conflicts.
- SQLite/transaction conflict rate during this architecture's lifetime.
- API latency and error rate.
- Payment confirmation failures.
- Confirmed roster count versus expected capacity invariants.

## What I Would Do With More Time

- Replace the mock payment boundary with an idempotent payment-provider integration.
- Introduce authentication and explicit parent/admin authorization.
- Add cancellation/refund semantics and payment retries.
- Add integration tests around provider callbacks/idempotency.
- Move to a production database suited to the expected write concurrency if the product requires it.
- Add structured observability and an operational reconciliation job.

## Time Spent

Time spent: approximately X hours (fill in the actual time before submission).

## AI Usage

See [AI_USAGE.md](AI_USAGE.md) for the required AI-use disclosure.
