import {
  INTERNAL_DEFAULT_SERVER_ID,
  type ProxyStatus,
  type RoutingSettings,
  type Server,
} from "./state";

export type Tone = "on" | "off" | "warn" | "error";
export const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

// One summary for the popup status card and the toolbar button.
export function proxyStatus(
  effective: ProxyStatus,
  routing: RoutingSettings,
  servers: readonly Server[],
) {
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
        `Rules for ${plural(rules, "website")}. Other websites connect directly.`,
      );
    const server = servers.find((row) => row.id === routing.globalServerId);
    const via = server
      ? `${server.city}, ${server.country}`
      : routing.globalServerId === INTERNAL_DEFAULT_SERVER_ID
        ? "your VPN server"
        : "an unavailable server";
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
