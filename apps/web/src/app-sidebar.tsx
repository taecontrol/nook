import { Box, Brain, KeyRound, UserRound } from 'lucide-react';
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
} from '@/components/ui/sidebar';
import type { Session } from './identity';
import { OwnerMenu } from './owner-menu';

const tools = [
  { label: 'Memory', icon: Brain },
  { label: 'Vault', icon: KeyRound },
];
const footerText = {
  loading: 'Checking session…',
  'session-expired': 'Session expired',
  'not-owner': 'Access denied',
  unavailable: 'Session unavailable',
};

export function AppSidebar({ session }: { session: Session }) {
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="px-4 py-6">
        <div className="flex items-center gap-3">
          <Avatar className="size-9 rounded-lg">
            <AvatarFallback className="rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              <Box className="size-5" />
            </AvatarFallback>
          </Avatar>
          <span className="text-lg font-semibold tracking-tight">Nook</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Tools</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {tools.map(({ label, icon: Icon }) => (
                <SidebarMenuItem key={label}>
                  <SidebarMenuButton
                    disabled
                    className="h-auto items-start py-3 disabled:opacity-60"
                  >
                    <Icon className="mt-0.5" />
                    <span className="flex flex-col gap-1">
                      <span>{label}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        Not available yet
                      </span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
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
