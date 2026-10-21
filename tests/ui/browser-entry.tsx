// Explicit test-only browser preview; never included in production entrypoints.
import { createRoot } from "react-dom/client";
import { fixture } from "./fixture";
import "../../src/ui/styles.css";

const state = structuredClone(fixture);
Object.defineProperty(globalThis, "chrome", {
  value: {
    extension: { inIncognitoContext: location.search.includes("incognito") },
    permissions: { request: async () => false },
    runtime: {
      openOptionsPage: () => {},
      sendMessage: async (command: {
        type: string;
        patch?: object;
        context?: string;
        data?: unknown;
      }) => {
        state.context =
          command.context === "incognito" ? "incognito" : "regular";
        if (command.type === "settings.update")
          Object.assign(state.settings.routing, command.patch);
        if (
          command.type === "settings.import.preview" &&
          typeof command.data === "object" &&
          command.data !== null &&
          "compatible" in command.data
        )
          return {
            ok: true,
            value: { format: "firefox", routing: state.settings.routing },
          };
        if (command.type === "settings.import")
          document.documentElement.dataset.imported = "true";
        if (command.type === "settings.import.preview")
          return {
            ok: false,
            error: {
              code: "invalid-input",
              message:
                "Firefox proxyDNS=false is incompatible with Chrome. Enable proxyDNS before importing.",
            },
          };
        return { ok: true, value: structuredClone(state) };
      },
    },
  },
});
const { App } = await import("../../src/ui/App");
const root = document.getElementById("root");
if (!root) throw new Error("Missing test root");
createRoot(root).render(
  <>
    <p>Test-only preview with mocked Chrome services</p>
    <App />
  </>,
);
