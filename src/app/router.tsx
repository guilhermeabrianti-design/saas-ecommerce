import { createBrowserRouter } from 'react-router';
import { AppShell } from '@/layouts/AppShell';
import { SystemStatusPage } from '@/pages/SystemStatusPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

// Routes are added per phase. Only routes with working pages are registered
// (no placeholder screens or dead links).
export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <SystemStatusPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
