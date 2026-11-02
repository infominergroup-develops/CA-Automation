import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth, type Role } from './auth';
import { Layout } from './components/Layout';
import { Audit } from './pages/Audit';
import { ClientRequests, Clients, CompanyPage } from './pages/Clients';
import { Dashboard } from './pages/Dashboard';
import { ConsentGate, MonitoringNotice } from './pages/Gates';
import { Login } from './pages/Login';
import { Privacy } from './pages/Privacy';
import { PrivacyPolicy } from './pages/PrivacyPolicy';
import { ClientReports } from './pages/Reports';
import { Review } from './pages/Review';
import { TallySync } from './pages/Tally';
import { TaskDetail, Tasks } from './pages/Tasks';
import { Team } from './pages/Team';
import { Time } from './pages/Time';

/** The authenticated area: shows the sign-in / consent gates, or the app inside its Layout. */
function Gate() {
  const { me } = useAuth();
  if (!me!.user) return <Login />;
  if (me!.needsConsent) return <ConsentGate />;
  if (me!.needsMonitoringAck) return <MonitoringNotice />;
  return <Layout><Outlet /></Layout>;
}

export function App() {
  const { me } = useAuth();
  if (!me) return <div className="min-h-dvh grid place-items-center" role="status" aria-label="Loading"><Loader2 className="size-8 animate-spin text-brand-500" /></div>;

  const role = me.user?.role;
  // Route guards only shape the UI; the server enforces every permission. When signed out these elements
  // are never reached (Gate renders Login), so an undefined role simply redirects.
  const only = (roles: Role[], el: React.ReactElement) => (role && roles.includes(role) ? el : <Navigate to="/" replace />);

  return (
    <Routes>
      {/* Public, shareable — reachable with or without signing in. */}
      <Route path="/privacy-policy" element={<PrivacyPolicy />} />

      <Route element={<Gate />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/company/:id" element={<CompanyPage />} />
        <Route path="/clients" element={only(['director', 'manager'], <Clients />)} />
        <Route path="/tasks" element={only(['director', 'manager', 'employee'], <Tasks />)} />
        <Route path="/tasks/:id" element={only(['director', 'manager', 'employee'], <TaskDetail />)} />
        <Route path="/requests" element={only(['client'], <ClientRequests />)} />
        <Route path="/review" element={only(['director', 'manager'], <Review />)} />
        <Route path="/time" element={only(['director', 'manager', 'employee'], <Time />)} />
        <Route path="/team" element={only(['director', 'manager'], <Team />)} />
        <Route path="/reports" element={only(['client'], <ClientReports />)} />
        <Route path="/tally" element={only(['director', 'manager'], <TallySync />)} />
        <Route path="/audit" element={only(['director'], <Audit />)} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
