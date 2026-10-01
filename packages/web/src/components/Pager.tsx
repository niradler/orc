import { ChevronLeft, ChevronRight } from "lucide-react";

interface PagerProps {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}

const BUTTON =
  "inline-flex items-center gap-1 font-label text-[11px] uppercase tracking-widest text-primary hover:text-on-surface disabled:opacity-40 disabled:hover:text-primary";

export function Pager({ page, pageSize, total, onPage }: PagerProps): React.ReactElement | null {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const first = page * pageSize + 1;
  const last = Math.min(total, (page + 1) * pageSize);

  return (
    <div
      data-testid="pager"
      className="flex items-center justify-between border-t border-surface-highest px-3 py-2"
    >
      <span className="font-label text-[11px] uppercase tracking-widest text-outline">
        {first}–{last} of {total}
      </span>
      <div className="flex items-center gap-4">
        <button
          type="button"
          data-testid="pager-prev"
          className={BUTTON}
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft className="h-3 w-3" />
          Prev
        </button>
        <span className="font-label text-[11px] uppercase tracking-widest text-outline">
          Page {page + 1} / {pageCount}
        </span>
        <button
          type="button"
          data-testid="pager-next"
          className={BUTTON}
          disabled={page >= pageCount - 1}
          onClick={() => onPage(page + 1)}
        >
          Next
          <ChevronRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
