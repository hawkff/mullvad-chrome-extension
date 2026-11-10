import type { Command } from "../shared/messages";
import type {
  ImportPreview,
  RouteDecision,
  RoutingContext,
  Server,
  ValidationResult,
} from "../shared/state";
import { createEngine, engine } from "./engine";
import { publicSuffixSource } from "./public-suffix";
import {
  checked,
  command,
  host,
  imported,
  persisted,
  routing,
  servers,
} from "./validation";

export function canonicalHost(input: string): ValidationResult<string> {
  return checked(() => host(input));
}
export function resolveRoute(
  host: string,
  context: RoutingContext,
): RouteDecision {
  const valid = checked(() => routing(context.settings));
  if (!valid.ok) return { kind: "blocked", reason: valid.error };
  const canonical = canonicalHost(host);
  if (!canonical.ok) return { kind: "blocked", reason: canonical.error };
  return engine.route(canonical.value, { ...context, settings: valid.value });
}
export function generatePac(context: RoutingContext): string {
  const valid = checked(() => routing(context.settings));
  // Services must apply this PAC with mandatory:true so runtime errors cannot fall back to DIRECT.
  if (!valid.ok)
    return 'function FindProxyForURL(){throw new Error("Invalid routing configuration");}';
  const settings = valid.value;
  // Chrome stores the PAC in the profile and hands it back on every status read, so it carries
  // only the servers its routes can pick: the online pool in random mode, else the chosen ones.
  const used = new Set(
    settings.randomMode
      ? context.servers
          .filter((server) => server.online)
          .map((server) => server.id)
      : [
          settings.globalServerId,
          ...settings.rules.map((rule) => rule.serverId),
        ],
  );
  const data = JSON.stringify({
    settings,
    servers: context.servers
      .filter((server) => used.has(server.id))
      .map(({ id, ipv4, port, online }) => ({ id, ipv4, port, online })),
    // Every mode keeps the seed. The private seed is also what makes an Incognito PAC differ from
    // the regular one, which is how the worker tells an installed override from an inherited setting.
    sessionSeed: context.sessionSeed,
  })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  // Chrome rejects non-ASCII PAC data, including embedded suffix tables and metadata.
  return `var exports=undefined,module=undefined;\n${publicSuffixSource}\nvar routingEngine=(${createEngine.toString()})(function(host){return tldts.getDomain(host);});\nvar routingContext=${data};\nfunction FindProxyForURL(url,host){var route=routingEngine.route(host,routingContext);if(route.kind==="direct")return "DIRECT";if(route.kind==="blocked")throw new Error("Routing blocked: "+route.reason);return "SOCKS5 "+route.endpoint.host+":"+route.endpoint.port;}`.replace(
    /[^\x20-\x7e\n\r\t]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
export function validateServers(input: unknown): ValidationResult<Server[]> {
  return checked(() => servers(input));
}
export function validateImport(
  input: unknown,
  servers: readonly Server[],
): ValidationResult<ImportPreview> {
  return checked(() => imported(input, servers));
}
export function validateCommand(input: unknown): ValidationResult<Command> {
  return checked(() => command(input));
}

export function validatePersistedSettings(
  input: unknown,
): ValidationResult<ImportPreview> {
  return checked(() => persisted(input));
}
