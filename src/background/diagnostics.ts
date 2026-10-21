import type {
  ConnectionObservation,
  Diagnostics,
  DnsObservation,
  LoadState,
} from "../shared/state";
import { object, requestJson } from "./platform";

function ip(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 45) return false;
  if (value.includes(":")) {
    try {
      return new URL(`http://[${value}]/`).hostname.length > 2;
    } catch {
      return false;
    }
  }
  return (
    /^(\d{1,3}\.){3}\d{1,3}$/.test(value) &&
    value.split(".").every((part) => Number(part) <= 255)
  );
}
function optional(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 256)
    throw new Error("Invalid diagnostic response");
  return value;
}
export function connection(input: unknown): ConnectionObservation {
  if (
    !object(input) ||
    !ip(input.ip) ||
    typeof input.mullvad_exit_ip !== "boolean"
  )
    throw new Error("Invalid connection response");
  return {
    ip: input.ip,
    isMullvad: input.mullvad_exit_ip,
    country: optional(input.country),
    city: optional(input.city),
    server: optional(input.mullvad_exit_ip_hostname),
    provider: optional(input.organization),
  };
}
export function dns(input: unknown): DnsObservation[] {
  if (!Array.isArray(input) || input.length > 100)
    throw new Error("Invalid DNS response");
  return input.map((row: unknown) => {
    if (
      !object(row) ||
      !ip(row.ip) ||
      typeof row.mullvad_dns !== "boolean" ||
      (row.mullvad_dns_hostname !== undefined &&
        (typeof row.mullvad_dns_hostname !== "string" ||
          row.mullvad_dns_hostname.length > 256))
    )
      throw new Error("Invalid DNS response");
    return {
      ip: row.ip,
      isMullvad: row.mullvad_dns,
      hostname:
        row.mullvad_dns_hostname === undefined ? "" : row.mullvad_dns_hostname,
      country: optional(row.country),
      organization: optional(row.organization),
    };
  });
}
async function check<T>(load: () => Promise<T>): Promise<LoadState<T>> {
  try {
    return {
      status: "ready",
      value: await load(),
      updatedAt: Date.now(),
    };
  } catch {
    return {
      status: "error",
      message:
        "Check unavailable, timed out, or returned invalid data. This is not proof of a leak or VPN failure.",
    };
  }
}
export function emptyDiagnostics(): Diagnostics {
  return {
    scope: "browser-route",
    ipv4: { status: "unknown" },
    ipv6: { status: "unknown" },
    dns: { status: "unknown" },
  };
}
export async function runDiagnostics(
  checks: ("ipv4" | "ipv6" | "dns")[],
): Promise<Diagnostics> {
  const result = emptyDiagnostics();
  await Promise.all(
    checks.map(async (name) => {
      if (name === "dns")
        result.dns = await check(async () => {
          const samples = await Promise.all(
            Array.from({ length: 6 }, async () =>
              dns(
                await requestJson(
                  `https://${crypto.randomUUID()}.dnsleak.am.i.mullvad.net/`,
                ),
              ),
            ),
          );
          return [
            ...new Map(samples.flat().map((row) => [row.ip, row])).values(),
          ];
        });
      else
        result[name] = await check(async () =>
          connection(
            await requestJson(`https://${name}.am.i.mullvad.net/json`),
          ),
        );
    }),
  );
  return result;
}
