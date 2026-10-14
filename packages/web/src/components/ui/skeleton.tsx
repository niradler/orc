import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-testid="loading-skeleton"
      className={cn("animate-pulse rounded-md bg-muted ", className)}
      {...props}
    />
  );
}

export { Skeleton };
