# AI Usage

## AI Tools Used

- Claude

## What AI Was Used For

AI assistance was used for:

- Project scaffolding.
- Implementation assistance for the Fastify/Prisma/React structure.
- Test generation and edge-case coverage.
- Code review and concurrency reasoning.
- README and AI usage documentation.
- Thinking through duplicate booking, payment failure, capacity, and last-seat behavior.

The final implementation was reviewed against the Ottodot assignment requirements and verified with the local automated test suite.

## Where AI Helped Me Move Faster

A concrete example was scaffolding the API routes, Prisma schema, seed data, and Vitest structure so the limited take-home time could be spent on the correctness-critical booking transaction and tests rather than repetitive project setup.

## Where I Disagreed With / Corrected AI

The important engineering correction was around the last-seat race. A naive implementation that first reads the confirmed count and then separately inserts a confirmed booking is not sufficient: two concurrent requests can both observe the final seat before either request writes.

The implementation therefore uses an atomic conditional `UPDATE` of `confirmedCount` inside the transaction as the seat-allocation gate. The test also exercises the competing confirmations concurrently rather than relying on sequential calls.

This is documented as an engineering review/correction decision rather than a claim that a particular AI-generated race bug was observed in production.

## How I Verified The Final Implementation

Verification includes:

- Automated Vitest suite.
- Successful booking/payment test.
- Payment failure test asserting `payment_failed`, failed payment attempt, and no confirmed roster entry.
- Duplicate booking test.
- Full-capacity test.
- Concurrent last-seat test using `Promise.all`, followed by a database assertion of the final confirmed count.
- TypeScript/API build checks.
- React production build.
- Manual local walkthrough through the minimal UI.
