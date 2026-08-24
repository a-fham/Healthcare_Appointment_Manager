import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Heart } from 'lucide-react';
import { useAuth } from '../auth.jsx';

export default function RegisterPage() {
  const { register, login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await register({ ...form, phone: form.phone.trim() || undefined });
      await login(form.email, form.password);
      navigate('/book');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-wrap">
        <div className="auth-header">
          <div className="auth-brand-icon">
            <Heart size={24} strokeWidth={2.5} />
          </div>
          <p className="auth-title">Create an account</p>
          <p className="auth-subtitle">Ashgrove Family Practice</p>
        </div>

        <div className="card">
          <h2>Register as a patient</h2>
          <form onSubmit={submit}>
            <label htmlFor="name">Full name</label>
            <input id="name" value={form.name} onChange={set('name')} required />

            <label htmlFor="email">Email address</label>
            <input id="email" type="email" value={form.email} onChange={set('email')} required />

            <label htmlFor="phone">Phone <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(optional)</span></label>
            <input id="phone" value={form.phone} onChange={set('phone')} />

            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={form.password}
              onChange={set('password')}
              autoComplete="new-password"
              required
            />

            {error && <p className="error-box">{error}</p>}
            <p style={{ marginTop: 20, marginBottom: 0 }}>
              <button className="btn" disabled={busy} type="submit" style={{ width: '100%', justifyContent: 'center' }}>
                {busy ? 'Creating account…' : 'Create account'}
              </button>
            </p>
          </form>
        </div>

        <p className="muted" style={{ textAlign: 'center', marginTop: 16 }}>
          Already registered?{' '}
          <Link to="/login" style={{ fontWeight: 600 }}>
            Log in
          </Link>
        </p>
      </div>
    </div>
  );
}
