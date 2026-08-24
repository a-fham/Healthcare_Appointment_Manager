import { useEffect, useState } from 'react';
import { api } from '../api.js';
import ConfirmDialog from '../Confirm.jsx';

function SummaryText({ md }) {
  const blocks = (md ?? '').split(/^##\s+/m).filter(Boolean);
  return (
    <div className="summary-md">
      {blocks.map((b, i) => {
        const [first, ...rest] = b.split('\n');
        return (
          <div key={i}>
            <b>{first.trim()}</b>
            <div>{rest.join('\n').trim()}</div>
          </div>
        );
      })}
    </div>
  );
}

function PrescriptionBlock({ meds }) {
  if (!meds || meds.length === 0) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <p style={{ margin: '0 0 6px', fontSize: '0.82rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>
        Medications
      </p>
      <table className="rx-table">
        <thead>
          <tr>
            <th>Medicine</th>
            <th>Dosage</th>
            <th>When</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {meds.map((m, i) => (
            <tr key={i}>
              <td>{m.name}</td>
              <td>{m.dosage || ','}</td>
              <td>{(m.times || []).join(', ')}</td>
              <td>{m.durationDays} day{m.durationDays !== 1 ? 's' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_LABEL = {
  confirmed:              'Confirmed',
  completed:              'Completed',
  held:                   'Held',
  cancelled_by_patient:   'Cancelled by you',
  cancelled_by_admin:     'Cancelled by clinic',
  cancelled_by_leave:     'Doctor unavailable',
  rescheduled:            'Rescheduled',
  expired:                'Hold expired',
};

function statusChipClass(status) {
  if (status.startsWith('cancelled') || status === 'expired') return 'high';
  if (status === 'completed') return 'low';
  return 'medium';
}

export default function MyAppointmentsPage() {
  const [appointments, setAppointments] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [cancelling, setCancelling] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get('/api/my/appointments')
      .then((d) => setAppointments(d.appointments))
      .catch((e) => setError(e.message));
  }, []);

  async function cancelConfirmed() {
    setBusy(true);
    setError('');
    try {
      await api.del(`/api/appointments/${cancelling.id}`);
      setAppointments((list) =>
        list.map((a) => (a.id === cancelling.id ? { ...a, status: 'cancelled_by_patient' } : a)),
      );
      setFlash(`Your ${cancelling.scheduledAt} visit with ${cancelling.doctorName} is cancelled.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setCancelling(null);
    }
  }

  if (error && !appointments) return <p className="error-box">{error}</p>;
  if (!appointments) return <p className="muted">Loading…</p>;

  if (appointments.length === 0) {
    return (
      <>
        <div className="page-header">
          <h1>My appointments</h1>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <h2 style={{ marginBottom: 8 }}>No appointments yet</h2>
          <p className="muted" style={{ marginBottom: 20 }}>Book your first visit from the home page.</p>
          <a className="btn" href="/book">Find a doctor</a>
        </div>
      </>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>My appointments</h1>
        <p>{appointments.length} appointment{appointments.length !== 1 ? 's' : ''} on file</p>
      </div>

      {flash && (
        <p className="flash" role="status">
          {flash}
        </p>
      )}
      {error && <p className="error-box">{error}</p>}

      {appointments.map((a) => (
        <div className="card" key={a.id}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 10 }}>
            <div>
              <p className="mono" style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 3px', color: 'var(--ink)' }}>
                {a.scheduledAt}
              </p>
              <p className="muted" style={{ margin: 0 }}>
                {a.doctorName} · {a.specialisation}
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
              <span className={`chip ${statusChipClass(a.status)}`}>
                {STATUS_LABEL[a.status] ?? a.status}
              </span>
              {(a.status === 'confirmed' || a.status === 'held') && (
                <button type="button" className="btn danger" onClick={() => setCancelling(a)}>
                  {a.status === 'held' ? 'Release slot' : 'Cancel visit'}
                </button>
              )}
            </div>
          </div>

          {a.postVisit ? (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--mint-line)', paddingTop: 14 }}>
              <p style={{ margin: '0 0 10px', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--spruce)' }}>
                Visit summary
              </p>
              <SummaryText md={a.postVisit.summaryMd} />
              <PrescriptionBlock meds={a.postVisit.medicationSchedule} />
              {a.postVisit.followUp && (
                <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
                  Follow-up: {a.postVisit.followUp}
                </p>
              )}
            </div>
          ) : (
            a.status === 'completed' && (
              <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
                Your visit summary is being prepared…
              </p>
            )
          )}
        </div>
      ))}

      <ConfirmDialog
        open={Boolean(cancelling)}
        title="Cancel this visit?"
        message={
          cancelling
            ? `${cancelling.scheduledAt} with ${cancelling.doctorName}. The slot goes back to other patients and your calendar entry is removed.`
            : ''
        }
        confirmLabel="Yes, cancel visit"
        danger
        busy={busy}
        onConfirm={cancelConfirmed}
        onCancel={() => setCancelling(null)}
      />
    </div>
  );
}
