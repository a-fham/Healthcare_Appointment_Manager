import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import ConfirmDialog from '../Confirm.jsx';

const emptyMed = () => ({ name: '', dosage: '', times: '08:00', durationDays: '' });

export default function VisitNotesPage() {
  const { appointmentId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const [item, setItem] = useState(null);
  const [notes, setNotes] = useState('');
  const [meds, setMeds] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    // The queue page passes the full row (with pre-visit context) via router
    // state , the bare queue endpoint only covers today, so a non-today
    // appointment would otherwise be "not found".
    const preloaded = location.state?.item;
    if (preloaded && preloaded.id === appointmentId) {
      setItem(preloaded);
      return undefined;
    }
    // Direct URL entry: fall back to today's queue (works for today's rows).
    api
      .get('/api/doctors/me/queue')
      .then((d) => {
        const found = d.queue.find((q) => q.id === appointmentId);
        if (!found) throw new Error('Appointment not found in your queue.');
        setItem(found);
      })
      .catch((e) => setError(e.message));
    return undefined;
  }, [appointmentId, location.state]);

  function setMed(i, key, value) {
    setMeds(meds.map((m, idx) => (idx === i ? { ...m, [key]: value } : m)));
  }

  async function submit() {
    setError('');
    setBusy(true);
    try {
      const prescription = meds
        .filter((m) => m.name.trim())
        .map((m) => ({
          name: m.name.trim(),
          dosage: m.dosage.trim(),
          times: m.times.split(',').map((t) => t.trim()).filter(Boolean),
          durationDays: Number(m.durationDays),
        }));
      await api.post(`/api/appointments/${appointmentId}/notes`, {
        clinicalNotes: notes,
        prescription,
      });
      navigate(`/queue?date=${item.scheduledAt.slice(0, 10)}`, {
        state: { flash: `Visit recorded for ${item.patientName}. Their summary is being prepared.` },
      });
    } catch (err) {
      setError(err.message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  if (error && !item) return <p className="error-box">{error}</p>;
  if (!item) return <p className="muted">Loading…</p>;

  return (
    <div>
      <div className="page-header">
        <h1>Visit notes</h1>
        <p className="muted">{item.scheduledAt} · {item.patientName}</p>
      </div>

      <div className="info-block">
        <p className="info-block-label">Pre-visit summary</p>

        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <span className={`chip ${item.urgency ?? 'neutral'}`}>
            {item.urgency
              ? `${item.urgency.charAt(0).toUpperCase() + item.urgency.slice(1)} urgency`
              : 'Triage pending'}
          </span>
          {item.severity && (
            <span className="chip neutral">{item.severity}</span>
          )}
        </div>

        {item.chiefComplaint && (
          <p style={{ margin: '0 0 8px', fontWeight: 600 }}>
            {item.chiefComplaint}
          </p>
        )}

        {item.questions?.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <p style={{ margin: '0 0 4px', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>
              Suggested questions
            </p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {item.questions.map((q, i) => (
                <li key={i} style={{ marginBottom: 2 }}>{q}</li>
              ))}
            </ul>
          </div>
        )}

        {item.symptoms && (
          <p className="muted" style={{ margin: 0, fontStyle: 'italic', fontSize: '0.88rem' }}>
            Patient's words: "{item.symptoms}"
          </p>
        )}
      </div>

      <div className="card">
        <label htmlFor="notes" style={{ marginTop: 0 }}>Clinical notes</label>
        <textarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <div style={{ marginTop: 20 }}>
          <h3 style={{ marginBottom: 2 }}>Prescription</h3>
          <p className="muted" style={{ marginTop: 0, marginBottom: 14 }}>
            Times of day drive the patient's medication reminders.
          </p>

          {meds.map((m, i) => (
            <div
              key={i}
              className="row"
              style={{ marginBottom: 8, flexWrap: 'nowrap', gap: 8 }}
            >
              <input
                value={m.name}
                onChange={(e) => setMed(i, 'name', e.target.value)}
                style={{ flex: 2, margin: 0 }}
              />
              <input
                value={m.dosage}
                onChange={(e) => setMed(i, 'dosage', e.target.value)}
                style={{ flex: 1, margin: 0 }}
              />
              <input
                value={m.times}
                onChange={(e) => setMed(i, 'times', e.target.value)}
                style={{ flex: 1.2, margin: 0 }}
              />
              <input
                type="number"
                min="1"
                max="365"
                value={m.durationDays}
                onChange={(e) => setMed(i, 'durationDays', e.target.value)}
                style={{ flex: 0.7, margin: 0 }}
              />
              <button
                type="button"
                className="btn danger"
                style={{ padding: '9px 12px', flexShrink: 0 }}
                onClick={() => setMeds(meds.filter((_, x) => x !== i))}
              >
                ✕
              </button>
            </div>
          ))}

          <button
            type="button"
            className="btn secondary"
            style={{ marginTop: 6 }}
            onClick={() => setMeds([...meds, emptyMed()])}
          >
            + Add medication
          </button>
        </div>

        {error && <p className="error-box">{error}</p>}

        <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--mint-line)' }}>
          <button
            type="button"
            className="btn"
            disabled={busy || !notes.trim()}
            onClick={() => setConfirming(true)}
          >
            Complete visit…
          </button>
          <p className="muted" style={{ marginTop: 10, marginBottom: 0, fontSize: '0.82rem' }}>
            Saving closes the appointment and starts preparing the patient's plain-language summary.
            Notes can only be recorded once.
          </p>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Complete this visit?"
        message={`This closes the appointment for ${item?.patientName ?? ''}, queues medication reminders, and locks the notes. They cannot be edited afterwards.`}
        confirmLabel="Yes, complete visit"
        busy={busy}
        onConfirm={submit}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
