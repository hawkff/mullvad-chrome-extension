import type { Command } from "../shared/messages";
import {
  type HistoryEntry,
  type ImportPreview,
  INTERNAL_DEFAULT_SERVER_ID,
  type RoutingSettings,
  type Server,
  type ValidationResult,
} from "../shared/state";
import { engine } from "./engine";

type ObjectValue = Record<string, unknown>;
export function object(input: unknown, path = "value"): ObjectValue {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error(`${path} must be an object`);
  return input as ObjectValue;
}
export function keys(
  value: ObjectValue,
  allowed: string[],
  required = allowed,
) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`Unsupported field: ${key}`);
  for (const key of required)
    if (!Object.hasOwn(value, key)) throw new Error(`Missing field: ${key}`);
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024)
    throw new Error("Expected a nonempty string");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Expected a boolean");
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`Expected integer ${min}..${max}`);
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw new Error("Expected an array with at most 10000 items");
  return value;
}
export function checked<T>(run: () => T): ValidationResult<T> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid input",
    };
  }
}
export function host(value: unknown): string {
  const input = string(value);
  if (
    input !== input.trim() ||
    /[\s/@?#\\%]/u.test(input) ||
    (!input.startsWith("[") && input.includes(":"))
  ) {
    // Bare IPv6 is accepted, but a DNS name with a port is not.
    if (!engine.ipv6(input.toLowerCase()))
      throw new Error("Expected a host only, without URL syntax or a port");
  }
  let ascii = input;
  if (Array.from(input).some((character) => character.charCodeAt(0) > 127)) {
    ascii = new URL(`http://${input}`).hostname;
  }
  const result = engine.canonical(ascii);
  if (!result)
    throw new Error(
      "Invalid host: use a hostname, not a URL, path, port or wildcard",
    );
  return result;
}
function hosts(value: unknown): string[] {
  const result = array(value).map(host);
  if (new Set(result).size !== result.length)
    throw new Error("Canonical host collision");
  return result;
}
function serverId(value: unknown, servers: readonly Server[]): string {
  const id = string(value);
  if (id !== INTERNAL_DEFAULT_SERVER_ID && !servers.some((s) => s.id === id))
    throw new Error(
      `Unknown server: ${id}; refresh servers or select a supported endpoint`,
    );
  return id;
}
function rule(value: unknown) {
  const v = object(value);
  keys(v, ["host", "enabled", "serverId"]);
  return {
    host: host(v.host),
    enabled: boolean(v.enabled),
    serverId: string(v.serverId),
  };
}
export function routing(value: unknown): RoutingSettings {
  const v = object(value);
  keys(v, ["enabled", "globalServerId", "randomMode", "rules", "exclusions"]);
  const rules = array(v.rules).map(rule);
  if (new Set(rules.map((r) => r.host)).size !== rules.length)
    throw new Error("Canonical rule collision");
  const id = v.globalServerId === null ? null : string(v.globalServerId);
  if (v.enabled === true && id === null)
    throw new Error("Enabled global route requires a server");
  return {
    enabled: boolean(v.enabled),
    globalServerId: id,
    randomMode: boolean(v.randomMode),
    rules,
    exclusions: hosts(v.exclusions),
  };
}
function preferences(value: unknown) {
  const v = object(value);
  keys(v, ["autoReload", "historyEnabled"]);
  return {
    autoReload: boolean(v.autoReload),
    historyEnabled: boolean(v.historyEnabled),
  };
}
function history(value: unknown): HistoryEntry[] {
  const result = array(value).map((item) => {
    const v = object(item);
    keys(v, [
      "serverId",
      "hostname",
      "country",
      "countryCode",
      "city",
      "count",
      "lastUsedAt",
    ]);
    return {
      serverId: string(v.serverId),
      hostname: host(v.hostname),
      country: string(v.country),
      countryCode: string(v.countryCode),
      city: string(v.city),
      count: integer(v.count, 1, Number.MAX_SAFE_INTEGER),
      lastUsedAt: integer(v.lastUsedAt, 0, Number.MAX_SAFE_INTEGER),
    };
  });
  if (new Set(result.map((r) => r.serverId)).size !== result.length)
    throw new Error("Duplicate history server");
  return result;
}
export function servers(input: unknown): Server[] {
  const result = array(input).map((item) => {
    const v = object(item);
    const location = object(v.location, "server.location");
    const hostname = host(v.hostname);
    const ipv4 = string(v.ipv4_address);
    const ipv6 = string(v.ipv6_address);
    if (
      !engine.ipv4(ipv4) ||
      !engine.ipv6(ipv6.toLowerCase().replace(/^\[|\]$/g, ""))
    )
      throw new Error(`Invalid server IP: ${hostname}`);
    return {
      id: hostname,
      hostname,
      ipv4: engine.ipv4(ipv4)?.join(".") || ipv4,
      ipv6,
      port: integer(v.port, 1, 65535),
      online: boolean(v.online),
      country: string(location.country),
      countryCode:
        typeof location.countryCode === "string"
          ? string(location.countryCode)
          : string(hostname.split("-")[0]).slice(0, 2).toUpperCase(),
      city: string(location.city),
    };
  });
  if (new Set(result.map((s) => s.id)).size !== result.length)
    throw new Error("Duplicate server hostname");
  return result;
}
function firefoxProxy(
  proxy: unknown,
  details: unknown,
  catalog: readonly Server[],
) {
  const p = object(proxy, "proxy");
  const d = object(details, "proxy details");
  keys(p, ["type", "host", "port", "proxyDNS"], []);
  keys(
    d,
    ["socksEnabled", "server", "country", "countryCode", "city", "proxyDNS"],
    [],
  );
  const enabled =
    !Object.keys(d).length && !Object.keys(p).length
      ? false
      : boolean(d.socksEnabled);
  for (const k of ["server", "country", "countryCode", "city"])
    if (d[k] !== undefined && typeof d[k] !== "string")
      throw new Error(`Invalid proxy details ${k}`);
  if (
    (p.proxyDNS !== undefined && boolean(p.proxyDNS) === false) ||
    (d.proxyDNS !== undefined && boolean(d.proxyDNS) === false)
  )
    throw new Error(
      "proxyDNS=false is incompatible: Chrome SOCKS5 does not support a per-site DNS toggle",
    );
  if (!Object.keys(p).length && !enabled) return { enabled, serverId: null };
  if (p.type !== "socks")
    throw new Error("Only Firefox SOCKS5 (type=socks) proxies are supported");
  const endpoint = host(p.host);
  const port = integer(p.port, 1, 65535);
  const id =
    endpoint === "10.64.0.1" && port === 1080
      ? INTERNAL_DEFAULT_SERVER_ID
      : catalog.find(
          (s) =>
            (s.ipv4 === endpoint || s.hostname === endpoint) && s.port === port,
        )?.id;
  if (!id)
    throw new Error(
      `Unrecognized proxy endpoint ${endpoint}:${port}; refresh the server catalog or choose a Mullvad server`,
    );
  const upstreamName = id
    .replace("wg-socks5-", "")
    .replace(".relays.mullvad.net", "");
  if (
    d.server &&
    id !== INTERNAL_DEFAULT_SERVER_ID &&
    d.server !== id &&
    d.server !== upstreamName
  )
    throw new Error(
      `Proxy details server does not match endpoint: ${d.server}`,
    );
  return { enabled, serverId: id };
}
// Saved intent and history outlive catalog membership; imports check availability separately.
export function persisted(input: unknown): ImportPreview {
  const v = object(input);
  keys(v, ["version", "settings", "history"]);
  if (v.version !== 1) throw new Error("Unsupported native settings version");
  const settings = object(v.settings);
  keys(settings, ["routing", "preferences"]);
  return {
    format: "native",
    routing: routing(settings.routing),
    preferences: preferences(settings.preferences),
    history: history(v.history),
  };
}
export function imported(
  input: unknown,
  catalog: readonly Server[],
): ImportPreview {
  const v = object(input);
  if (Object.hasOwn(v, "version")) {
    const result = persisted(input);
    const route = result.routing;
    if (route.globalServerId !== null) serverId(route.globalServerId, catalog);
    for (const rule of route.rules) serverId(rule.serverId, catalog);
    return result;
  }
  keys(v, [
    "excludedHosts",
    "globalProxy",
    "globalProxyDetails",
    "hostProxies",
    "hostProxiesDetails",
  ]);
  const global = firefoxProxy(v.globalProxy, v.globalProxyDetails, catalog);
  const proxies = object(v.hostProxies);
  const details = object(v.hostProxiesDetails);
  const rules = Object.keys(proxies).map((key) => {
    if (!Object.hasOwn(details, key))
      throw new Error(`Missing proxy details for ${key}`);
    const converted = firefoxProxy(proxies[key], details[key], catalog);
    if (!converted.serverId)
      throw new Error(`Site rule ${key} has no proxy endpoint`);
    return {
      host: host(key),
      enabled: converted.enabled,
      serverId: converted.serverId,
    };
  });
  if (Object.keys(details).some((key) => !Object.hasOwn(proxies, key)))
    throw new Error("Orphaned site proxy details");
  if (new Set(rules.map((r) => r.host)).size !== rules.length)
    throw new Error("Canonical rule collision");
  return {
    format: "firefox",
    routing: {
      enabled: global.enabled,
      globalServerId: global.serverId,
      rules,
      exclusions: hosts(v.excludedHosts),
    },
  };
}
export function command(input: unknown): Command {
  const v = object(input);
  const type = string(v.type);
  if (
    v.context !== undefined &&
    v.context !== "regular" &&
    v.context !== "incognito"
  )
    throw new Error("Invalid browser context");
  let fields: string[] = [];
  let result: Command;
  switch (type) {
    case "snapshot":
    case "servers.refresh":
    case "history.clear":
    case "settings.export":
      result = { type };
      break;
    case "settings.import":
    case "settings.import.preview":
      fields = ["data"];
      result = { type, data: v.data };
      break;
    case "settings.update": {
      fields = ["patch"];
      const patch = object(v.patch);
      keys(
        patch,
        ["autoReload", "historyEnabled", "enabled", "randomMode"],
        [],
      );
      for (const value of Object.values(patch)) boolean(value);
      result = { type, patch };
      break;
    }
    case "server.select":
      fields = ["serverId", "host"];
      result = {
        type,
        serverId: string(v.serverId),
        ...(v.host === undefined ? {} : { host: host(v.host) }),
      };
      break;
    case "rule.upsert":
      fields = ["rule"];
      result = { type, rule: rule(v.rule) };
      break;
    case "rule.remove":
      fields = ["host"];
      result = { type, host: host(v.host) };
      break;
    case "exclusion.set":
      fields = ["host", "excluded"];
      result = { type, host: host(v.host), excluded: boolean(v.excluded) };
      break;
    case "history.remove":
      fields = ["serverId"];
      result = { type, serverId: string(v.serverId) };
      break;
    case "privacy.set":
    case "privacy.restore": {
      fields = type === "privacy.set" ? ["control", "enabled"] : ["control"];
      if (
        v.control !== "webRtcNonProxiedUdp" &&
        v.control !== "networkPrediction"
      )
        throw new Error("Unsupported privacy control");
      result =
        type === "privacy.set"
          ? { type, control: v.control, enabled: boolean(v.enabled) }
          : { type, control: v.control };
      break;
    }
    case "diagnostics.run": {
      fields = ["checks"];
      const checks = array(v.checks).map((c) => {
        if (c !== "ipv4" && c !== "ipv6" && c !== "dns")
          throw new Error("Unsupported diagnostic");
        return c;
      });
      if (!checks.length || new Set(checks).size !== checks.length)
        throw new Error("Checks must be nonempty and unique");
      result = { type, checks };
      break;
    }
    default:
      throw new Error(`Unsupported command: ${type}`);
  }
  keys(
    v,
    ["type", "context", ...fields],
    [
      "type",
      ...fields.filter((f) => !(type === "server.select" && f === "host")),
    ],
  );
  return {
    ...result,
    ...(v.context === undefined ? {} : { context: v.context }),
  };
}
