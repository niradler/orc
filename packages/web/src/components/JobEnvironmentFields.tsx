import type { JobEnvironment } from "@orc/core/job-settings";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function JobEnvironmentFields({
  value,
  onChange,
}: {
  value: JobEnvironment;
  onChange: (value: JobEnvironment) => void;
}) {
  const [keys, setKeys] = useState(() => value.map(() => crypto.randomUUID()));
  return (
    <details className="space-y-3 rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm">
        Environment variables{value.length ? ` (${value.length})` : ""}
      </summary>
      <p className="text-xs text-outline">
        Secret values are encrypted and become write-only after saving. Leave a saved secret blank
        to keep it. Exact secret values are redacted from run logs.
      </p>
      {value.map((entry, index) => (
        <div
          key={keys[index]}
          className="grid gap-2 border-t border-border pt-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-center"
        >
          <Input
            aria-label={`Variable ${index + 1} name`}
            placeholder="VARIABLE_NAME"
            required
            pattern="[A-Za-z_][A-Za-z0-9_]*"
            value={entry.name}
            onChange={(event) =>
              onChange(
                value.map((item, position) =>
                  position === index
                    ? { ...item, name: event.target.value, value: item.value ?? "" }
                    : item,
                ),
              )
            }
          />
          <Input
            aria-label={`Variable ${index + 1} value`}
            type={entry.secret ? "password" : "text"}
            autoComplete="off"
            placeholder={entry.value === null ? "Saved secret — leave blank to keep" : "Value"}
            value={entry.value ?? ""}
            onChange={(event) =>
              onChange(
                value.map((item, position) =>
                  position === index
                    ? { ...item, value: event.target.value || (entry.value === null ? null : "") }
                    : item,
                ),
              )
            }
          />
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={entry.secret}
              onChange={(event) =>
                onChange(
                  value.map((item, position) =>
                    position === index
                      ? { ...item, secret: event.target.checked, value: item.value ?? "" }
                      : item,
                  ),
                )
              }
            />
            Secret
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove variable ${index + 1}`}
            onClick={() => {
              setKeys(keys.filter((_, position) => position !== index));
              onChange(value.filter((_, position) => position !== index));
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="job-env-add"
        onClick={() => {
          setKeys([...keys, crypto.randomUUID()]);
          onChange([...value, { name: "", value: "", secret: false }]);
        }}
      >
        Add variable
      </Button>
    </details>
  );
}
