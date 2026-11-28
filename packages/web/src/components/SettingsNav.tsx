import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SETTINGS_DOMAINS,
  type SettingsGroupId,
  settingsGroupsFor,
} from "@/lib/settings-navigation";

type SettingsNavProps = {
  active: SettingsGroupId | null;
  onSelect: (id: SettingsGroupId) => void;
};

/** Desktop sidebar, grouped so related panels stay together. */
export function SettingsSidebar({ active, onSelect }: SettingsNavProps) {
  return (
    <nav aria-label="Settings sections" className="hidden md:block">
      {SETTINGS_DOMAINS.map((domain) => (
        <div key={domain.id} className="mb-5 last:mb-0">
          <p className="mb-1 px-3 text-xs font-medium text-outline">{domain.label}</p>
          <div className="space-y-1">
            {settingsGroupsFor(domain.id).map((group) => (
              <Button
                key={group.id}
                data-testid={`settings-section-${group.id}`}
                variant={active === group.id ? "secondary" : "ghost"}
                aria-current={active === group.id ? "page" : undefined}
                onClick={() => onSelect(group.id)}
                className="w-full justify-start"
              >
                {group.label}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

/** Phone menu: the settings list is the first screen, a section opens on tap. */
export function SettingsList({ onSelect }: Pick<SettingsNavProps, "onSelect">) {
  return (
    <nav aria-label="Settings sections" data-testid="settings-list" className="space-y-6">
      {SETTINGS_DOMAINS.map((domain) => (
        <section key={domain.id} aria-labelledby={`settings-domain-${domain.id}`}>
          <h2
            id={`settings-domain-${domain.id}`}
            className="mb-2 px-1 text-xs font-medium text-outline"
          >
            {domain.label}
          </h2>
          <ul className="divide-y divide-border border-y border-border">
            {settingsGroupsFor(domain.id).map((group) => (
              <li key={group.id}>
                <button
                  type="button"
                  id={`settings-list-${group.id}`}
                  data-testid={`settings-list-${group.id}`}
                  onClick={() => onSelect(group.id)}
                  className="flex min-h-16 w-full items-center gap-3 px-1 py-3 text-left hover:bg-surface-highest focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-on-surface">{group.label}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {group.description}
                    </span>
                  </span>
                  <ChevronRight size={16} className="shrink-0 text-outline" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
