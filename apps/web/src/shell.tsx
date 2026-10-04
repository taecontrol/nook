import { useQuery } from '@tanstack/react-query';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { AppSidebar } from './app-sidebar';
import { identityOptions, type Session } from './identity';
import { SessionCard } from './session-card';

export function Shell() {
  const identity = useQuery(identityOptions);
  const session: Session = identity.data ?? { state: 'loading' };
  return (
    <SidebarProvider>
      <AppSidebar session={session} />
      <SidebarInset className="min-w-0">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b px-6">
          <SidebarTrigger className="md:hidden" />
          <span className="text-sm font-medium">Nook</span>
        </header>
        <section
          className="w-full max-w-4xl px-6 py-10 md:px-12 md:py-14"
          aria-label="Owner access"
        >
          <div className="mb-7 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Owner access
          </div>
          <SessionCard session={session} />
        </section>
      </SidebarInset>
    </SidebarProvider>
  );
}
