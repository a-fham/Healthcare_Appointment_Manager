import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Heart } from 'lucide-react';
import { useAuth } from '../auth.jsx';

const HOME_BY_ROLE = { patient: '/book', doctor: '/queue', admin: '/admin/doctors' };

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const user = await login(email, password);
      navigate(HOME_BY_ROLE[user.role] ?? '/');
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
          <p className="auth-title">Welcome back</p>
          <p className="auth-subtitle">Ashgrove Family Practice</p>
        </div>

        <div className="card">
          <h2>Log in to your account</h2>
          <form onSubmit={submit}>
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            {error && <p className="error-box">{error}</p>}
            <p style={{ marginTop: 20, marginBottom: 0 }}>
              <button className="btn" disabled={busy} type="submit" style={{ width: '100%', justifyContent: 'center' }}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </p>
          </form>
        </div>

        <p className="muted" style={{ textAlign: 'center', marginTop: 16 }}>
          New here?{' '}
          <Link to="/register" style={{ fontWeight: 600 }}>
            Create a patient account
          </Link>
        </p>
      </div>
    </div>
  );
}
