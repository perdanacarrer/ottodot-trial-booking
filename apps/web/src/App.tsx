import { useEffect, useState } from "react";
import { api, ApiError, type Booking, type Roster, type Student, type TrialClassSummary } from "./api.js";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const STATUS_LABEL: Record<Booking["status"], string> = {
  pending_payment: "Pending payment",
  confirmed: "Booking confirmed",
  payment_failed: "Payment failed",
  cancelled: "Cancelled",
};

export default function App() {
  const [students, setStudents] = useState<Student[]>([]);
  const [classes, setClasses] = useState<TrialClassSummary[]>([]);
  const [selectedStudentId, setSelectedStudentId] = useState<string>("");
  const [selectedClassId, setSelectedClassId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [booking, setBooking] = useState<Booking | null>(null);
  const [bookingMessage, setBookingMessage] = useState<{ kind: "success" | "error" | "pending"; text: string } | null>(
    null
  );
  const [bookingBusy, setBookingBusy] = useState(false);

  const [rosterClassId, setRosterClassId] = useState<string>("");
  const [roster, setRoster] = useState<Roster | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);

  async function refreshClasses() {
    const list = await api.listTrialClasses();
    setClasses(list);
  }

  useEffect(() => {
    (async () => {
      try {
        const [studentList, classList] = await Promise.all([api.listStudents(), api.listTrialClasses()]);
        setStudents(studentList);
        setClasses(classList);
        if (studentList.length > 0) setSelectedStudentId(studentList[0].id);
        if (classList.length > 0) {
          setSelectedClassId(classList[0].id);
          setRosterClassId(classList[0].id);
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load data.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleBook() {
    if (!selectedStudentId || !selectedClassId) return;
    setBookingBusy(true);
    setBookingMessage(null);
    setBooking(null);
    try {
      const created = await api.createBooking(selectedStudentId, selectedClassId);
      setBooking(created);
      setBookingMessage({
        kind: "pending",
        text: `${STATUS_LABEL[created.status]}. Choose a mock payment result below.`,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setBookingMessage({ kind: "error", text: describeError(err) });
      } else {
        setBookingMessage({ kind: "error", text: "Something went wrong creating the booking." });
      }
    } finally {
      setBookingBusy(false);
    }
  }

  async function handlePay(result: "success" | "failure") {
    if (!booking) return;
    setBookingBusy(true);
    try {
      const updated = await api.pay(booking.id, result);
      setBooking(updated);
      if (updated.status === "confirmed") {
        setBookingMessage({ kind: "success", text: `${STATUS_LABEL[updated.status]}! The seat has been reserved.` });
      } else if (updated.status === "payment_failed") {
        setBookingMessage({
          kind: "error",
          text:
            result === "failure"
              ? `${STATUS_LABEL[updated.status]}: payment was declined (simulated). This booking was not added to the confirmed roster.`
              : `${STATUS_LABEL[updated.status]}: the seat was no longer available by the time payment was processed.`,
        });
      } else {
        setBookingMessage({ kind: "pending", text: `Booking status: ${STATUS_LABEL[updated.status]}.` });
      }
      await refreshClasses();
      if (updated.trialClassId === rosterClassId) {
        await loadRoster(rosterClassId);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setBookingMessage({ kind: "error", text: describeError(err) });
        // Booking status changed server-side (e.g. payment_failed); re-sync class seat counts.
        await refreshClasses();
      } else {
        setBookingMessage({ kind: "error", text: "Something went wrong recording payment." });
      }
    } finally {
      setBookingBusy(false);
    }
  }

  async function loadRoster(classId: string) {
    setRosterLoading(true);
    try {
      const r = await api.getRoster(classId);
      setRoster(r);
    } catch {
      setRoster(null);
    } finally {
      setRosterLoading(false);
    }
  }

  useEffect(() => {
    if (rosterClassId) loadRoster(rosterClassId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rosterClassId]);

  // Keep the "Admin / teacher" roster section following whatever trial
  // class the parent has highlighted in step 2, so the confirmed-seats
  // view is always in sync with the class currently being booked into.
  // The roster dropdown remains manually changeable too (e.g. to peek at
  // a different class's roster), it just resets to follow step 2 again
  // the next time a different class is selected there.
  useEffect(() => {
    if (selectedClassId) setRosterClassId(selectedClassId);
  }, [selectedClassId]);

  function describeError(err: ApiError): string {
    switch (err.code) {
      case "CLASS_FULL":
        return "This trial class is full - no seats remaining.";
      case "DUPLICATE_BOOKING":
        return "This student already has a confirmed booking for this trial class.";
      case "ALREADY_CONFIRMED":
        return "This booking is already confirmed.";
      default:
        return err.message;
    }
  }

  if (loading) return <p style={{ padding: 24 }}>Loading…</p>;
  if (loadError) {
    return (
      <div style={{ padding: 24 }}>
        <p className="status-banner error">Could not reach the API: {loadError}</p>
        <p className="empty-note">Is the API running on http://localhost:4000?</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Ottodot Trial Booking</h1>
      <p className="subtitle">Book a trial class for your child, pay (mocked), and see the confirmed roster.</p>

      <div className="card">
        <h2>1. Choose a child</h2>
        <label className="field-label" htmlFor="student-select">
          Student
        </label>
        <select id="student-select" value={selectedStudentId} onChange={(e) => setSelectedStudentId(e.target.value)}>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} (parent: {s.parentName})
            </option>
          ))}
        </select>
      </div>

      <div className="card">
        <h2>2. Choose a trial class</h2>
        <div className="class-list">
          {classes.map((c) => {
            const full = c.seatsRemaining <= 0;
            return (
              <div
                key={c.id}
                className={`class-option ${selectedClassId === c.id ? "selected" : ""} ${full ? "full" : ""}`}
                onClick={() => !full && setSelectedClassId(c.id)}
              >
                <div>
                  <div className="class-title">{c.title}</div>
                  <div className="class-meta">{formatDate(c.startsAt)}</div>
                </div>
                <span className={`seats-badge ${full ? "full" : ""}`}>
                  {full ? "Full" : `${c.seatsRemaining} / ${c.capacity} seats left`}
                </span>
              </div>
            );
          })}
        </div>

        <div className="actions">
          <button
            className="primary"
            disabled={bookingBusy || !selectedStudentId || !selectedClassId}
            onClick={handleBook}
          >
            {bookingBusy ? "Working…" : "Create booking"}
          </button>
        </div>
      </div>

      {(booking || bookingMessage) && (
        <div className="card">
          <h2>3. Payment &amp; status</h2>
          {bookingMessage && (
            <div className={`status-banner ${bookingMessage.kind}`}>{bookingMessage.text}</div>
          )}
          {booking && booking.status === "pending_payment" && (
            <div className="actions">
              <button className="success" disabled={bookingBusy} onClick={() => handlePay("success")}>
                Simulate payment success
              </button>
              <button className="danger" disabled={bookingBusy} onClick={() => handlePay("failure")}>
                Simulate payment failure
              </button>
            </div>
          )}
        </div>
      )}

      <hr className="section-divider" />

      <div className="card">
        <h2>Admin / teacher: trial class roster</h2>
        <p className="empty-note" style={{ marginTop: -4 }}>
          Follows the trial class selected in step 2 - change it here to peek at a different class.
        </p>
        <label className="field-label" htmlFor="roster-select">
          Trial class
        </label>
        <select id="roster-select" value={rosterClassId} onChange={(e) => setRosterClassId(e.target.value)}>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>

        {rosterLoading && <p className="empty-note">Loading roster…</p>}
        {!rosterLoading && roster && (
          <>
            <p className="empty-note">
              {roster.confirmedCount} / {roster.capacity} confirmed seats filled
            </p>
            {roster.roster.length === 0 ? (
              <p className="empty-note">No confirmed students yet.</p>
            ) : (
              <ul className="roster-list">
                {roster.roster.map((r) => (
                  <li key={r.bookingId}>
                    <strong>{r.studentName}</strong> — parent: {r.parentName} — confirmed {formatDate(r.confirmedAt)}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
