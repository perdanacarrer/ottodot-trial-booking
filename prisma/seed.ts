import { PrismaClient, BookingStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.paymentAttempt.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.student.deleteMany();
  await prisma.parent.deleteMany();
  await prisma.trialClass.deleteMany();

  const parents = await Promise.all([
    prisma.parent.create({ data: { name: 'Alex Morgan', email: 'alex.morgan@example.test' } }),
    prisma.parent.create({ data: { name: 'Jamie Lee', email: 'jamie.lee@example.test' } }),
    prisma.parent.create({ data: { name: 'Taylor Kim', email: 'taylor.kim@example.test' } }),
    prisma.parent.create({ data: { name: 'Riley Chen', email: 'riley.chen@example.test' } }),
    prisma.parent.create({ data: { name: 'Jordan Patel', email: 'jordan.patel@example.test' } }),
  ]);

  const students = await Promise.all([
    prisma.student.create({ data: { name: 'Avery Morgan', parentId: parents[0].id } }),
    prisma.student.create({ data: { name: 'Blake Lee', parentId: parents[1].id } }),
    prisma.student.create({ data: { name: 'Casey Kim', parentId: parents[2].id } }),
    prisma.student.create({ data: { name: 'Drew Chen', parentId: parents[3].id } }),
    prisma.student.create({ data: { name: 'Emery Patel', parentId: parents[4].id } }),
  ]);

  const now = new Date();
  const available = await prisma.trialClass.create({
    data: {
      title: 'Space Science — Trial',
      startsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      capacity: 4,
      confirmedCount: 1,
    },
  });

  const finalSeat = await prisma.trialClass.create({
    data: {
      title: 'Math Explorers — Trial (3/4 full)',
      startsAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
      capacity: 4,
      confirmedCount: 3,
    },
  });

  await prisma.trialClass.create({
    data: {
      title: 'Robotics Lab — Trial',
      startsAt: new Date(now.getTime() + 72 * 60 * 60 * 1000),
      capacity: 4,
      confirmedCount: 0,
    },
  });

  const fullClass = await prisma.trialClass.create({
    data: {
      title: 'Full Science Lab — Trial (4/4 full)',
      startsAt: new Date(now.getTime() + 96 * 60 * 60 * 1000),
      capacity: 4,
      confirmedCount: 4,
    },
  });

  // Existing confirmed bookings demonstrate the 1-seat and 3-seat fixtures.
  await prisma.booking.create({
    data: { studentId: students[0].id, trialClassId: available.id, status: BookingStatus.confirmed },
  });
  await prisma.booking.createMany({
    data: [1, 2, 3].map((i) => ({
      studentId: students[i].id,
      trialClassId: finalSeat.id,
      status: BookingStatus.confirmed,
    })),
  });
  await prisma.booking.createMany({
    data: [0, 1, 2, 3].map((i) => ({
      studentId: students[i].id,
      trialClassId: fullClass.id,
      status: BookingStatus.confirmed,
    })),
  });

  console.log('Seed complete. Demo classes:');
  console.log(`available: ${available.id}`);
  console.log(`final-seat: ${finalSeat.id}`);
}

main().finally(() => prisma.$disconnect());
