import { useEffect, useState } from 'react';
import { Mail, MailX, Calendar, CalendarX, Clock, FileText } from 'lucide-react';
import { api } from '../api.js';

const TILES = [
  { key: ['emails', 'pending'],  label: 'Emails queued',       Icon: Mail,      warn: false },
  { key: ['emails', 'failed'],   label: 'Emails dead-lettered', Icon: MailX,     warn: true  },
  { key: ['calendar', 'pending'],label: 'Calendar syncing',    Icon: Calendar,  warn: false },
  { key: ['calendar', 'failed'], label: 'Calendar failed',     Icon: CalendarX, warn: true  },
  { key: ['holds', 'active'],    label: 'Active holds',        Icon: Clock,     warn: false },
  { key: ['summaries', 'pending'],label: 'Summaries preparing',Icon: FileText,  warn: false },
];

function Tile({ label, num, Icon, warn }) {
  return (
    <div className={`stat-tile${warn && num > 0 ? ' warn' : ''}`}>
      <div className="stat-tile-icon">
        <Icon size={18} strokeWidth={1.8} />
      </div>
      <div className="num">{num}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export default function AdminHealthPage() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () =>
      api
        .get('/api/admin/health')
        .then((h) => { setHealth(h); setError(''); })
        .catch((e) => setError(e.message));
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  if (error) return <p className="error-box">{error}</p>;
  if (!health) return <p className="muted">Loading…</p>;

  return (
    <div>
      <div className="page-header">
        <h1>System health</h1>
        <p>
          Notification failures retry automatically and dead-letter here. The booking flow never
          breaks because an email failed.
        </p>
      </div>

      <div className="stat-grid">
        {TILES.map(({ key, label, Icon, warn }) => {
          const num = key.reduce((obj, k) => obj?.[k], health) ?? 0;
          const isWarn = warn;
          return (
            <Tile key={label} label={label} num={num} Icon={Icon} warn={isWarn} />
          );
        })}
      </div>

      <p className="muted mono" style={{ marginTop: 20, fontSize: '0.8rem' }}>
        Last scheduler tick:{' '}
        {health.lastTickAt ? new Date(health.lastTickAt).toLocaleString() : 'not yet'}
      </p>
    </div>
  );
}
