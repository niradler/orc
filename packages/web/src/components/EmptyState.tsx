export function EmptyState({ message = "No data" }: { message?: string }) {
  return (
    <div className="flex items-center justify-center py-16 text-outline font-label text-xs uppercase tracking-widest">
      {message}
    </div>
  );
}
