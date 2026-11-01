/** Shown when a spec fails validation or rendering, so the reply is never lost. */
export function InvalidChatUi({ source, error }: { source: string; error: string }) {
  return (
    <details
      data-testid="chat-ui-invalid"
      className="my-2 min-w-0 rounded-md border border-outline-variant px-3 py-2 text-xs"
    >
      <summary className="cursor-pointer text-on-surface-variant">
        Component could not be shown: <span className="text-error">{error}</span>
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-on-surface-variant">
        {source}
      </pre>
    </details>
  );
}
