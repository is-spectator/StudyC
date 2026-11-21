import { lazy, Suspense } from 'react';
import { useAuth } from './auth/AuthProvider';
import StudyWorkspace from './study/StudyWorkspace';

const LegacyApp = lazy(() => import('./LegacyApp'));

export default function App() {
  const auth = useAuth();
  return auth.isPreview
    ? <Suspense fallback={<div className="cloud-loading" role="status">正在打开本地预览…</div>}><LegacyApp /></Suspense>
    : <StudyWorkspace />;
}
