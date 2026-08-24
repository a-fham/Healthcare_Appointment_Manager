import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Timer, CheckCircle2 } from 'lucide-react';
import { api } from '../api.js';
import ConfirmDialog from '../Confirm.jsx';

const SEVERITIES = [
  { value: 'mild',     label: 'Mild , noticeable but manageable' },
  { value: 'moderate', label: 'Moderate , affecting my day' },
  { value: 'severe',   label: 'Severe , hard to ignore' },
];

function useCountdown(expiresAt) {
  const [left, setLeft] = useState(null); // null until first real measurement
  useEffect(() => {
    if (!expiresAt) return undefined;
    const tick = () => setLeft(Math.max(0, new Date(expiresAt).getTime() - Date.now()));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [expiresAt]);
  return left;
}

function fmt(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/* Step indicator , purely visual, no logic */
function Steps({ hasHold, confirmed }) {
  return (
    <div className="steps" style={{ marginBottom: 24 }}>
      <div className={`step ${!hasHold && !confirmed ? 'active' : 'done'}`}>
        <span className="step-num">1</span>
        <span>Pick a slot</span>
      </div>
      <div className="step-line" />
      <div className={`step ${hasHold && !confirmed ? 'active' : confirmed ? 'done' : ''}`}>
        <span className="step-num">2</span>
        <span>Describe symptoms</span>
      </div>
      <div className="step-line" />
      <div className={`step ${confirmed ? 'active' : ''}`}>
        <span className="step-num">3</span>
        <span>Confirmed</span>
      </div>
    </div>
  );
}

export default function BookSymptomsPage() {
  const { doctorId } = useParams();

  const [doctor, setDoctor] = useState(null);
  const [date, setDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [slots, setSlots] = useState(null);
  const [selected, setSelected] = useState(null); // 'YYYY-MM-DD HH:MM'

  const [hold, setHold] = useState(null); // { appointmentId, expiresAt }
  const [form, setForm] = useState({ symptomsText: '', severity: 'mild', durationText: '' });
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [gridNonce, setGridNonce] = useState(0);

  useEffect(() => {
    api.get(`/api/doctors/${doctorId}`).then((d) => setDoctor(d.doctor)).catch((e) => setError(e.message));
  }, [doctorId]);

  useEffect(() => {
    if (hold) return;
    setSelected(null);
    setSlots(null);
    api
      .get(`/api/doctors/${doctorId}/slots?date=${date}`)
      .then((d) => setSlots(d.slots))
      .catch((e) => {
        setError(e.message);
        setSlots([]);
      });
  }, [doctorId, date, hold, gridNonce]);

  async function holdSlot(time) {
    setError('');
    setBusy(true);
    try {
      const d = await api.post(`/api/doctors/${doctorId}/slots/hold`, { scheduledAt: `${date} ${time}` });
      const appt = d.appointment ?? d;
      setHold({ appointmentId: appt.id ?? appt.appointmentId, expiresAt: appt.expiresAt });
      setSelected(`${date} ${time}`);
    } catch (err) {
      setError(
        err.code === 'SLOT_TAKEN'
          ? 'That slot was just taken, please pick another.'
          : err.message,
      );
      if (err.code === 'SLOT_TAKEN') setGridNonce((n) => n + 1); // refresh grid, that slot is gone
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setError('');
    setBusy(true);
    try {
      await api.post(`/api/appointments/${hold.appointmentId}/confirm`, form);
      setConfirmed(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function releaseHold() {
    if (!hold) return;
    try {
      await api.del(`/api/appointments/${hold.appointmentId}`);
    } catch {
      /* sweeper will expire it anyway */
    }
    setReleasing(false);
    setHold(null);
    setSelected(null);
  }

  const msLeft = useCountdown(hold?.expiresAt);
  const expired = hold && !confirmed && msLeft !== null && msLeft <= 0;

  useEffect(() => {
    if (expired && !busy) {
      setHold(null);
      setError('Your hold expired. Please pick a slot again.');
    }
  }, [expired, busy]);

  const openCount = useMemo(() => (slots ?? []).filter((s) => s.status === 'open').length, [slots]);

  if (confirmed) {
    return (
      <div>
        <Steps hasHold confirmed />
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <CheckCircle2
            size={48}
            color="var(--spruce)"
            style={{ marginBottom: 16 }}
            strokeWidth={1.5}
          />
          <h2 style={{ marginBottom: 8 }}>You're all booked</h2>
          <p className="muted" style={{ margin: '0 auto 24px', maxWidth: 360 }}>
            {doctor?.name} will see your summary before your visit on{' '}
            <strong>{selected}</strong>.
          </p>
          <Link className="btn" to="/my">
            View my appointments
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Steps hasHold={Boolean(hold)} confirmed={false} />

      <div className="card">
        <div style={{ marginBottom: 16 }}>
          <h2 style={{ marginBottom: 2 }}>Book with {doctor ? doctor.name : '…'}</h2>
          {doctor && <span className="chip neutral">{doctor.specialisation}</span>}
        </div>

        <label htmlFor="date" style={{ marginTop: 0 }}>Pick a day</label>
        <input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />

        {!slots && <p className="muted" style={{ marginTop: 12 }}>Loading slots…</p>}
        {slots && (
          <>
            <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
              {openCount === 0
                ? 'No open slots this day. Leave days and booked times are greyed out.'
                : `${openCount} open slot${openCount === 1 ? '' : 's'} available`}
            </p>
            <div className="slot-grid">
              {(slots ?? []).map((s) => (
                <button
                  key={s.startsAt}
                  type="button"
                  disabled={s.status !== 'open' || Boolean(hold)}
                  className={[
                    'slot-btn',
                    s.status,
                    selected?.endsWith(s.startsAt) ? 'selected' : '',
                  ].join(' ')}
                  onClick={() => holdSlot(s.startsAt)}
                >
                  {s.startsAt}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {hold && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
            <div>
              <h3 style={{ margin: 0 }}>Your slot is held</h3>
              <p className="muted" style={{ margin: '3px 0 0' }}>
                {selected} , complete the form before time runs out.
              </p>
            </div>
            <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
              <span className="hold-timer">
                <Timer size={15} />
                {msLeft === null ? '…' : fmt(msLeft)}
              </span>
              <button type="button" className="btn danger" onClick={() => setReleasing(true)}>
                Release
              </button>
            </div>
          </div>

          <hr className="divider" />

          <label htmlFor="symptoms" style={{ marginTop: 0 }}>What's bothering you?</label>
          <textarea
            id="symptoms"
            value={form.symptomsText}
            onChange={(e) => setForm({ ...form, symptomsText: e.target.value })}
          />

          <label htmlFor="severity">How bad does it feel?</label>
          <select
            id="severity"
            value={form.severity}
            onChange={(e) => setForm({ ...form, severity: e.target.value })}
          >
            {SEVERITIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>

          <label htmlFor="duration">How long has it been going on?</label>
          <input
            id="duration"
            value={form.durationText}
            onChange={(e) => setForm({ ...form, durationText: e.target.value })}
          />

          {error && <p className="error-box">{error}</p>}

          <p style={{ marginTop: 20, marginBottom: 6 }}>
            <button type="button" className="btn" disabled={busy || expired} onClick={confirm}>
              Confirm booking
            </button>
          </p>
          <p className="muted" style={{ marginTop: 4, fontSize: '0.82rem' }}>
            A short summary is prepared for the doctor , decision support only, never a diagnosis.
          </p>
        </div>
      )}

      {!hold && error && <p className="error-box">{error}</p>}

      <ConfirmDialog
        open={releasing}
        title="Release this slot?"
        message="Your hold on the chosen time is dropped and someone else can take it. Your form answers stay until you pick again."
        confirmLabel="Yes, release slot"
        danger
        onConfirm={releaseHold}
        onCancel={() => setReleasing(false)}
      />
    </div>
  );
}
