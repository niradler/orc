import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";

const count = new Intl.NumberFormat();
const names: Record<string, string> = { codex: "Codex", claude: "Claude", cursor: "Cursor" };

export function UsageSettings() {
  const [days, setDays] = useState("30");
  const history = useQuery({
    queryKey: ["usage-history", days],
    queryFn: () => api.settings.usageHistory(days),
  });
  const quotas = useQuery({
    queryKey: ["usage-quotas"],
    queryFn: api.settings.usageQuotas,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const busy = history.isFetching || quotas.isFetching;
  const data = history.data;
  return (
    <section aria-labelledby="usage-title" data-testid="settings-usage" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="usage-title" className="text-base font-medium">
          Usage
        </h2>
        <Button
          variant="outline"
          data-testid="usage-refresh"
          disabled={busy}
          onClick={() => {
            void history.refetch();
            void quotas.refetch();
          }}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {busy ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <section aria-labelledby="quota-title">
        <h3 id="quota-title" className="text-sm font-medium">
          Account quotas
        </h3>
        <p className="mt-1 mb-3 text-xs text-muted-foreground">
          Local accounts on the API host. SSH accounts are excluded. Refreshes at most once a
          minute.
        </p>
        {quotas.isPending && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading account quotas…
          </p>
        )}
        {quotas.isError && (
          <p role="alert" className="text-sm text-error">
            Account quotas could not be loaded. Use Refresh to retry.
          </p>
        )}
        {quotas.data?.accounts.map((account) => (
          <div
            key={account.provider}
            data-testid={`usage-quota-${account.provider}`}
            className="border-b border-border py-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h4 className="text-sm font-medium">{names[account.provider]}</h4>
              <span className="text-xs text-muted-foreground">
                Checked {new Date(account.checked_at).toLocaleTimeString()}
              </span>
            </div>
            {account.status !== "available" && (
              <p className="mt-2 text-xs text-muted-foreground">
                {account.message ?? "Quota data is unavailable."}
              </p>
            )}
            {account.windows.map((window) => (
              <div
                key={window.label}
                className="mt-3 grid min-w-0 gap-1.5 sm:grid-cols-[140px_minmax(0,1fr)_80px] sm:items-center sm:gap-x-4"
              >
                <span className="text-xs">{window.label}</span>
                <div
                  role="progressbar"
                  aria-label={`${names[account.provider]} ${window.label} used`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={window.used_percent}
                  className="h-1.5 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full bg-foreground"
                    style={{ width: `${window.used_percent}%` }}
                  />
                </div>
                <span className="text-xs tabular-nums sm:text-right">
                  {window.used_percent}% used
                </span>
                <span className="text-xs text-muted-foreground sm:col-span-3">
                  {window.resets_at
                    ? `Resets ${new Date(window.resets_at).toLocaleString()}`
                    : "Reset time unavailable"}
                </span>
              </div>
            ))}
          </div>
        ))}
      </section>
      <section aria-labelledby="history-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="history-title" className="text-sm font-medium">
            Session token history
          </h3>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Sessions started
            <select
              data-testid="usage-period"
              aria-label="Sessions started"
              className="form-control form-control-single min-h-11 w-auto"
              value={days}
              onChange={(event) => setDays(event.target.value)}
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="0">All time</option>
            </select>
          </label>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Lifetime token totals for imported sessions started in this period, across all projects.
          These are not tokens consumed during the period or billed costs.
        </p>
        {history.isPending && (
          <p role="status" className="mt-3 text-sm text-muted-foreground">
            Loading session history…
          </p>
        )}
        {history.isError && (
          <p role="alert" className="mt-3 text-sm text-error">
            Session history could not be loaded. Use Refresh to retry.
          </p>
        )}
        {data && (
          <>
            <dl className="my-4 grid grid-cols-2 gap-4 border-y border-border py-3">
              <div>
                <dt className="text-xs text-muted-foreground">Recorded tokens</dt>
                <dd data-testid="usage-total-tokens" className="mt-1 text-xl tabular-nums">
                  {count.format(data.totals.tokens)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Sessions</dt>
                <dd className="mt-1 text-xl tabular-nums">{count.format(data.totals.sessions)}</dd>
              </div>
            </dl>
            {data.totals.unknown_sessions > 0 && (
              <p className="mb-3 text-xs text-muted-foreground">
                Sessions without reported token counts: {count.format(data.totals.unknown_sessions)}
                . Excluded from token totals.
              </p>
            )}
            {data.totals.estimated_sessions > 0 && (
              <p className="mb-3 text-xs text-muted-foreground">
                Cursor sessions with estimated counts:{" "}
                {count.format(data.totals.estimated_sessions)}.
              </p>
            )}
            {!data.totals.sessions && (
              <p className="text-sm text-muted-foreground">
                No imported sessions started in this period. Sessions appear after ORC discovers
                them.
              </p>
            )}
            {data.agents.map((agent) => (
              <div
                key={agent.agent}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2.5 text-sm"
              >
                <span className="min-w-0 break-words">{names[agent.agent] ?? agent.agent}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {count.format(agent.tokens)} tokens · {count.format(agent.sessions)} sessions
                </span>
              </div>
            ))}
            {data.daily.length > 0 && (
              <details className="mt-4" data-testid="usage-daily">
                <summary className="flex min-h-11 cursor-pointer items-center text-sm focus-visible:outline-2 focus-visible:outline-ring">
                  By session start date (UTC)
                </summary>
                {data.daily.map((day) => (
                  <div
                    key={day.date}
                    className="flex flex-wrap justify-between gap-2 border-b border-border py-2 text-xs tabular-nums"
                  >
                    <span>{day.date}</span>
                    <span className="text-muted-foreground">
                      {count.format(day.tokens)} tokens · {count.format(day.sessions)} sessions
                    </span>
                  </div>
                ))}
              </details>
            )}
          </>
        )}
      </section>
    </section>
  );
}
