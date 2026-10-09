import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import LoginPage from './pages/LoginPage';
import MultiviewPage from './pages/MultiviewPage';
import AdminPage from './pages/AdminPage';

export default function App() {
  const { status, logout } = useAuth();

  if (!status) return <div className="center muted">Loading…</div>;
  if (status.setupRequired) return <LoginPage mode="setup" />;
  if (!status.user) return <LoginPage mode="login" />;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img src="/icon.svg" alt="" width={22} height={22} />
          IPTV Multiview
        </div>
        <nav>
          <NavLink to="/">Multiview</NavLink>
          <NavLink to="/admin">Admin</NavLink>
        </nav>
        <div className="user">
          <span className="muted">{status.user.username}</span>
          <button className="ghost" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<MultiviewPage />} />
          <Route path="/admin/*" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
