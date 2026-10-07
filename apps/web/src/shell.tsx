import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Fragment } from 'react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppSidebar } from './app-sidebar';
import { identityOptions, type Session } from './identity';

const titles: Record<string, string> = {
  '/buckets': 'Buckets',
  '/machines': 'Machines',
  '/vault': 'Vault',
};

export function Shell() {
  const identity = useQuery(identityOptions);
  const session: Session = identity.data ?? { state: 'loading' };
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const title = titles[pathname];
  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar session={session} />
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b bg-background px-6">
            <SidebarTrigger className="md:hidden" />
            <Breadcrumb>
              <BreadcrumbList>
                {title ? (
                  <Fragment>
                    <BreadcrumbItem>
                      <BreadcrumbLink asChild>
                        <Link to="/">Nook</Link>
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{title}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </Fragment>
                ) : (
                  <BreadcrumbItem>
                    <BreadcrumbPage>Nook</BreadcrumbPage>
                  </BreadcrumbItem>
                )}
              </BreadcrumbList>
            </Breadcrumb>
          </header>
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
