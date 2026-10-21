import type { Command, CommandResult, Response } from "../shared/messages";
import type {
  BrowserContext,
  LoadState,
  ProxyStatus,
  Server,
} from "../shared/state";

type Check = (value: unknown) => boolean;
const text: Check = (v) => typeof v === "string";
const bool: Check = (v) => typeof v === "boolean";
const number: Check = (v) => typeof v === "number" && Number.isFinite(v);
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
const list =
  (check: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(check);
const oneOf =
  (...values: unknown[]): Check =>
  (v) =>
    values.includes(v);
const shape =
  (fields: Record<string, Check>): Check =>
  (v) =>
    typeof v === "object" &&
    v !== null &&
    Object.entries(fields).every(([key, check]) => check(Reflect.get(v, key)));
const optional =
  (check: Check): Check =>
  (v) =>
    v === undefined || check(v);
const context = oneOf("regular", "incognito");
const ownership = oneOf(
  "unknown",
  "not_controllable",
  "controlled_by_other_extensions",
  "controllable_by_this_extension",
  "controlled_by_this_extension",
);
const status = oneOf(
  "unknown",
  "pending",
  "ready",
  "offline",
  "blocked",
  "error",
);
const load =
  (check: Check): Check =>
  (v) =>
    shape({ status })(v) &&
    (shape({ status: oneOf("ready"), value: check, updatedAt: number })(v) ||
      shape({ status: oneOf("unknown", "pending") })(v) ||
      shape({ status: oneOf("offline", "blocked", "error"), message: text })(
        v,
      ));
const rule = shape({ host: text, serverId: text, enabled: bool });
const preferences = shape({ autoReload: bool, historyEnabled: bool });
const routingFields = {
  enabled: bool,
  globalServerId: nullable(text),
  randomMode: bool,
  rules: list(rule),
  exclusions: list(text),
};
const settings = shape({ routing: shape(routingFields), preferences });
const history = list(
  shape({
    serverId: text,
    hostname: text,
    country: text,
    countryCode: text,
    city: text,
    count: number,
    lastUsedAt: number,
  }),
);
const proxy = shape({
  ownership,
  permissionGranted: bool,
  applied: bool,
  status,
  message: optional(text),
  scope: context,
  settingScope: oneOf(
    "regular",
    "regular_only",
    "incognito_persistent",
    "incognito_session_only",
    "unknown",
  ),
});
const observation = shape({
  ip: text,
  isMullvad: bool,
  country: optional(text),
  city: optional(text),
  server: optional(text),
  provider: optional(text),
});
export const isSnapshot = shape({
  context,
  incognitoAllowed: bool,
  revision: number,
  settings,
  history,
  servers: load(
    list(
      shape({
        id: text,
        hostname: text,
        ipv4: text,
        ipv6: text,
        port: number,
        online: bool,
        country: text,
        countryCode: text,
        city: text,
      }),
    ),
  ),
  proxy,
  incognitoProxy: proxy,
  diagnostics: shape({
    scope: oneOf("browser-route"),
    ipv4: load(observation),
    ipv6: load(observation),
    dns: load(
      list(
        shape({
          ip: text,
          isMullvad: bool,
          hostname: text,
          country: optional(text),
          organization: optional(text),
        }),
      ),
    ),
  }),
  privacy: shape({
    permissionGranted: bool,
    webRtc: shape({ ownership, value: nullable(text) }),
    networkPrediction: shape({ ownership, value: nullable(bool) }),
  }),
});
export const isImportPreview = shape({
  format: oneOf("native", "firefox"),
  routing: shape({ ...routingFields, randomMode: optional(bool) }),
  preferences: optional(preferences),
  history: optional(history),
});
const isExport = shape({ version: oneOf(1), settings, history });
export function validateResponse(command: Command, response: unknown): boolean {
  return (
    shape({
      ok: oneOf(false),
      error: shape({
        code: oneOf(
          "invalid-input",
          "permission-denied",
          "blocked",
          "offline",
          "internal",
        ),
        message: text,
      }),
    })(response) ||
    shape({
      ok: oneOf(true),
      value:
        command.type === "settings.export"
          ? isExport
          : command.type === "settings.import.preview"
            ? isImportPreview
            : (value) =>
                isSnapshot(value) &&
                shape({ context: oneOf(command.context ?? "regular") })(value),
    })(response)
  );
}
export async function client<C extends Command>(
  command: C,
): Promise<Response<CommandResult<C>>> {
  const response: unknown = await chrome.runtime.sendMessage(command);
  if (!validateResponse(command, response))
    throw new Error(
      "The extension returned an invalid response. Reload and try again.",
    );
  // The command-specific runtime schema above checks the response before this type assertion.
  return response as Response<CommandResult<C>>;
}

export function searchServers(servers: Server[], query: string): Server[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/);
  return servers
    .filter((server) =>
      terms.every((term) =>
        `${server.country} ${server.countryCode} ${server.city} ${server.hostname}`
          .toLocaleLowerCase()
          .includes(term),
      ),
    )
    .sort((a, b) =>
      `${a.country} ${a.city} ${a.hostname}`.localeCompare(
        `${b.country} ${b.city} ${b.hostname}`,
      ),
    );
}
export function freshness(state: LoadState<unknown>): string {
  if (state.status === "ready")
    return `${Date.now() - state.updatedAt > 86400000 ? "Stale cached data" : "Fresh cached data"} · ${new Date(state.updatedAt).toLocaleString()}`;
  if (state.status === "unknown" || state.status === "pending")
    return state.status === "unknown" ? "Not checked" : "Checking…";
  return "message" in state
    ? `${state.status}: ${state.message}`
    : "Not checked";
}

export function incognitoScopeDescription(proxy: ProxyStatus): string {
  if (!proxy.applied) return "Effective private routing is not confirmed.";
  switch (proxy.settingScope) {
    case "regular":
      return "Inherited regular routing. No private-session override is applied.";
    case "incognito_session_only":
      return "Private-session routing override. It expires when the last Incognito window closes.";
    case "regular_only":
      return "The regular-only setting does not apply in Incognito.";
    case "incognito_persistent":
      return "Chrome reports a persistent Incognito setting.";
    default:
      return "Chrome has not confirmed whether private routing inherits regular settings or uses an override.";
  }
}

export function resolveUiContext(): Promise<"regular" | "incognito"> {
  return new Promise((resolve, reject) => {
    chrome.windows.getCurrent({}, (window) => {
      if (chrome.runtime.lastError || typeof window?.incognito !== "boolean") {
        reject(
          new Error(
            "Cannot determine this window's browsing context. Close and reopen this page.",
          ),
        );
        return;
      }
      resolve(window.incognito ? "incognito" : "regular");
    });
  });
}

export async function currentWebsiteTab(
  context: BrowserContext,
): Promise<{ id: number; url: string }> {
  if (!(await chrome.permissions.contains({ permissions: ["tabs"] })))
    throw new Error(
      "Tab access is unavailable. Enable active-website reload again in regular settings to grant access, or reload manually.",
    );
  const window = await new Promise<chrome.windows.Window>((resolve, reject) => {
    chrome.windows.getCurrent({}, (value) => {
      if (chrome.runtime.lastError)
        reject(new Error("Cannot read this browsing window."));
      else resolve(value);
    });
  });
  if (
    typeof window.id !== "number" ||
    window.incognito !== (context === "incognito")
  )
    throw new Error("No active website in this browsing context.");
  const [selected] = await chrome.tabs.query({
    active: true,
    windowId: window.id,
  });
  if (selected?.id === undefined)
    throw new Error("No active website in this window.");
  const tab = await chrome.tabs.get(selected.id);
  if (
    tab.id !== selected.id ||
    !tab.active ||
    tab.windowId !== window.id ||
    tab.incognito !== window.incognito
  )
    throw new Error("The active website changed. Reload it manually.");
  if (!tab.url || !["http:", "https:"].includes(new URL(tab.url).protocol))
    throw new Error("Open an HTTP or HTTPS website first.");
  return { id: selected.id, url: tab.url };
}
