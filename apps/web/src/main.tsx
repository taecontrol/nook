import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  RouterProvider,
} from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { preloadBuckets } from './buckets-api';
import { Home } from './home';
import { identityOptions } from './identity';
import { Shell } from './shell';
import './index.css';

const theme = matchMedia('(prefers-color-scheme: dark)');
document.documentElement.classList.toggle('dark', theme.matches);
theme.addEventListener('change', (event) =>
  document.documentElement.classList.toggle('dark', event.matches),
);

const queryClient = new QueryClient();
const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Shell,
  loader: ({ context }) => {
    void context.queryClient.ensureQueryData(identityOptions);
  },
  notFoundComponent: () => null,
});
const home = createRoute({
  getParentRoute: () => root,
  path: '/',
  component: Home,
});
const buckets = createRoute({
  getParentRoute: () => root,
  path: '/buckets',
  component: lazyRouteComponent(() => import('./buckets-page'), 'BucketsPage'),
  loader: ({ context }) => {
    preloadBuckets(context.queryClient);
  },
});
const router = createRouter({
  routeTree: root.addChildren([home, buckets]),
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
});

const container = document.getElementById('root');
if (!container) throw new Error('Missing application root');
createRoot(container).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
