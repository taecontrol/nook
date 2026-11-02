import type { AccessLifetime } from '@nook/contract';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { lifetimeExpiry, lifetimeOptions } from './access-lifetime';
import { formatDateTime } from './time';

export function AccessLifetimeField({
  lifetime,
  onLifetime,
  busy,
}: {
  lifetime: AccessLifetime;
  onLifetime: (value: AccessLifetime) => void;
  busy: boolean;
}) {
  const expiry = lifetimeExpiry(lifetime, Date.now());
  return (
    <Field>
      <FieldLabel htmlFor="access-lifetime">Access expires after</FieldLabel>
      <Select
        value={lifetime}
        onValueChange={(value) => onLifetime(value as AccessLifetime)}
        disabled={busy}
      >
        <SelectTrigger
          id="access-lifetime"
          className="w-full"
          aria-describedby="access-lifetime-description"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {lifetimeOptions.map(({ value, label }) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription id="access-lifetime-description">
        {expiry === null
          ? 'The token works until you revoke it.'
          : `Nook rejects this machine's token after ${formatDateTime(expiry)}.`}
      </FieldDescription>
    </Field>
  );
}
