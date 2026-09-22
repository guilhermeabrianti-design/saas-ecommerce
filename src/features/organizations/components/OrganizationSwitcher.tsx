import { Building2 } from 'lucide-react';
import { Select } from '@/components/ui/Select';
import { useOrganization } from '../organization-context';

/** Shows the active organization; lets users with several pick which one to work in. */
export function OrganizationSwitcher() {
  const { memberships, active, selectOrganization } = useOrganization();
  if (!active) return null;

  if (memberships.length === 1) {
    return (
      <span className="text-muted hidden min-w-0 items-center gap-2 text-sm lg:flex">
        <Building2 className="size-4 shrink-0" aria-hidden />
        <span className="max-w-48 truncate">{active.organization.name}</span>
      </span>
    );
  }

  return (
    <Select
      aria-label="Organização ativa"
      value={active.organization.id}
      onChange={(e) => selectOrganization(e.target.value)}
      className="h-9 max-w-40 sm:max-w-56"
    >
      {memberships.map((m) => (
        <option key={m.organization.id} value={m.organization.id}>
          {m.organization.name}
        </option>
      ))}
    </Select>
  );
}
