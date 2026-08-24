import { useEffect, useState } from 'react';
import { api } from '../api.js';
import ConfirmDialog from '../Confirm.jsx';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EMPTY = {
  email: '',
  name: '',
  password: '',
  specialisation: '',
  workingDays: [1, 2, 3, 4, 5],
  startsAt: '09:00',
  endsAt: '13:00',
  slotMinutes: 20,
};

function DoctorForm({ initial, onSaved, onCancel }) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  function toggleDay(d) {
    setForm({
      ...form,
      workingDays: form.workingDays.includes(d)
        ? form.workingDays.filter((x) => x !== d)
        : [...form.workingDays, d].sort(),
    });
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (form.userId) {
        await api.patch(`/api/admin/doctors/${form.userId}`, {
          specialisation: form.specialisation,
          workingDays: form.workingDays,
          startsAt: form.startsAt,
          endsAt: form.endsAt,
          slotMinutes: Number(form.slotMinutes),
        });
      } else {
        await api.post('/api/admin/doctors', {
          email: form.email,
          name: form.name,
          password: form.password,
          specialisation: form.specialisation,
          workingDays: form.workingDays,
          startsAt: form.startsAt,
          endsAt: form.endsAt,
          slotMinutes: Number(form.slotMinutes),
        });
      }
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card accent">
      <h3 style={{ marginBottom: 16 }}>{form.userId ? `Edit ${form.name}` : 'Add a doctor'}</h3>

      {!form.userId && (
        <>
          <label htmlFor="d-email" style={{ marginTop: 0 }}>Email</label>
          <input id="d-email" type="email" value={form.email} onChange={set('email')} required />
          <label htmlFor="d-name">Full name</label>
          <input id="d-name" value={form.name} onChange={set('name')} required />
          <label htmlFor="d-pass">Temporary password</label>
          <input id="d-pass" type="password" value={form.password} onChange={set('password')} required />
        </>
      )}

      <label htmlFor="d-spec" style={form.userId ? { marginTop: 0 } : {}}>Specialisation</label>
      <input id="d-spec" value={form.specialisation} onChange={set('specialisation')} required />

      <label>Working days</label>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {DAYS.map((label, d) => (
          <button
            key={d}
            type="button"
            className={`slot-btn ${form.workingDays.includes(d) ? 'selected' : 'open'}`}
            style={{ padding: '8px 12px', fontSize: '0.82rem' }}
            onClick={() => toggleDay(d)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
        <span style={{ flex: 1 }}>
          <label htmlFor="d-start" style={{ marginTop: 0 }}>From</label>
          <input id="d-start" value={form.startsAt} onChange={set('startsAt')} />
        </span>
        <span style={{ flex: 1 }}>
          <label htmlFor="d-end" style={{ marginTop: 0 }}>Until</label>
          <input id="d-end" value={form.endsAt} onChange={set('endsAt')} />
        </span>
        <span style={{ flex: 1 }}>
          <label htmlFor="d-slot" style={{ marginTop: 0 }}>Slot (min)</label>
          <input
            id="d-slot"
            type="number"
            min="5"
            max="120"
            value={form.slotMinutes}
            onChange={set('slotMinutes')}
          />
        </span>
      </div>

      {error && <p className="error-box">{error}</p>}
      <div className="row" style={{ marginTop: 20 }}>
        <button className="btn" disabled={busy} type="submit">
          Save
        </button>
        {onCancel && (
          <button type="button" className="btn secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export default function AdminDoctorsPage() {
  const [doctors, setDoctors] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    api.get('/api/admin/doctors').then((d) => setDoctors(d.doctors)).catch((e) => setError(e.message));
  }

  useEffect(refresh, []);

  async function removeConfirmed() {
    setBusy(true);
    try {
      await api.del(`/api/admin/doctors/${removing.userId}`);
      setRemoving(null);
      refresh();
    } catch (err) {
      setRemoving(null);
      setError(
        err.code === 'CONFLICT'
          ? `${removing.name} still has upcoming confirmed bookings. Cancel or reschedule those first.`
          : err.message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h1 style={{ marginBottom: 0 }}>Doctors</h1>
        </div>
        {!adding && !editing && (
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            + Add doctor
          </button>
        )}
      </div>

      {error && <p className="error-box">{error}</p>}

      {adding && (
        <DoctorForm
          initial={{ ...EMPTY }}
          onSaved={() => { setAdding(false); refresh(); }}
          onCancel={() => setAdding(false)}
        />
      )}
      {editing && (
        <DoctorForm
          initial={{ ...EMPTY, ...editing, workingDays: editing.workingDays ?? [] }}
          onSaved={() => { setEditing(null); refresh(); }}
          onCancel={() => setEditing(null)}
        />
      )}

      {!doctors && !error && <p className="muted">Loading…</p>}

      {(doctors ?? []).map((d) => (
        <div className="card" key={d.userId}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
            <div className="row" style={{ gap: 14, flex: 1, minWidth: 0, flexWrap: 'nowrap' }}>
              <div className="doctor-avatar" style={{ flexShrink: 0 }}>
                {d.name.split(' ').map((n) => n[0]).slice(0, 2).join('')}
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: '0 0 2px', fontWeight: 700 }}>{d.name}</p>
                <p className="muted" style={{ margin: '0 0 4px', fontSize: '0.83rem' }}>{d.email}</p>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <span className="chip neutral">{d.specialisation}</span>
                  <span className="muted mono" style={{ fontSize: '0.78rem' }}>
                    {d.startsAt}–{d.endsAt} @ {d.slotMinutes}m
                  </span>
                </div>
              </div>
            </div>

            <div className="row" style={{ gap: 8, flexShrink: 0 }}>
              <button type="button" className="btn secondary" onClick={() => setEditing(d)}>
                Edit schedule
              </button>
              <button type="button" className="btn danger" onClick={() => setRemoving(d)}>
                Remove
              </button>
            </div>
          </div>
        </div>
      ))}

      <ConfirmDialog
        open={Boolean(removing)}
        title={`Remove ${removing?.name ?? ''}?`}
        message="Their login stops working and their future slots disappear from booking. Past records stay in the system."
        confirmLabel="Yes, remove doctor"
        danger
        busy={busy}
        onConfirm={removeConfirmed}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
