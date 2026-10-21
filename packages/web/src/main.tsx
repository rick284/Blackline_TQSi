import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./grid.js";
import { SessionProvider } from "./session.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);

// The offline app shell. Not in development, where it would serve stale files while you work on them.
if (import.meta.env.PROD && "serviceWorker" in navigator) window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined));
