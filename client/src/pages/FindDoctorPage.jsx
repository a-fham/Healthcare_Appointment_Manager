import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Clock, CalendarDays } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function FindDoctorPage() {
  const { isPatient } = useAuth();
  const [doctors, setDoctors] = useState(null);
  const [error, setError] = useState('');
  const [specialisation, setSpecialisation] = useState('');

  useEffect(() => {
    // Guard against out-of-order responses while the user types the filter.
    let alive = true;
    api
      .get(`/api/doctors${specialisation ? `?specialisation=${encodeURIComponent(specialisation)}` : ''}`)
      .then((d) => {
        if (alive) setDoctors(d.doctors);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [specialisation]);

  return (
    <div>
      <div className="page-header">
        <h1>Find a doctor</h1>
        <p>Pick a doctor, hold a slot, and tell us why you're coming. Your doctor walks in prepared.</p>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <label htmlFor="spec" style={{ marginTop: 0 }}>
          Filter by specialisation
        </label>
        <div style={{ position: 'relative' }}>
          <Search
            size={16}
            style={{
              position: 'absolute',
              left: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--muted)',
              pointerEvents: 'none',
            }}
          />
          <input
            id="spec"
            value={specialisation}
            onChange={(e) => setSpecialisation(e.target.value)}
            style={{ paddingLeft: 36 }}
          />
        </div>
      </div>

      {error && <p className="error-box">{error}</p>}
      {!doctors && !error && <p className="muted">Loading doctors…</p>}
      {doctors?.length === 0 && (
        <p className="muted">No doctors match that filter. Try clearing it.</p>
      )}

      {(doctors ?? []).map((d) => (
        <div className="card" key={d.userId}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row" style={{ gap: 10, marginBottom: 6, flexWrap: 'nowrap' }}>
                <div className="doctor-avatar" style={{ flexShrink: 0 }}>
                  {d.name.split(' ').map((n) => n[0]).slice(0, 2).join('')}
                </div>
                <div>
                  <h2 style={{ margin: 0, lineHeight: 1.2 }}>{d.name}</h2>
                  <span className="chip neutral" style={{ marginTop: 4 }}>{d.specialisation}</span>
                </div>
              </div>

              <div className="row" style={{ gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
                <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.82rem' }}>
                  <CalendarDays size={13} />
                  {d.workingDays.map((x) => DAYS[x]).join(', ')}
                </span>
                <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.82rem' }}>
                  <Clock size={13} />
                  {d.startsAt}–{d.endsAt} · {d.slotMinutes} min slots
                </span>
              </div>
            </div>

            {isPatient && (
              <Link className="btn" to={`/book/${d.userId}`} style={{ flexShrink: 0 }}>
                Book with {d.name.split(' ').slice(-1)[0]}
              </Link>
            )}
          </div>
        </div>
      ))}

      {!isPatient && doctors?.length > 0 && (
        <p className="muted" style={{ marginTop: 8 }}>
          <Link to="/login">Log in as a patient</Link> to book a slot.
        </p>
      )}
    </div>
  );
}
