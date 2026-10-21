export type BrowserContext = "regular" | "incognito";
export const INTERNAL_DEFAULT_SERVER_ID = "internal-default";

export type LoadState<T> =
  | { status: "unknown" | "pending" }
  | { status: "ready"; value: T; updatedAt: number }
  | { status: "offline" | "blocked" | "error"; message: string };

export interface Server {
  id: string;
  hostname: string;
  ipv4: string;
  ipv6: string;
  port: number;
  online: boolean;
  country: string;
  countryCode: string;
  city: string;
}
export interface ProxyEndpoint {
  host: string;
  port: number;
}
export interface SiteRule {
  host: string;
  enabled: boolean;
  serverId: string;
}
export interface RoutingSettings {
  enabled: boolean;
  globalServerId: string | null;
  randomMode: boolean;
  rules: SiteRule[];
  exclusions: string[];
}
export interface Preferences {
  autoReload: boolean;
  historyEnabled: boolean;
}
export interface Settings {
  routing: RoutingSettings;
  preferences: Preferences;
}
export type ProxyOwnership =
  | "unknown"
  | "not_controllable"
  | "controlled_by_other_extensions"
  | "controllable_by_this_extension"
  | "controlled_by_this_extension";
export interface ProxyStatus {
  ownership: ProxyOwnership;
  permissionGranted: boolean;
  applied: boolean;
  status: "unknown" | "pending" | "ready" | "offline" | "blocked" | "error";
  message?: string;
  scope: BrowserContext;
  settingScope:
    | "regular"
    | "regular_only"
    | "incognito_persistent"
    | "incognito_session_only"
    | "unknown";
}
export type RouteDecision =
  | { kind: "direct"; reason: "local" | "excluded" | "disabled" | "unmatched" }
  | {
      kind: "proxy";
      serverId: string;
      endpoint: ProxyEndpoint;
      source: "random" | "exact" | "parent" | "global";
    }
  | { kind: "blocked"; reason: string };
export interface RoutingContext {
  settings: RoutingSettings;
  servers: Server[];
  sessionSeed: string;
}
export interface HistoryEntry {
  serverId: string;
  hostname: string;
  country: string;
  countryCode: string;
  city: string;
  count: number;
  lastUsedAt: number;
}
export interface ConnectionObservation {
  ip: string;
  isMullvad: boolean;
  country?: string;
  city?: string;
  server?: string;
  provider?: string;
}
export interface DnsObservation {
  ip: string;
  isMullvad: boolean;
  hostname: string;
  country?: string;
  organization?: string;
}
export interface Diagnostics {
  scope: "browser-route";
  ipv4: LoadState<ConnectionObservation>;
  ipv6: LoadState<ConnectionObservation>;
  dns: LoadState<DnsObservation[]>;
}
export interface PrivacyStatus {
  permissionGranted: boolean;
  webRtc: {
    ownership: ProxyOwnership;
    value: string | null;
  };
  networkPrediction: {
    ownership: ProxyOwnership;
    value: boolean | null;
  };
}
export interface SettingsExport {
  version: 1;
  settings: Settings;
  history: HistoryEntry[];
}
export interface ImportPreview {
  format: "native" | "firefox";
  routing: Omit<RoutingSettings, "randomMode"> & { randomMode?: boolean };
  preferences?: Preferences;
  history?: HistoryEntry[];
}
export interface Snapshot {
  context: BrowserContext;
  incognitoAllowed: boolean;
  revision: number;
  settings: Settings;
  servers: LoadState<Server[]>;
  proxy: ProxyStatus;
  incognitoProxy: ProxyStatus;
  diagnostics: Diagnostics;
  privacy: PrivacyStatus;
  history: HistoryEntry[];
}
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
