import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
  stringifySearchWith,
} from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { preloadAudit } from './audit-api';
import { preloadBuckets } from './buckets-api';
import { Home } from './home';
import { identityOptions } from './identity';
import { preloadMachines } from './machines-api';
import { Shell } from './shell';
import { preloadVault } from './vault-api';
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
        path: '/vault',
        component: lazyRouteComponent(
          () => import('./vault-page'),
          'VaultPage',
        ),
        validateSearch: (
          search: Record<string, unknown>,
        ): { bucket?: string } =>
          typeof search.bucket === 'string' ? { bucket: search.bucket } : {},
        loader: ({ context }) => {
          preloadVault(context.queryClient);
        },
      }),
      createRoute({
        getParentRoute: () => owner,
        path: '/audit',
        component: lazyRouteComponent(
          () => import('./audit-page'),
          'AuditPage',
        ),
        validateSearch: (search: { bucket?: string; secret?: string }) =>
          search,
        loaderDeps: ({ search }) => search,
        loader: ({ context, deps }) => {
          preloadAudit(context.queryClient, deps);
        },
      }),
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
      loader: ({ context }) => {
        preloadBuckets(context.queryClient);
      },
      component: lazyRouteComponent(
        () => import('./authorize-page'),
        'AuthorizePage',
      ),
    }),
  ]),
  context: { queryClient },
  parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
  stringifySearch: stringifySearchWith(JSON.stringify),
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
