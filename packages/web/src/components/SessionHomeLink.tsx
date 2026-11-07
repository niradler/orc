import { Maximize2 } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { sessionHomeSearch } from "@/lib/session-home";

export function SessionHomeLink({
  terminalId,
  liveId,
  label,
  testId,
}: {
  terminalId?: string;
  liveId?: string;
  label: string;
  testId: string;
}) {
  const location = useLocation();
  return (
    <Link
      to={{
        pathname: location.pathname,
        search: sessionHomeSearch(location.search, { terminalId, liveId }),
      }}
      data-testid={testId}
      aria-label={label}
      title={label}
      className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface hover:text-on-surface lg:min-h-8 lg:min-w-8"
    >
      <Maximize2 size={14} aria-hidden />
    </Link>
  );
}
