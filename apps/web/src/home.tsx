import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { destinationGroups, destinations } from './destinations';
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
      {destinationGroups.map((group) => (
        <section key={group} aria-label={group} className="mt-12 space-y-3">
          <div className={label}>{group}</div>
          {destinations
            .filter((destination) => destination.group === group)
            .map(({ to, title, description, icon: Icon }) => (
              <Item key={to} variant="outline" asChild>
                <Link to={to} search={{}}>
                  <ItemMedia variant="icon">
                    <Icon />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{title}</ItemTitle>
                    <ItemDescription>{description}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Link>
              </Item>
            ))}
        </section>
      ))}
    </div>
  );
}
