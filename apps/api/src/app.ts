import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { BookingStatus, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

const bookingInput = z.object({
  studentId: z.string().min(1),
  trialClassId: z.string().min(1),
});

const paymentInput = z.object({
  result: z.enum(['success', 'failure']),
});

export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  STUDENT_NOT_FOUND: 'STUDENT_NOT_FOUND',
  CLASS_NOT_FOUND: 'CLASS_NOT_FOUND',
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  DUPLICATE_BOOKING: 'DUPLICATE_BOOKING',
  INVALID_BOOKING_STATUS: 'INVALID_BOOKING_STATUS',
  CLASS_FULL: 'CLASS_FULL',
} as const;

class ApiError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

function isRetryableSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

async function withSqliteWriteRetry<T>(operation: () => Promise<T>, attempts = 6): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableSqliteError(error) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
  throw lastError;
}

export function buildApp(prisma: PrismaClient): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(cors, { origin: true });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }

    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: { code: ERROR_CODES.VALIDATION_ERROR, message: error.issues.map((i) => i.message).join(', ') },
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return reply.status(409).send({
        error: {
          code: ERROR_CODES.DUPLICATE_BOOKING,
          message: 'Student already has a booking for this trial class.',
        },
      });
    }

    app.log.error(error);
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/api/students', async () => {
    return prisma.student.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, parent: { select: { id: true, name: true, email: true } } },
    });
  });

  app.get('/api/trial-classes', async () => {
    const classes = await prisma.trialClass.findMany({ orderBy: { startsAt: 'asc' } });
    return classes.map((trialClass) => ({
      ...trialClass,
      remainingSeats: Math.max(0, trialClass.capacity - trialClass.confirmedCount),
    }));
  });

  app.get('/api/trial-classes/:id', async (request) => {
    const { id } = request.params as { id: string };
    const trialClass = await prisma.trialClass.findUnique({ where: { id } });
    if (!trialClass) throw new ApiError(404, ERROR_CODES.CLASS_NOT_FOUND, 'Trial class not found.');
    return {
      ...trialClass,
      remainingSeats: Math.max(0, trialClass.capacity - trialClass.confirmedCount),
    };
  });

  app.get('/api/trial-classes/:id/roster', async (request) => {
    const { id } = request.params as { id: string };
    const trialClass = await prisma.trialClass.findUnique({ where: { id } });
    if (!trialClass) throw new ApiError(404, ERROR_CODES.CLASS_NOT_FOUND, 'Trial class not found.');

    const bookings = await prisma.booking.findMany({
      where: { trialClassId: id, status: BookingStatus.confirmed },
      orderBy: { createdAt: 'asc' },
      include: { student: true },
    });

    return {
      trialClass: {
        id: trialClass.id,
        title: trialClass.title,
        startsAt: trialClass.startsAt,
        capacity: trialClass.capacity,
      },
      confirmedCount: bookings.length,
      roster: bookings.map((booking) => ({
        bookingId: booking.id,
        studentId: booking.studentId,
        studentName: booking.student.name,
        status: booking.status,
      })),
    };
  });

  app.post('/api/bookings', async (request, reply) => {
    const input = bookingInput.parse(request.body);

    const [student, trialClass] = await Promise.all([
      prisma.student.findUnique({ where: { id: input.studentId } }),
      prisma.trialClass.findUnique({ where: { id: input.trialClassId } }),
    ]);

    if (!student) throw new ApiError(404, ERROR_CODES.STUDENT_NOT_FOUND, 'Student not found.');
    if (!trialClass) throw new ApiError(404, ERROR_CODES.CLASS_NOT_FOUND, 'Trial class not found.');

    const existing = await prisma.booking.findUnique({
      where: { studentId_trialClassId: { studentId: input.studentId, trialClassId: input.trialClassId } },
    });
    if (existing) {
      throw new ApiError(409, ERROR_CODES.DUPLICATE_BOOKING, 'Student already has a booking for this trial class.');
    }

    const booking = await prisma.booking.create({
      data: { studentId: input.studentId, trialClassId: input.trialClassId, status: BookingStatus.pending_payment },
      include: { student: true, trialClass: true },
    });

    return reply.status(201).send(booking);
  });

  app.get('/api/bookings/:id', async (request) => {
    const { id } = request.params as { id: string };
    const booking = await prisma.booking.findUnique({
      where: { id },
      include: {
        student: true,
        trialClass: true,
        paymentAttempts: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!booking) throw new ApiError(404, ERROR_CODES.BOOKING_NOT_FOUND, 'Booking not found.');
    return booking;
  });

  app.post('/api/bookings/:id/pay', async (request) => {
    const { id } = request.params as { id: string };
    const input = paymentInput.parse(request.body);

    const booking = await prisma.booking.findUnique({ where: { id }, include: { trialClass: true } });
    if (!booking) throw new ApiError(404, ERROR_CODES.BOOKING_NOT_FOUND, 'Booking not found.');
    if (booking.status !== BookingStatus.pending_payment) {
      throw new ApiError(409, ERROR_CODES.INVALID_BOOKING_STATUS, `Booking is ${booking.status} and cannot be paid.`);
    }

    if (input.result === 'failure') {
      const failed = await withSqliteWriteRetry(() => prisma.$transaction(async (tx) => {
        const current = await tx.booking.findUnique({ where: { id } });
        if (!current || current.status !== BookingStatus.pending_payment) {
          throw new ApiError(409, ERROR_CODES.INVALID_BOOKING_STATUS, 'Booking is no longer awaiting payment.');
        }
        await tx.paymentAttempt.create({ data: { bookingId: id, status: 'failed', failureReason: 'MOCK_PAYMENT_FAILED' } });
        return tx.booking.update({ where: { id }, data: { status: BookingStatus.payment_failed } });
      }));
      return { booking: failed, payment: { status: 'failed', failureReason: 'MOCK_PAYMENT_FAILED' } };
    }

    const result = await withSqliteWriteRetry(() => prisma.$transaction(async (tx) => {
      const current = await tx.booking.findUnique({ where: { id } });
      if (!current || current.status !== BookingStatus.pending_payment) {
        throw new ApiError(409, ERROR_CODES.INVALID_BOOKING_STATUS, 'Booking is no longer awaiting payment.');
      }

      // This single conditional UPDATE is the seat-allocation gate. SQLite serializes writers,
      // so concurrent confirmations cannot both increment the final available seat.
      const seatUpdate = await tx.$executeRaw`
        UPDATE "TrialClass"
        SET "confirmedCount" = "confirmedCount" + 1
        WHERE "id" = ${booking.trialClassId}
          AND "confirmedCount" < "capacity"
      `;

      if (seatUpdate !== 1) {
        await tx.paymentAttempt.create({
          data: { bookingId: id, status: 'failed', failureReason: ERROR_CODES.CLASS_FULL },
        });
        const failedBooking = await tx.booking.update({
          where: { id },
          data: { status: BookingStatus.payment_failed },
        });
        return {
          booking: failedBooking,
          payment: { status: 'failed' as const, failureReason: ERROR_CODES.CLASS_FULL },
          full: true,
        };
      }

      const confirmed = await tx.booking.update({ where: { id }, data: { status: BookingStatus.confirmed } });
      await tx.paymentAttempt.create({ data: { bookingId: id, status: 'succeeded' } });
      return { booking: confirmed, payment: { status: 'succeeded' as const }, full: false };
    }));

    if (result.full) {
      throw new ApiError(409, ERROR_CODES.CLASS_FULL, 'The trial class became full before payment confirmation.');
    }

    return result;
  });

  return app;
}
