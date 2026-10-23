import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Popup } from "./Popup.tsx";
import "./popup.css";

// The background already answers with a sentence; retrying would only repeat it.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <Popup />
      </QueryClientProvider>
    </StrictMode>,
  );
}
