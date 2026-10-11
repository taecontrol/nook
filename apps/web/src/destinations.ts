import {
  Brain,
  History,
  KeyRound,
  ListTree,
  type LucideIcon,
  MonitorSmartphone,
} from 'lucide-react';

/** The owner pages the sidebar, breadcrumb and home screen lead to. */
export const destinations: readonly {
  group: 'Platform' | 'Tools';
  to: '/buckets' | '/machines' | '/audit' | '/memory' | '/vault';
  title: string;
  description: string;
  icon: LucideIcon;
}[] = [
  {
    group: 'Platform',
    to: '/buckets',
    title: 'Buckets',
    description: 'Browse, create, and delete buckets.',
    icon: ListTree,
  },
  {
    group: 'Platform',
    to: '/machines',
    title: 'Machines',
    description: 'See connected machines and revoke their access.',
    icon: MonitorSmartphone,
  },
  {
    group: 'Platform',
    to: '/audit',
    title: 'Audit',
    description: 'Review secret uses and denied requests.',
    icon: History,
  },
  {
    group: 'Tools',
    to: '/memory',
    title: 'Memory',
    description: 'Read what agents stored, with its provenance.',
    icon: Brain,
  },
  {
    group: 'Tools',
    to: '/vault',
    title: 'Vault',
    description: 'Store secrets and find them by name.',
    icon: KeyRound,
  },
];

export const destinationGroups = ['Platform', 'Tools'] as const;
