import { execFileSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, BookingStatus } from '@prisma/client';
import { buildApp } from '../apps/api/src/app.js';

const dbPath = resolve('/tmp/ottodot-vitest.db');
process.env.DATABASE_URL = `file:${dbPath}`;

let prisma: PrismaClient;

async function resetDb() {
  await prisma.paymentAttempt.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.student.deleteMany();
  await prisma.parent.deleteMany();
  await prisma.trialClass.deleteMany();
}

async function fixture() {
  const parent = await prisma.parent.create({ data: { name: 'Test Parent', email: `parent-${Date.now()}@example.test` } });
  const students = await Promise.all(
    ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((suffix) =>
      prisma.student.create({ data: { name: `Student ${suffix}`, parentId: parent.id } }),
    ),
  );
  const trialClass = await prisma.trialClass.create({
    data: { title: 'Concurrency Test Class', startsAt: new Date(Date.now() + 86_400_000), capacity: 4, confirmedCount: 0 },
  });
  return { students, trialClass };
}

async function createBooking(app: ReturnType<typeof buildApp>, studentId: string, trialClassId: string) {
  return app.inject({
    method: 'POST',
    url: '/api/bookings',
    payload: { studentId, trialClassId },
  });
}

async function pay(app: ReturnType<typeof buildApp>, bookingId: string, result: 'success' | 'failure') {
  return app.inject({
    method: 'POST',
    url: `/api/bookings/${bookingId}/pay`,
    payload: { result },
  });
}

describe('trial booking invariants', () => {
  beforeAll(async () => {
    try { unlinkSync(dbPath); } catch {}
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: resolve('.'),
      env: process.env,
      stdio: 'pipe',
    });
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  beforeEach(resetDb);
  afterAll(async () => {
    await prisma.$disconnect();
    try { unlinkSync(dbPath); } catch {}
  });

  it('confirms a successful booking and records successful payment', async () => {
    const { students, trialClass } = await fixture();
    const app = buildApp(prisma);

    const created = await createBooking(app, students[0].id, trialClass.id);
    expect(created.statusCode).toBe(201);

    const bookingId = created.json().id as string;
    const response = await pay(app, bookingId, 'success');
    expect(response.statusCode).toBe(200);
    expect(response.json().booking.status).toBe(BookingStatus.confirmed);

    const payment = await prisma.paymentAttempt.findFirst({ where: { bookingId } });
    const updatedClass = await prisma.trialClass.findUniqueOrThrow({ where: { id: trialClass.id } });
    expect(payment?.status).toBe('succeeded');
    expect(updatedClass.confirmedCount).toBe(1);
  });

  it('records payment failure without consuming a confirmed seat', async () => {
    const { students, trialClass } = await fixture();
    const app = buildApp(prisma);
    const created = await createBooking(app, students[0].id, trialClass.id);
    const response = await pay(app, created.json().id, 'failure');

    expect(response.statusCode).toBe(200);
    expect(response.json().booking.status).toBe(BookingStatus.payment_failed);
    expect(response.json().payment.status).toBe('failed');

    const updatedClass = await prisma.trialClass.findUniqueOrThrow({ where: { id: trialClass.id } });
    const roster = await prisma.booking.count({ where: { trialClassId: trialClass.id, status: BookingStatus.confirmed } });
    expect(updatedClass.confirmedCount).toBe(0);
    expect(roster).toBe(0);
  });

  it('prevents a duplicate booking for the same student and class', async () => {
    const { students, trialClass } = await fixture();
    const app = buildApp(prisma);
    const first = await createBooking(app, students[0].id, trialClass.id);
    expect(first.statusCode).toBe(201);
    expect((await pay(app, first.json().id, 'success')).statusCode).toBe(200);

    const duplicate = await createBooking(app, students[0].id, trialClass.id);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('DUPLICATE_BOOKING');
    expect(await prisma.booking.count({ where: { studentId: students[0].id, trialClassId: trialClass.id, status: BookingStatus.confirmed } })).toBe(1);
  });

  it('rejects confirmation when the class is already full', async () => {
    const { students, trialClass } = await fixture();
    await prisma.trialClass.update({ where: { id: trialClass.id }, data: { confirmedCount: 4 } });
    const app = buildApp(prisma);
    const created = await createBooking(app, students[0].id, trialClass.id);
    const response = await pay(app, created.json().id, 'success');

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CLASS_FULL');
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: created.json().id } });
    expect(booking.status).toBe(BookingStatus.payment_failed);
    expect(await prisma.booking.count({ where: { trialClassId: trialClass.id, status: BookingStatus.confirmed } })).toBe(0);
  });

  it('allows one and only one concurrent confirmation to consume the final seat', async () => {
    const { students, trialClass } = await fixture();
    await prisma.trialClass.update({ where: { id: trialClass.id }, data: { confirmedCount: 3 } });

    const prismaA = new PrismaClient();
    const prismaB = new PrismaClient();
    const appA = buildApp(prismaA);
    const appB = buildApp(prismaB);
    const [bookingA, bookingB] = await Promise.all([
      createBooking(appA, students[0].id, trialClass.id),
      createBooking(appB, students[1].id, trialClass.id),
    ]);
    expect(bookingA.statusCode).toBe(201);
    expect(bookingB.statusCode).toBe(201);

    const [payA, payB] = await Promise.all([
      pay(appA, bookingA.json().id, 'success'),
      pay(appB, bookingB.json().id, 'success'),
    ]);

    const statuses = [payA.statusCode, payB.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const confirmed = await prisma.booking.count({ where: { trialClassId: trialClass.id, status: BookingStatus.confirmed } });
    const finalClass = await prisma.trialClass.findUniqueOrThrow({ where: { id: trialClass.id } });
    expect(confirmed).toBe(4);
    expect(finalClass.confirmedCount).toBe(4);

    const failedPayments = await prisma.paymentAttempt.count({ where: { status: 'failed', failureReason: 'CLASS_FULL' } });
    expect(failedPayments).toBe(1);

    await Promise.all([appA.close(), appB.close(), prismaA.$disconnect(), prismaB.$disconnect()]);
  });
});
