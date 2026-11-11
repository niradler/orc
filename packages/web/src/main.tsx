import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, useRouteError } from "react-router-dom";
import App from "./App";
import { ApiAccessGate } from "./components/ApiAccessGate";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ErrorReport } from "./components/ErrorReport";
import { PushResync } from "./components/PushResync";
import { ResourceEvents } from "./components/ResourceEvents";
import "./index.css";
import {
  installGlobalErrorHandlers,
  isStaleBuildError,
  reloadForStaleBuild,
} from "./lib/app-errors";
import { registerServiceWorker } from "./lib/pwa";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

if (import.meta.env.PROD) registerServiceWorker();
installGlobalErrorHandlers();

const root = document.getElementById("root");
if (!root) throw new Error("No root element");

/**
 * Replaces React Router's developer-facing default page. Route views are lazy,
 * so a deploy can fail their import mid-session; that case reloads to the new
 * build, and anything else shows the error that actually broke the render.
 */
function RouteError() {
  const error = useRouteError();
  const stale = isStaleBuildError(error);
  useEffect(() => {
    console.error("[orc] route error", error);
    if (stale) reloadForStaleBuild();
  }, [error, stale]);
  return (
    <ErrorReport
      error={error}
      testId="route-error"
      title={stale ? "ORC was updated" : "This view failed to load"}
      hint={
        stale
          ? "This tab is running an older version. Reload to load the current one."
          : "Reload the page. If this keeps happening, the details below are what to report."
      }
      onReload={() => window.location.reload()}
    />
  );
}

const router = createBrowserRouter([
  {
    path: "*",
    errorElement: <RouteError />,
    element: (
      <ApiAccessGate>
        <ResourceEvents />
        <PushResync />
        <App />
      </ApiAccessGate>
    ),
  },
]);

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
