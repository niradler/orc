import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { dailyCron, parseDailyCron } from "@/lib/job-schedule";

export function JobScheduleFields({
  cron,
  timezone,
  onChange,
  onTimezone,
}: {
  cron: string;
  timezone: string;
  onChange: (cron: string) => void;
  onTimezone: (timezone: string) => void;
}) {
  const parsed = parseDailyCron(cron);
  const [advanced, setAdvanced] = useState(Boolean(cron && !parsed));
  const [time, setTime] = useState(parsed?.time ?? "09:00");
  const [days, setDays] = useState(parsed?.days ?? [1, 2, 3, 4, 5]);
  return (
    <div className="space-y-4" data-testid="job-schedule-fields">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>Schedule</Label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={advanced}
            onChange={(event) => {
              setAdvanced(event.target.checked);
              if (!event.target.checked) {
                const simple = parseDailyCron(cron);
                if (simple) {
                  setTime(simple.time);
                  setDays(simple.days);
                } else onChange(dailyCron(time, days));
              } else if (!cron) onChange(dailyCron(time, days));
            }}
          />
          Advanced cron
        </label>
      </div>
      {advanced ? (
        <Input
          aria-label="Cron expression"
          required
          value={cron}
          onChange={(event) => onChange(event.target.value)}
          placeholder="0 9 * * 1,2,3,4,5"
          className="font-mono"
        />
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-[8rem_12rem] sm:items-center">
            <Label htmlFor="job-schedule-time">Run at</Label>
            <Input
              id="job-schedule-time"
              type="time"
              required
              value={time}
              onChange={(event) => {
                setTime(event.target.value);
                onChange(dailyCron(event.target.value, days));
              }}
            />
          </div>
          <fieldset aria-label="Days of the week" className="flex flex-wrap gap-1">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, day) => (
              <button
                key={label}
                type="button"
                aria-pressed={days.includes(day)}
                className={`min-h-11 min-w-11 rounded-md border px-2 text-sm ${days.includes(day) ? "border-control-border bg-surface-highest text-on-surface" : "border-border text-outline"}`}
                onClick={() => {
                  const next = days.includes(day)
                    ? days.filter((entry) => entry !== day)
                    : [...days, day];
                  setDays(next);
                  onChange(next.length ? dailyCron(time, next) : "");
                }}
              >
                {label}
              </button>
            ))}
          </fieldset>
          {!days.length && (
            <p role="alert" className="text-sm text-error">
              Select at least one day.
            </p>
          )}
          <p className="text-xs text-outline">
            Cron: <code>{cron || "Select days"}</code>
          </p>
        </>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="job-timezone">Timezone</Label>
        <Input
          id="job-timezone"
          required
          value={timezone}
          onChange={(event) => onTimezone(event.target.value)}
          placeholder="Asia/Jerusalem"
        />
        <p className="text-xs text-outline">
          Uses this timezone, including daylight saving changes.
        </p>
      </div>
    </div>
  );
}
