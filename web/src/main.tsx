import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';
import { Shell } from './components/Shell';
import { Landing } from './pages/Landing';
import { Overview } from './pages/Overview';
import { Holds } from './pages/Holds';
import { HoldDetail } from './pages/HoldDetail';
import { Guardians } from './pages/Guardians';
import { PolicyPage } from './pages/Policy';
import { Cover } from './pages/Cover';
import { Activity } from './pages/Activity';
import { Alerts } from './pages/Alerts';
import { Attack } from './pages/Attack';
import { Sign } from './pages/Sign';
import { ToastProvider } from './components/Toast';
import { WalletProvider } from './lib/wallet';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
    <WalletProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app" element={<Shell />}>
          <Route index element={<Overview />} />
          <Route path="holds" element={<Holds />} />
          <Route path="holds/:id" element={<HoldDetail />} />
          <Route path="guardians" element={<Guardians />} />
          <Route path="policy" element={<PolicyPage />} />
          <Route path="cover" element={<Cover />} />
          <Route path="activity" element={<Activity />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="attack" element={<Attack />} />
          <Route path="sign/:action/:id" element={<Sign />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
    </WalletProvider>
    </ToastProvider>
  </StrictMode>,
);
