import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import SourcesPanel from '../admin/SourcesPanel';
import ChannelsPanel from '../admin/ChannelsPanel';
import UsersPanel from '../admin/UsersPanel';

export default function AdminPage() {
  return (
    <div className="page">
      <div className="tabs">
        <NavLink to="/admin/sources">Sources</NavLink>
        <NavLink to="/admin/channels">Channels</NavLink>
        <NavLink to="/admin/users">Users</NavLink>
      </div>
      <Routes>
        <Route path="sources" element={<SourcesPanel />} />
        <Route path="channels" element={<ChannelsPanel />} />
        <Route path="users" element={<UsersPanel />} />
        <Route path="*" element={<Navigate to="sources" replace />} />
      </Routes>
    </div>
  );
}
