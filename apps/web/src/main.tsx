import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { preloadBuckets } from './buckets-api';
import { Home } from './home';
import { identityOptions } from './identity';
import { preloadMachines } from './machines-api';
import { Shell } from './shell';
import './index.css';

const theme = matchMedia('(prefers-color-scheme: dark)');
document.documentElement.classList.toggle('dark', theme.matches);
theme.addEventListener('change', (event) =>
  document.documentElement.classList.toggle('dark', event.matches),
);

const queryClient = new QueryClient();
const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
  notFoundComponent: () => null,
});
const owner = createRoute({
  getParentRoute: () => root,
  id: 'owner',
  component: Shell,
  loader: ({ context }) => {
    void context.queryClient.ensureQueryData(identityOptions);
  },
});
const home = createRoute({
  getParentRoute: () => owner,
  path: '/',
  component: Home,
});
const buckets = createRoute({
  getParentRoute: () => owner,
  path: '/buckets',
  component: lazyRouteComponent(() => import('./buckets-page'), 'BucketsPage'),
  loader: ({ context }) => {
    preloadBuckets(context.queryClient);
  },
});
const router = createRouter({
  routeTree: root.addChildren([
    owner.addChildren([
      home,
      buckets,
      createRoute({
        getParentRoute: () => owner,
        path: '/machines',
        component: lazyRouteComponent(
          () => import('./machines-page'),
          'MachinesPage',
        ),
        loader: ({ context }) => {
          preloadMachines(context.queryClient);
        },
      }),
    ]),
    createRoute({
      getParentRoute: () => root,
      path: '/cli/authorize',
      component: lazyRouteComponent(
        () => import('./authorize-page'),
        'AuthorizePage',
      ),
    }),
  ]),
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
