import { Routes, Route, Link, NavLink, Navigate, useNavigate } from 'react-router-dom';
import {
  Heart,
  CalendarPlus,
  ClipboardList,
  Users,
  Stethoscope,
  CalendarOff,
  Activity,
  LogIn,
  UserPlus,
  LogOut,
} from 'lucide-react';
import { useAuth } from './auth.jsx';
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import FindDoctorPage from './pages/FindDoctorPage.jsx';
import BookSymptomsPage from './pages/BookSymptomsPage.jsx';
import MyAppointmentsPage from './pages/MyAppointmentsPage.jsx';
import DoctorQueuePage from './pages/DoctorQueuePage.jsx';
import VisitNotesPage from './pages/VisitNotesPage.jsx';
import AdminDoctorsPage from './pages/AdminDoctorsPage.jsx';
import AdminLeavePage from './pages/AdminLeavePage.jsx';
import AdminHealthPage from './pages/AdminHealthPage.jsx';

function RequireRole({ role, children }) {
  const { me } = useAuth();
  if (me === undefined) return <p className="muted" style={{ padding: '40px 0' }}>Loading…</p>;
  if (me === null) return <Navigate to="/login" replace />;
  if (me.role !== role) return <p className="error-box">You do not have access to this page.</p>;
  return children;
}

/* ── Sidebar (desktop) ── */
function Sidebar() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();

  const homeLink =
    me?.role === 'doctor' ? '/queue' : me?.role === 'admin' ? '/admin/health' : '/';

  const navClass = ({ isActive }) => `nav-item${isActive ? ' active' : ''}`;

  return (
    <aside className="sidebar">
      <Link to={homeLink} className="sidebar-brand">
        <div className="brand-icon">
          <Heart size={18} strokeWidth={2.5} />
        </div>
        <div>
          <span className="brand-name">Ashgrove</span>
          <span className="brand-sub">Family Practice</span>
        </div>
      </Link>

      <nav className="sidebar-nav">
        {!me && (
          <>
            <NavLink to="/login" className={navClass}>
              <LogIn size={17} /> Log in
            </NavLink>
            <NavLink to="/register" className={navClass}>
              <UserPlus size={17} /> Register
            </NavLink>
          </>
        )}

        {me?.role === 'patient' && (
          <>
            <NavLink to="/book" className={navClass}>
              <CalendarPlus size={17} /> Book appointment
            </NavLink>
            <NavLink to="/my" className={navClass}>
              <ClipboardList size={17} /> My appointments
            </NavLink>
          </>
        )}

        {me?.role === 'doctor' && (
          <NavLink to="/queue" className={navClass}>
            <Users size={17} /> Today's queue
          </NavLink>
        )}

        {me?.role === 'admin' && (
          <>
            <NavLink to="/admin/doctors" className={navClass}>
              <Stethoscope size={17} /> Doctors
            </NavLink>
            <NavLink to="/admin/leave" className={navClass}>
              <CalendarOff size={17} /> Leave days
            </NavLink>
            <NavLink to="/admin/health" className={navClass}>
              <Activity size={17} /> System health
            </NavLink>
          </>
        )}
      </nav>

      {me && (
        <div className="sidebar-footer">
          <div className="user-avatar">{me.name[0].toUpperCase()}</div>
          <div className="user-meta">
            <span className="user-name">{me.name}</span>
            <span className="user-role">{me.role}</span>
          </div>
          <button
            type="button"
            className="logout-btn"
            title="Log out"
            onClick={async () => {
              await logout();
              navigate('/');
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      )}
    </aside>
  );
}

/* ── Mobile header (top bar, mobile only) ── */
function MobileHeader() {
  const { me } = useAuth();
  const homeLink =
    me?.role === 'doctor' ? '/queue' : me?.role === 'admin' ? '/admin/health' : '/';

  return (
    <Link to={homeLink} className="mobile-header">
      <div className="mobile-header-icon">
        <Heart size={15} strokeWidth={2.5} />
      </div>
      <span className="mobile-header-name">Ashgrove</span>
    </Link>
  );
}

/* ── Mobile nav (bottom tabs, mobile only) ── */
function MobileNav() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();

  const tabClass = ({ isActive }) => `mobile-tab${isActive ? ' active' : ''}`;

  return (
    <nav className="mobile-nav">
      {!me && (
        <>
          <NavLink to="/login" className={tabClass}>
            <LogIn size={20} />
            <span>Log in</span>
          </NavLink>
          <NavLink to="/register" className={tabClass}>
            <UserPlus size={20} />
            <span>Register</span>
          </NavLink>
        </>
      )}

      {me?.role === 'patient' && (
        <>
          <NavLink to="/book" className={tabClass}>
            <CalendarPlus size={20} />
            <span>Book</span>
          </NavLink>
          <NavLink to="/my" className={tabClass}>
            <ClipboardList size={20} />
            <span>Appointments</span>
          </NavLink>
        </>
      )}

      {me?.role === 'doctor' && (
        <NavLink to="/queue" className={tabClass}>
          <Users size={20} />
          <span>Queue</span>
        </NavLink>
      )}

      {me?.role === 'admin' && (
        <>
          <NavLink to="/admin/doctors" className={tabClass}>
            <Stethoscope size={20} />
            <span>Doctors</span>
          </NavLink>
          <NavLink to="/admin/leave" className={tabClass}>
            <CalendarOff size={20} />
            <span>Leave</span>
          </NavLink>
          <NavLink to="/admin/health" className={tabClass}>
            <Activity size={20} />
            <span>Health</span>
          </NavLink>
        </>
      )}

      {me && (
        <button
          type="button"
          className="mobile-tab"
          onClick={async () => {
            await logout();
            navigate('/');
          }}
        >
          <LogOut size={20} />
          <span>Logout</span>
        </button>
      )}
    </nav>
  );
}

function HomeRedirect() {
  const { me } = useAuth();
  if (me === undefined) return <p className="muted" style={{ padding: '40px 0' }}>Loading…</p>;
  if (me?.role === 'doctor') return <Navigate to="/queue" replace />;
  if (me?.role === 'admin') return <Navigate to="/admin/health" replace />;
  return <FindDoctorPage />;
}

export default function App() {
  return (
    <div className="app-shell">
      <Sidebar />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <MobileHeader />
        <main className="main-content">
          <Routes>
            <Route path="/" element={<HomeRedirect />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route
              path="/book"
              element={
                <RequireRole role="patient">
                  <FindDoctorPage />
                </RequireRole>
              }
            />
            <Route
              path="/book/:doctorId"
              element={
                <RequireRole role="patient">
                  <BookSymptomsPage />
                </RequireRole>
              }
            />
            <Route
              path="/my"
              element={
                <RequireRole role="patient">
                  <MyAppointmentsPage />
                </RequireRole>
              }
            />
            <Route
              path="/queue"
              element={
                <RequireRole role="doctor">
                  <DoctorQueuePage />
                </RequireRole>
              }
            />
            <Route
              path="/queue/:appointmentId/notes"
              element={
                <RequireRole role="doctor">
                  <VisitNotesPage />
                </RequireRole>
              }
            />
            <Route
              path="/admin/doctors"
              element={
                <RequireRole role="admin">
                  <AdminDoctorsPage />
                </RequireRole>
              }
            />
            <Route
              path="/admin/leave"
              element={
                <RequireRole role="admin">
                  <AdminLeavePage />
                </RequireRole>
              }
            />
            <Route
              path="/admin/health"
              element={
                <RequireRole role="admin">
                  <AdminHealthPage />
                </RequireRole>
              }
            />
            <Route path="*" element={<p className="muted">Page not found.</p>} />
          </Routes>
        </main>
        <MobileNav />
      </div>
    </div>
  );
}
