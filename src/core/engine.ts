import { getDomain } from "tldts";
import type { RouteDecision, RoutingContext } from "../shared/state";

// This closure is serialized into PAC: keep it platform-independent and self-contained.
export function createEngine(domainOf: (host: string) => string | null) {
  function ipv4(host: string): number[] | null {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    const bytes = host.split(".").map(Number);
    return bytes.every((n) => n <= 255) ? bytes : null;
  }
  function ipv6(host: string): number[] | null {
    if (!host.includes(":")) return null;
    let text = host;
    if (text.includes(".")) {
      const i = text.lastIndexOf(":");
      const v4 = ipv4(text.slice(i + 1));
      if (!v4) return null;
      text = `${text.slice(0, i)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
    }
    if (!/^[0-9a-f:]+$/.test(text) || text.split("::").length > 2) return null;
    const sides = text.split("::");
    const left = sides[0] ? sides[0].split(":") : [];
    const right = sides.length === 2 && sides[1] ? sides[1].split(":") : [];
    const count = left.length + right.length;
    if (sides.length === 1 ? count !== 8 : count >= 8) return null;
    const parts = [
      ...left,
      ...Array(sides.length === 2 ? 8 - count : 0).fill("0"),
      ...right,
    ];
    if (parts.some((s) => !/^[0-9a-f]{1,4}$/.test(s))) return null;
    return parts.map((s) => Number.parseInt(s, 16));
  }
  function canonical(input: string): string | null {
    if (typeof input !== "string" || !input || input !== input.trim())
      return null;
    let host = input.toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    if (host.includes(":")) {
      const words = ipv6(host);
      return words ? words.map((n) => n.toString(16)).join(":") : null;
    }
    if (host.endsWith(".")) host = host.slice(0, -1);
    const bytes = ipv4(host);
    if (bytes) return bytes.join(".");
    if (/^[\d.]+$/.test(host) || host.length > 253) return null;
    if (
      !host
        .split(".")
        .every((s) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s))
    )
      return null;
    return host;
  }
  function local(host: string): boolean {
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    const a = ipv4(host);
    if (a)
      return (
        a[0] === 10 ||
        a[0] === 127 ||
        (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
        (a[0] === 192 && a[1] === 168) ||
        (a[0] === 169 && a[1] === 254) ||
        (a[0] >= 224 && a[0] <= 239)
      );
    const b = ipv6(host);
    if (!b) return false;
    if (b.slice(0, 5).every((n) => n === 0) && b[5] === 65535)
      return local(`${b[6] >> 8}.${b[6] & 255}.${b[7] >> 8}.${b[7] & 255}`);
    return (
      (b.slice(0, 7).every((n) => n === 0) && b[7] === 1) ||
      (b[0] & 0xfe00) === 0xfc00 ||
      (b[0] & 0xffc0) === 0xfe80 ||
      (b[0] & 0xff00) === 0xff00
    );
  }
  function route(input: string, context: RoutingContext): RouteDecision {
    const host = canonical(input);
    if (!host)
      return {
        kind: "blocked",
        reason:
          "Invalid destination host (use ASCII/Punycode DNS names or IP literals)",
      };
    if (local(host)) return { kind: "direct", reason: "local" };
    const settings = context.settings;
    const parent =
      host.includes(":") || ipv4(host) ? host : domainOf(host) || host;
    let id: string | null = null;
    let source: "random" | "exact" | "parent" | "global" = "global";
    if (settings.randomMode) {
      if (!context.sessionSeed)
        return {
          kind: "blocked",
          reason: "Random routing requires a persisted session seed",
        };
      const pool = context.servers
        .filter((s) => s.online)
        .slice()
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (!pool.length)
        return { kind: "blocked", reason: "No online random proxy servers" };
      let hash = 2166136261;
      const key = `${context.sessionSeed}\u0000${parent}`;
      for (let i = 0; i < key.length; i++)
        hash = Math.imul(hash ^ key.charCodeAt(i), 16777619) >>> 0;
      id = pool[hash % pool.length].id;
      source = "random";
    } else {
      if (
        settings.exclusions.includes(host) ||
        settings.exclusions.includes(parent)
      )
        return { kind: "direct", reason: "excluded" };
      const exact = settings.rules.find((r) => r.host === host && r.enabled);
      const inherited = settings.rules.find(
        (r) => r.host === parent && r.enabled,
      );
      if (exact) {
        id = exact.serverId;
        source = "exact";
      } else if (inherited) {
        id = inherited.serverId;
        source = "parent";
      } else if (settings.enabled) id = settings.globalServerId;
      else
        return {
          kind: "direct",
          reason: settings.rules.length ? "unmatched" : "disabled",
        };
    }
    if (!id)
      return {
        kind: "blocked",
        reason: "Enabled route has no proxy selection",
      };
    if (id === "internal-default")
      return {
        kind: "proxy",
        serverId: id,
        endpoint: { host: "10.64.0.1", port: 1080 },
        source,
      };
    const server = context.servers.find((s) => s.id === id);
    if (
      !server?.online ||
      typeof server.ipv4 !== "string" ||
      !ipv4(server.ipv4) ||
      !Number.isInteger(server.port) ||
      server.port < 1 ||
      server.port > 65535
    )
      return {
        kind: "blocked",
        reason: `Missing, offline or invalid proxy: ${id}`,
      };
    return {
      kind: "proxy",
      serverId: id,
      endpoint: { host: server.ipv4, port: server.port },
      source,
    };
  }
  return { canonical, ipv4, ipv6, route };
}
export const engine = createEngine((host) => getDomain(host));
