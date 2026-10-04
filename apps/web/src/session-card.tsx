import { Check, Clock3, LogOut, ShieldAlert, UserRound } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Email } from './email';
import type { Session } from './identity';

const headings = {
  'signed-in': { title: "You're signed in", icon: Check },
  loading: { title: 'Checking your session', icon: UserRound },
  'session-expired': { title: 'Your session has expired', icon: Clock3 },
  'not-owner': { title: 'This account is not the owner', icon: ShieldAlert },
  unavailable: { title: "We couldn't check your session", icon: ShieldAlert },
};
const explanations = {
  'session-expired':
    'Sign in again through Cloudflare Access to return to Nook.',
  'not-owner':
    'Only the owner can access this Nook installation. Sign out of Cloudflare Access to switch account.',
  unavailable: 'Reload the page to try checking your session again.',
};

function SessionBody({ session }: { session: Session }) {
  if (session.state === 'signed-in')
    return (
      <>
        <p className="mb-2 text-sm text-muted-foreground">Signed in as</p>
        <p className="text-lg font-medium leading-relaxed md:text-xl">
          <Email value={session.email} />
        </p>
        <Badge variant="secondary" className="mt-5">
          Installation owner
        </Badge>
      </>
    );
  if (session.state === 'loading')
    return (
      <>
        <p className="mb-4 text-sm text-muted-foreground">
          Confirming your identity…
        </p>
        <Skeleton className="h-6 w-3/4" />
      </>
    );
  return (
    <p className="max-w-lg text-sm leading-6 text-muted-foreground">
      {explanations[session.state]}
    </p>
  );
}

function SessionAction({ session }: { session: Session }) {
  if (session.state === 'signed-in')
    return (
      <p className="text-sm text-muted-foreground">
        Memory and Vault are not available yet.
      </p>
    );
  if (session.state === 'not-owner')
    return (
      <Button asChild>
        <a href="/cdn-cgi/access/logout">
          <LogOut />
          Sign out
        </a>
      </Button>
    );
  return (
    <Button onClick={() => location.reload()}>
      {session.state === 'session-expired' ? 'Sign in again' : 'Try again'}
    </Button>
  );
}

export function SessionCard({ session }: { session: Session }) {
  const { title, icon: Icon } = headings[session.state];
  return (
    <Card className="gap-0 py-0 shadow-none" aria-live="polite">
      <CardHeader className="gap-4 p-6 md:p-8">
        <Avatar className="size-10 rounded-lg">
          <AvatarFallback className="rounded-lg">
            <Icon className="size-5" />
          </AvatarFallback>
        </Avatar>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      </CardHeader>
      <CardContent className="px-6 pb-6 md:px-8 md:pb-8">
        <SessionBody session={session} />
      </CardContent>
      {session.state !== 'loading' && (
        <>
          <Separator />
          <CardFooter className="px-6 py-5 md:px-8">
            <SessionAction session={session} />
          </CardFooter>
        </>
      )}
    </Card>
  );
}
