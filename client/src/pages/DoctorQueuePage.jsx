import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';

const URGENCY_ORDER = { high: 0, medium: 1, low: 2 };

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function DoctorQueuePage() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [flash, setFlash] = useState(location.state?.flash ?? '');

  useEffect(() => {
    if (location.state?.flash) window.history.replaceState({}, '');
  }, [location.state]);

  const [date, setDate] = useState(() => searchParams.get('date') ?? todayStr());
  const [queue, setQueue] = useState(null);
  const [error, setError] = useState('');

  function changeDate(next) {
    setDate(next);
    setSearchParams(next === todayStr() ? {} : { date: next }, { replace: true });
  }

  useEffect(() => {
    api
      .get(`/api/doctors/me/queue?date=${date}`)
      .then((d) =>
        setQueue(
          [...d.queue].sort((a, b) => {
            const ua = URGENCY_ORDER[a.urgency ?? 'low'] ?? 2;
            const ub = URGENCY_ORDER[b.urgency ?? 'low'] ?? 2;
            return ua - ub || a.scheduledAt.localeCompare(b.scheduledAt);
          }),
        ),
      )
      .catch((e) => setError(e.message));
  }, [date]);

  if (error) return <p className="error-box">{error}</p>;

  return (
    <div>
      <div className="page-header">
        <h1>Consultation queue</h1>
        <p>Sorted by urgency first. The AI flag is decision support, not a diagnosis.</p>
      </div>

      {flash && (
        <p className="flash" role="status">
          {flash}
        </p>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <label htmlFor="qdate" style={{ marginTop: 0 }}>Select day</label>
        <input
          id="qdate"
          type="date"
          value={date}
          onChange={(e) => changeDate(e.target.value)}
        />
      </div>

      {!queue && !error && <p className="muted">Loading queue…</p>}
      {queue?.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '36px 24px' }}>
          <p className="muted" style={{ margin: 0 }}>No patients booked for this day.</p>
        </div>
      )}

      {queue?.length > 0 && (
        <div className="card" style={{ padding: '8px 16px' }}>
          {queue.map((item) => (
            <div
              className={`queue-item urgency-${item.urgency ?? 'low'}`}
              key={item.id}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 8, marginBottom: 4 }}>
                  <span className="mono" style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--ink)' }}>
                    {item.scheduledAt.slice(11)}
                  </span>
                  <span style={{ fontWeight: 600 }}>{item.patientName}</span>
                </div>
                {item.chiefComplaint && (
                  <p className="muted" style={{ margin: '0 0 3px', fontSize: '0.85rem' }}>
                    {item.chiefComplaint}
                  </p>
                )}
                {item.symptoms && (
                  <p className="muted" style={{ margin: 0, fontSize: '0.82rem', fontStyle: 'italic' }}>
                    "{item.symptoms.length > 120 ? `${item.symptoms.slice(0, 120)}…` : item.symptoms}"
                  </p>
                )}
                {item.generationStatus === 'pending' && (
                  <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.78rem' }}>
                    Summary preparing…
                  </p>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flexShrink: 0 }}>
                <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                  {item.urgency ? (
                    <span className={`chip ${item.urgency}`}>
                      {item.urgency.charAt(0).toUpperCase() + item.urgency.slice(1)} urgency
                    </span>
                  ) : (
                    <span className="chip neutral">Triage pending</span>
                  )}
                  {item.severity && (
                    <span className="chip neutral">{item.severity}</span>
                  )}
                </div>
                {item.status === 'confirmed' ? (
                  <Link className="btn secondary" to={`/queue/${item.id}/notes`} state={{ item }}>
                    Record visit
                  </Link>
                ) : (
                  <span className="muted" style={{ fontSize: '0.82rem' }}>Completed ✓</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
