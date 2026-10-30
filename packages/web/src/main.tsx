import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import { ApiAccessGate } from "./components/ApiAccessGate";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PushResync } from "./components/PushResync";
import { ResourceEvents } from "./components/ResourceEvents";
import "./index.css";
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

const root = document.getElementById("root");
if (!root) throw new Error("No root element");

const router = createBrowserRouter([
  {
    path: "*",
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
