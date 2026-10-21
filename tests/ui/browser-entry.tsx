// Explicit test-only browser preview; never included in production entrypoints.
import { createRoot } from "react-dom/client";
import { fixture } from "./fixture";
import "../../src/ui/styles.css";

const state = structuredClone(fixture);
state.proxy = {
  ...state.proxy,
  applied: true,
  status: "ready",
  ownership: "controlled_by_this_extension",
  settingScope: "regular",
};
state.incognitoProxy.message = "PRIVATE_STATUS_NOT_INSPECTED";
if (location.search.includes("incognito")) {
  state.incognitoAllowed = true;
  state.incognitoProxy = {
    ...state.incognitoProxy,
    ownership: "controlled_by_this_extension",
    applied: true,
    status: "ready",
    settingScope: "regular",
    message: "Private routing inherited",
  };
}
const incognito = location.search.includes("incognito");
// The popup's current website, as Chrome reports it after a toolbar click.
const tab = {
  id: 9,
  windowId: 1,
  active: true,
  incognito,
  url: location.search.includes("local")
    ? "http://192.168.1.10/"
    : "https://news.example.org/story",
};
if (location.search.includes("local")) state.settings.routing.randomMode = true;
if (location.search.includes("retired")) state.favorites = ["retired-relay"];
Object.defineProperty(globalThis, "chrome", {
  value: {
    extension: { inIncognitoContext: incognito },
    permissions: { request: async () => false },
    windows: { getCurrent: async () => ({ id: 1, incognito }) },
    tabs: {
      query: async () => [{ id: tab.id }],
      get: async () => tab,
      reload: async () => undefined,
    },
    runtime: {
      openOptionsPage: () => {},
      sendMessage: async (command: {
        type: string;
        patch?: Record<string, boolean>;
        context?: string;
        data?: unknown;
        serverId?: string;
        favorite?: boolean;
      }) => {
        state.context =
          command.context === "incognito" ? "incognito" : "regular";
        if (command.type === "settings.update") {
          const { autoReload, historyEnabled, ...routing } =
            command.patch ?? {};
          Object.assign(state.settings.routing, routing);
          Object.assign(
            state.settings.preferences,
            autoReload === undefined ? {} : { autoReload },
            historyEnabled === undefined ? {} : { historyEnabled },
          );
          if (state.context === "incognito")
            state.incognitoProxy.settingScope = "incognito_session_only";
        }
        if (command.type === "favorite.set" && command.serverId) {
          state.favorites = state.favorites.filter(
            (id) => id !== command.serverId,
          );
          if (command.favorite) state.favorites.push(command.serverId);
        }
        if (command.type === "diagnostics.run")
          return {
            ok: true,
            value: {
              ...structuredClone(state),
              diagnostics: {
                scope: "browser-route",
                ipv4: location.search.includes("offline")
                  ? { status: "error", message: "Timed out" }
                  : {
                      status: "ready",
                      updatedAt: Date.now(),
                      value: { ip: "198.51.100.24", isMullvad: true },
                    },
                ipv6: { status: "error", message: "No IPv6 route" },
                dns: {
                  status: "ready",
                  updatedAt: Date.now(),
                  value: [
                    { ip: "198.51.100.53", isMullvad: true, hostname: "dns" },
                  ],
                },
              },
            },
          };
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
    <App
      context={chrome.extension.inIncognitoContext ? "incognito" : "regular"}
    />
  </>,
);
