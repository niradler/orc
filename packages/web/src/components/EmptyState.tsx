export function EmptyState({ message = "No data" }: { message?: string }) {
  return (
    <div
      data-testid="empty-state"
      className="flex items-center justify-center py-16 text-outline font-body text-sm"
    >
      {message}
    </div>
  );
}
