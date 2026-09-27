export interface Student {
  id: string;
  name: string;
  parentName: string;
  parentEmail: string;
}

export interface TrialClassSummary {
  id: string;
  title: string;
  startsAt: string;
  capacity: number;
  confirmedCount: number;
  seatsRemaining: number;
}

export interface Booking {
  id: string;
  studentId: string;
  trialClassId: string;
  status: "pending_payment" | "confirmed" | "payment_failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export interface RosterEntry {
  bookingId: string;
  studentId: string;
  studentName: string;
  parentName: string;
  confirmedAt: string;
}

export interface Roster {
  trialClass: { id: string; title: string };
  capacity: number;
  confirmedCount: number;
  seatsRemaining: number;
  roster: RosterEntry[];
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) {
    throw new ApiError(body?.error?.code ?? "UNKNOWN_ERROR", body?.error?.message ?? "Something went wrong.");
  }
  return body as T;
}

export const api = {
  listStudents: () => fetch("/api/students").then((r) => handle<Student[]>(r)),
  listTrialClasses: () => fetch("/api/trial-classes").then((r) => handle<TrialClassSummary[]>(r)),
  getRoster: (trialClassId: string) => fetch(`/api/trial-classes/${trialClassId}/roster`).then((r) => handle<Roster>(r)),
  createBooking: (studentId: string, trialClassId: string) =>
    fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId, trialClassId }),
    }).then((r) => handle<Booking>(r)),
  pay: (bookingId: string, result: "success" | "failure") =>
    fetch(`/api/bookings/${bookingId}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result }),
    }).then((r) => handle<Booking>(r)),
};
