import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function AdminLeavePage() {
  const [doctors, setDoctors] = useState(null);
  const [doctorId, setDoctorId] = useState('');
  const [date, setDate] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/api/admin/doctors').then((d) => setDoctors(d.doctors)).catch((e) => setError(e.message));
  }, []);

  async function loadPreview() {
    setError('');
    setPreview(null);
    setResult(null);
    if (!doctorId || !date) return;
    try {
      setPreview(await api.get(`/api/admin/doctors/${doctorId}/leave-preview?date=${date}`));
    } catch (err) {
      setError(err.message);
    }
  }

  async function mark() {
    setError('');
    setBusy(true);
    try {
      const r = await api.post(`/api/admin/doctors/${doctorId}/leave`, { date });
      setResult(r);
      setPreview(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const doctorName = doctors?.find((d) => String(d.userId) === String(doctorId))?.name ?? '';

  return (
    <div>
      <div className="page-header">
        <h1>Leave days</h1>
        <p>
          Marking a leave day closes the doctor's schedule. Confirmed bookings on that day are
          cancelled automatically and both sides are notified.
        </p>
      </div>

      <div className="card">
        <label htmlFor="ldoc" style={{ marginTop: 0 }}>Doctor</label>
        <select id="ldoc" value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
          <option value="">Choose a doctor…</option>
          {(doctors ?? []).map((d) => (
            <option key={d.userId} value={d.userId}>
              {d.name} , {d.specialisation}
            </option>
          ))}
        </select>

        <label htmlFor="ldate">Date</label>
        <input id="ldate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />

        <div className="row" style={{ marginTop: 20 }}>
          <button
            type="button"
            className="btn secondary"
            disabled={!doctorId || !date}
            onClick={loadPreview}
          >
            Preview impact
          </button>
          <button
            type="button"
            className="btn"
            disabled={!doctorId || !date || busy}
            onClick={mark}
          >
            {busy ? 'Marking…' : 'Mark leave'}
          </button>
        </div>

        {error && <p className="error-box">{error}</p>}

        {preview && (
          <div
            className={preview.affectedCount > 0 ? 'error-box' : 'success-box'}
            style={{ marginTop: 16 }}
          >
            {preview.affectedCount === 0
              ? `✓ No confirmed bookings for ${doctorName} on ${date}. Safe to mark.`
              : `⚠ ${preview.affectedCount} confirmed booking${
                  preview.affectedCount === 1 ? '' : 's'
                } for ${doctorName} on ${date} will be cancelled.`}
          </div>
        )}

        {result && (
          <div className="success-box" style={{ marginTop: 16 }}>
            ✓ {result.date} marked as leave. {result.cancelledCount} booking
            {result.cancelledCount === 1 ? '' : 's'} cancelled, patients notified.
          </div>
        )}
      </div>
    </div>
  );
}
