import { ChevronsUpDown, LogOut, UserRound } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { Email } from './email';

export function OwnerMenu({ email }: { email: string }) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="h-auto min-h-14"
              aria-label="Owner account"
            >
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg">
                  <UserRound className="size-4" />
                </AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-xs text-muted-foreground">
                  Owner
                </span>
                <span className="block truncate text-xs font-medium">
                  {email}
                </span>
              </span>
              <ChevronsUpDown className="size-4 shrink-0" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64">
            <DropdownMenuLabel className="font-normal">
              <Email value={email} />
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href="/cdn-cgi/access/logout">
                <LogOut />
                Sign out
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
