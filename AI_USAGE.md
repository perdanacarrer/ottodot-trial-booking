# AI Usage

## AI Tools Used

Claude (Anthropic) — used as an agentic coding assistant with direct access
to a sandboxed development environment (able to write files, run shell
commands, install dependencies, run tests, and iterate on failures).

## What AI Was Used For

- **Project scaffolding:** monorepo layout, npm workspaces, TypeScript
  configs, Fastify server setup, Vite + React setup.
- **Implementation assistance:** the booking service, routes, SQL schema
  (including the partial unique index), and the React UI.
- **Test generation:** the full Vitest suite, including the mandatory
  concurrent last-seat race test.
- **Code review / self-review:** re-reading the concurrency logic multiple
  times against the assignment's explicit race-condition scenario before
  considering it done.
- **Documentation:** this file and README.md.
- **Edge-case analysis:** working through exactly what should happen at each
  step of the payment flow (success, failure, and the "seat taken while
  pending" case) before writing code, not after.

## Where AI Helped Me Move Faster

Standing up the entire skeleton — Fastify app, route wiring, Zod validation,
error handling, the SQL schema, and a full Vitest suite with realistic
fixtures — happened in one continuous pass instead of the usual back-and-forth
of writing boilerplate by hand. That freed essentially all of the time budget
for the part that actually matters here: getting the concurrency guarantee
right and proving it with a real test.

## Where I Disagreed With / Corrected AI

Two concrete corrections, both about not overclaiming:

1. **The first draft used Prisma with a naive `await`-based check-then-write
   for the payment confirmation step** — count confirmed bookings, then
   (in a separate awaited step) update the booking to `confirmed`. I flagged
   this as exactly the race the assignment warns about: two concurrent
   `await`-separated requests can both read `confirmedCount = 3` before
   either writes, and both would then believe a seat is free. This was
   caught and fixed *before* it shipped, as an engineering review decision —
   I did not observe it actually double-book anyone in practice, because I
   rejected the approach on inspection rather than waiting to see it fail.
   The fix was to make the whole check-and-write sequence one synchronous,
   `await`-free critical section (see README's "Last-Seat Race Condition"
   section), backed by an application-level mutex in the first draft, later
   simplified further (see #2).

2. **Bigger correction: I dropped Prisma entirely partway through**, after
   discovering `prisma generate` could not fetch its native query-engine
   binary from my sandboxed environment's network. Rather than accept a
   Prisma-based implementation I hadn't actually been able to run, I rewrote
   the data layer on `better-sqlite3`. This wasn't purely a downgrade: it
   also let me delete an async-mutex abstraction I'd built to serialize the
   critical section for Prisma, because `better-sqlite3`'s synchronous API
   makes the same guarantee for free (a synchronous function has no
   `await` gap for a race to exploit, full stop). The simpler
   implementation is also the one I could fully verify.

I was careful, when documenting this, not to claim SQLite or
`better-sqlite3` provide stronger cross-process locking than they actually
do — the README explicitly calls out that the concurrency guarantee here is
per-process, and says what would need to change to scale beyond that.

## What I Would Change About My AI Workflow If I Did This Again

I'd try to establish "can the required toolchain actually execute in this
environment" *before* writing any implementation code — a five-minute
`prisma generate` smoke test up front would have caught the network
limitation before I'd written a schema and service layer against it,
instead of after.

## How I Verified The Final Implementation

- **Automated tests:** `npm test` runs the full Vitest suite — 10 tests
  across 3 files, all passing, including:
  - the duplicate-booking test (application-level rejection, plus a second
    test that bypasses the app layer to prove the database's partial
    unique index rejects it independently),
  - the payment-failure test (asserts the student never appears on the
    roster),
  - the capacity test (4/4 → rejection) and the 3/4 → success test,
  - the mandatory last-seat race test, run against **real concurrent HTTP
    requests** (two separate sockets via `fetch` + `Promise.all` against a
    live server on a random port, not sequential awaits or in-process
    function calls), for both 2 and 6 simultaneous contenders, with the
    final confirmed count re-queried directly from the database afterward.
- **Manual local walkthrough:** ran `npm run db:setup` then started the API
  directly and drove it with `curl` end to end — created a booking, paid
  successfully, confirmed a duplicate attempt was rejected, and fetched the
  roster — before considering the backend done. Also ran `npm run build` for
  both the API and the web app to confirm there are no TypeScript errors,
  and ran `npm run dev` to confirm both dev servers start and are reachable
  together (with the Vite proxy correctly forwarding `/api/*`).
