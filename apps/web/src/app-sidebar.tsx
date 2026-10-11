import { Link, useRouterState } from '@tanstack/react-router';
import { Box, UserRound } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { destinationGroups, destinations } from './destinations';
import type { Session } from './identity';
import { OwnerMenu } from './owner-menu';

const footerText = {
  loading: 'Checking session…',
  'session-expired': 'Session expired',
  'not-owner': 'Access denied',
  unavailable: 'Session unavailable',
};

export function AppSidebar({ session }: { session: Session }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { setOpenMobile } = useSidebar();
  const close = () => setOpenMobile(false);
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="px-4 py-6">
        <Link
          to="/"
          onClick={close}
          className="flex items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <Avatar className="size-9 rounded-lg">
            <AvatarFallback className="rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              <Box className="size-5" />
            </AvatarFallback>
          </Avatar>
          <span className="text-lg font-semibold tracking-tight">Nook</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        {destinationGroups.map((group) => (
          <SidebarGroup key={group}>
            <SidebarGroupLabel>{group}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {destinations
                  .filter((destination) => destination.group === group)
                  .map(({ to, title, icon: Icon }) => (
                    <SidebarMenuItem key={to}>
                      <SidebarMenuButton asChild isActive={pathname === to}>
                        <Link to={to} search={{}} onClick={close}>
                          <Icon />
                          <span>{title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <Separator />
      <SidebarFooter className="p-3">
        {session.state === 'signed-in' ? (
          <OwnerMenu email={session.email} />
        ) : (
          <div className="flex items-center gap-3 px-2 py-3 text-sm text-muted-foreground">
            <UserRound className="size-4" />
            {footerText[session.state]}
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
