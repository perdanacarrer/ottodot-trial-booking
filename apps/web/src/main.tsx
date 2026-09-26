import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Student = { id: string; name: string; parent: { name: string; email: string } };
type TrialClass = { id: string; title: string; startsAt: string; capacity: number; confirmedCount: number; remainingSeats: number };
type Booking = { id: string; status: string; student: Student; trialClass: TrialClass };
type Roster = { trialClass: Pick<TrialClass, 'id' | 'title' | 'startsAt' | 'capacity'>; confirmedCount: number; roster: { bookingId: string; studentId: string; studentName: string; status: string }[] };

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

const apiUrl = (path: string) => {
  if (API_BASE_URL === '/api') return `${API_BASE_URL}${path.replace(/^\/api/, '')}`;
  return `${API_BASE_URL}${path}`;
};

const api = async <T,>(path: string, options?: RequestInit): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    throw new Error('Cannot reach the API. If using Docker, run: docker compose ps && docker compose logs api');
  }

  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `API request failed (${response.status})`);
  }
  return body as T;
};

function App() {
  const [students, setStudents] = React.useState<Student[]>([]);
  const [classes, setClasses] = React.useState<TrialClass[]>([]);
  const [studentId, setStudentId] = React.useState('');
  const [classId, setClassId] = React.useState('');
  const [booking, setBooking] = React.useState<Booking | null>(null);
  const [paymentResult, setPaymentResult] = React.useState<'success' | 'failure'>('success');
  const [roster, setRoster] = React.useState<Roster | null>(null);
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const [studentData, classData] = await Promise.all([
      api<Student[]>('/api/students'),
      api<TrialClass[]>('/api/trial-classes'),
    ]);
    setStudents(studentData);
    setClasses(classData);
    if (!studentId && studentData[0]) setStudentId(studentData[0].id);
    if (!classId && classData[0]) setClassId(classData[0].id);
  }, [classId, studentId]);

  React.useEffect(() => {
    let cancelled = false;
    const run = async () => {
      for (let attempt = 0; attempt < 3 && !cancelled; attempt += 1) {
        try {
          await load();
          return;
        } catch (e) {
          if (attempt === 2 && !cancelled) setMessage((e as Error).message);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [load]);

  const createBooking = async () => {
    setBusy(true); setMessage('');
    try {
      const result = await api<Booking>('/api/bookings', {
        method: 'POST', body: JSON.stringify({ studentId, trialClassId: classId }),
      });
      setBooking(result);
      setMessage('Booking created. Choose a mock payment result.');
      await load();
    } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  };

  const pay = async () => {
    if (!booking) return;
    setBusy(true); setMessage('');
    try {
      const result = await api<{ booking: Booking; payment: { status: string; failureReason?: string } }>(`/api/bookings/${booking.id}/pay`, {
        method: 'POST', body: JSON.stringify({ result: paymentResult }),
      });
      setBooking((current) => current ? { ...current, ...result.booking } : current);
      setMessage(result.payment.status === 'succeeded' ? 'Booking confirmed.' : `Payment failed: ${result.payment.failureReason ?? 'MOCK_PAYMENT_FAILED'}`);
      await load();
      await viewRoster();
    } catch (e) { setMessage((e as Error).message); await load(); } finally { setBusy(false); }
  };

  const viewRoster = async () => {
    if (!classId) return;
    try { setRoster(await api<Roster>(`/api/trial-classes/${classId}/roster`)); }
    catch (e) { setMessage((e as Error).message); }
  };

  return <main className="page">
    <header><div><span className="eyebrow">OTTODOT</span><h1>Trial booking</h1><p>Small demo of a concurrency-safe trial booking flow.</p></div></header>
    <section className="grid">
      <div className="card">
        <h2>1. Choose student & class</h2>
        <label>Student<select value={studentId} onChange={(e) => setStudentId(e.target.value)}>{students.map(s => <option key={s.id} value={s.id}>{s.name} — {s.parent.name}</option>)}</select></label>
        <label>Trial class<select value={classId} onChange={(e) => setClassId(e.target.value)}>{classes.map(c => <option key={c.id} value={c.id}>{c.title} · {c.remainingSeats}/{c.capacity} seats</option>)}</select></label>
        <button disabled={busy || !studentId || !classId} onClick={createBooking}>Create booking</button>
      </div>
      <div className="card">
        <h2>2. Mock payment</h2>
        <div className="status">{booking ? <><strong>{booking.status}</strong><span>Booking {booking.id.slice(0, 8)}…</span></> : <span>No pending booking</span>}</div>
        <div className="payment-row"><button className={paymentResult === 'success' ? 'selected' : ''} onClick={() => setPaymentResult('success')}>Success</button><button className={paymentResult === 'failure' ? 'selected' : ''} onClick={() => setPaymentResult('failure')}>Failure</button></div>
        <button disabled={busy || !booking || booking.status !== 'pending_payment'} onClick={pay}>Submit payment</button>
      </div>
    </section>
    {message && <div className="message">{message}</div>}
    <section className="card">
      <div className="row"><div><h2>3. Trial roster</h2><p className="muted">The roster only contains confirmed students.</p></div><button className="secondary" onClick={viewRoster}>Refresh roster</button></div>
      {roster ? <><div className="capacity"><strong>{roster.confirmedCount}/{roster.trialClass.capacity}</strong><span>confirmed</span></div><ul className="roster">{roster.roster.map(r => <li key={r.bookingId}><span>{r.studentName}</span><small>{r.status}</small></li>)}</ul></> : <p className="muted">Select a class and refresh to view its roster.</p>}
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
