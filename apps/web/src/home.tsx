import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ChevronRight,
  KeyRound,
  ListTree,
  MonitorSmartphone,
} from 'lucide-react';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { identityOptions } from './identity';
import { SessionCard } from './session-card';

const label =
  'mb-7 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground';

export function Home() {
  const identity = useQuery(identityOptions);
  return (
    <div className="w-full max-w-4xl px-6 py-10 md:px-12 md:py-14">
      <section aria-label="Owner access">
        <div className={label}>Owner access</div>
        <SessionCard session={identity.data ?? { state: 'loading' }} />
      </section>
      <section aria-label="Platform" className="mt-12">
        <div className={label}>Platform</div>
        <Item variant="outline" asChild>
          <Link to="/buckets">
            <ItemMedia variant="icon">
              <ListTree />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Buckets</ItemTitle>
              <ItemDescription>
                Browse, create, and delete buckets.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <ChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Link>
        </Item>
        <Item variant="outline" className="mt-3" asChild>
          <Link to="/machines">
            <ItemMedia variant="icon">
              <MonitorSmartphone />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Machines</ItemTitle>
              <ItemDescription>
                See connected machines and revoke their access.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <ChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Link>
        </Item>
      </section>
      <section aria-label="Tools" className="mt-12">
        <div className={label}>Tools</div>
        <Item variant="outline" asChild>
          <Link to="/vault">
            <ItemMedia variant="icon">
              <KeyRound />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Vault</ItemTitle>
              <ItemDescription>
                Store secrets and find them by name.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <ChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Link>
        </Item>
      </section>
    </div>
  );
}
