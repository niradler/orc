import { CircleAlert, CircleCheck } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useFinishAuthorization } from "@/hooks/useIntegrations";

const connectionsPath = "/settings?settingsSection=integrations&integrationsTab=connections";

/** The OAuth provider returns the browser here; the code is handed to spec-cli via the API. */
export default function IntegrationCallback() {
  const { name = "" } = useParams();
  const [params] = useSearchParams();
  const finish = useFinishAuthorization();
  const code = params.get("code");
  const state = params.get("state");
  const denied = params.get("error_description") ?? params.get("error");
  // The state is single-use, so a remount must not send it twice.
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current || !code || !state) return;
    sent.current = true;
    finish.mutate({ name, code, state });
  }, [finish, name, code, state]);

  const error =
    denied ??
    (!code || !state ? "The sign-in response is missing its code." : finish.error?.message);
  return (
    <main className="mx-auto max-w-md p-6" data-testid="integration-callback">
      <h1 className="mb-3 font-headline text-base">Sign in to {name}</h1>
      {error ? (
        <p role="alert" className="flex gap-2 text-sm text-error">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 wrap-break-word">{error}</span>
        </p>
      ) : finish.isSuccess ? (
        <p role="status" className="flex gap-2 text-sm">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          Signed in. ORC and the <code>spec</code> CLI now use this connection's tokens.
        </p>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Finishing sign-in…
        </p>
      )}
      <Link to={connectionsPath} className="mt-4 inline-block text-sm text-primary underline">
        Back to connections
      </Link>
    </main>
  );
}
