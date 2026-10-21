import { relayName } from "../core/validation";
import type { Command, CommandResult, Response } from "../shared/messages";
import type {
  BrowserContext,
  ConnectionObservation,
  DnsObservation,
  LoadState,
  ProxyStatus,
  Server,
  Snapshot,
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
        `${server.country} ${server.countryCode} ${server.city} ${server.hostname} ${relayName(server.hostname)}`
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
export const STALE_AFTER = 24 * 60 * 60 * 1000;
export function freshness(state: LoadState<unknown>): string {
  if (state.status === "ready") {
    if (!state.updatedAt) return "Updated at an unknown time";
    const when = new Date(state.updatedAt).toLocaleString([], {
      dateStyle: "medium",
      timeStyle: "short",
    });
    return Date.now() - state.updatedAt > STALE_AFTER
      ? `Stale · updated ${when}`
      : `Updated ${when}`;
  }
  if (state.status === "unknown" || state.status === "pending")
    return state.status === "unknown" ? "Not checked" : "Checking…";
  return "message" in state
    ? `${state.status}: ${state.message}`
    : "Not checked";
}

export type Tone = "on" | "off" | "warn" | "error";
export type Observed = LoadState<ConnectionObservation | DnsObservation[]>;
const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

export function proxyStatus(
  snapshot: Snapshot,
  context: BrowserContext,
  via: string,
) {
  const effective =
    context === "incognito" ? snapshot.incognitoProxy : snapshot.proxy;
  const routing = snapshot.settings.routing;
  const rules = routing.rules.filter((rule) => rule.enabled).length;
  const status = (tone: Tone, title: string, detail: string) => ({
    tone,
    title,
    detail,
  });
  if (effective.status === "blocked")
    return status("error", "Proxy blocked", effective.message ?? "");
  if (effective.applied) {
    if (routing.randomMode)
      return status("on", "Proxy on", "Random location for each website.");
    if (!routing.enabled)
      return status(
        "on",
        "Proxy on",
        `Rules for ${plural(rules, "website")}; other websites connect directly.`,
      );
    // Rules and exclusions override the global route for their hosts.
    const exceptions = [
      rules ? plural(rules, "website rule") : "",
      routing.exclusions.length
        ? plural(routing.exclusions.length, "exclusion")
        : "",
    ]
      .filter(Boolean)
      .join(" and ");
    return status(
      "on",
      "Proxy on",
      `All websites via ${via}${exceptions ? `, except ${exceptions}` : ""}.`,
    );
  }
  if (
    effective.status === "error" ||
    routing.enabled ||
    routing.randomMode ||
    rules
  )
    return status(
      "warn",
      "Proxy not confirmed",
      effective.message ?? `Status: ${effective.status}`,
    );
  return status("off", "Proxy off", "Websites connect directly.");
}

export function checkStatus(state: Observed): [Tone, string] {
  if (state.status === "unknown") return ["off", "Not checked"];
  if (state.status === "pending") return ["off", "Checking…"];
  if (state.status !== "ready") return ["warn", "Unavailable"];
  const rows = Array.isArray(state.value) ? state.value : [state.value];
  if (!rows.length) return ["warn", "No resolvers observed"];
  const mullvad = rows.every((row) => row.isMullvad);
  const seen = Array.isArray(state.value)
    ? plural(rows.length, "resolver")
    : rows[0]?.ip;
  return [
    mullvad ? "on" : "error",
    `${mullvad ? "Mullvad" : "Not Mullvad"} · ${seen}`,
  ];
}

export function exitStatus(snapshot: Snapshot): [Tone, string] {
  const { ipv4, ipv6 } = snapshot.diagnostics;
  const ready = [ipv4, ipv6].filter((state) => state.status === "ready");
  // A non-Mullvad address on either family outranks any Mullvad result.
  return checkStatus(
    ready.find((state) => !state.value.isMullvad) ?? ready[0] ?? ipv4,
  );
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

export async function resolveUiContext(): Promise<BrowserContext> {
  const window = await chrome.windows.getCurrent({}).catch(() => undefined);
  if (typeof window?.incognito !== "boolean")
    throw new Error(
      "Cannot determine this window's browsing context. Close and reopen this page.",
    );
  return window.incognito ? "incognito" : "regular";
}

export async function currentWebsiteTab(
  context: BrowserContext,
): Promise<{ id: number; url: string }> {
  if (!(await chrome.permissions.contains({ permissions: ["tabs"] })))
    throw new Error(
      "Tab access is unavailable. Enable active-website reload again in regular settings to grant access, or reload manually.",
    );
  const window = await chrome.windows.getCurrent({}).catch(() => {
    throw new Error("Cannot read this browsing window.");
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
