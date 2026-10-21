import { afterEach, expect, test } from "bun:test";
import {
  connection,
  dns,
  runDiagnostics,
} from "../../src/background/diagnostics";
import { requestJson } from "../../src/background/platform";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test("strict diagnostic observations and DNS shapes", () => {
  expect(connection({ ip: "1.2.3.4", mullvad_exit_ip: true }).isMullvad).toBe(
    true,
  );
  expect(() =>
    connection({ ip: "999.2.3.4", mullvad_exit_ip: false }),
  ).toThrow();
  expect(() => dns([{ ip: "1.2.3.4", mullvad_dns: "yes" }])).toThrow();
  expect(
    dns([{ ip: "1.2.3.4", mullvad_dns: false, mullvad_dns_hostname: "" }])[0]
      ?.isMullvad,
  ).toBe(false);
});
test("rejects unapproved origins before fetch", async () => {
  globalThis.fetch = (() => {
    throw new Error("must not fetch");
  }) as unknown as typeof fetch;
  await expect(
    requestJson("https://mullvad.net.evil.org/json"),
  ).rejects.toThrow("Unapproved");
});
test("HTTP and JSON errors stay explicit and do not contain network metadata", async () => {
  globalThis.fetch = (async () =>
    new Response("private metadata", {
      status: 500,
    })) as unknown as typeof fetch;
  const result = await runDiagnostics(["ipv4", "dns"]);
  expect(result.ipv4.status).toBe("error");
  expect(result.dns.status).toBe("error");
  expect(JSON.stringify(result)).not.toContain("private metadata");
});
test("bounded request aborts on timeout", async () => {
  const previous = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void) =>
    previous(callback, 1)) as typeof setTimeout;
  globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    })) as unknown as typeof fetch;
  try {
    await expect(
      requestJson("https://ipv4.am.i.mullvad.net/json"),
    ).rejects.toThrow("aborted");
  } finally {
    globalThis.setTimeout = previous;
  }
});

test("JSON requests negotiate DNS JSON without changing request restrictions", async () => {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    expect(init).toMatchObject({
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (new Headers(init?.headers).get("Accept") !== "application/json")
      return new Response("not JSON", {
        headers: { "Content-Type": "text/plain" },
      });
    return Response.json([{ ip: "192.0.2.1", mullvad_dns: false }]);
  }) as unknown as typeof fetch;
  expect(
    dns(await requestJson("https://abcd.dnsleak.am.i.mullvad.net/")),
  ).toEqual([
    {
      ip: "192.0.2.1",
      isMullvad: false,
      hostname: "",
      country: undefined,
      organization: undefined,
    },
  ]);
});

test("DNS permits an absent optional hostname but rejects other invalid metadata", () => {
  const row = { ip: "192.0.2.1", mullvad_dns: false };
  expect(dns([row])[0]?.hostname).toBe("");
  for (const hostname of [null, 3, false, "x".repeat(257)])
    expect(() => dns([{ ...row, mullvad_dns_hostname: hostname }])).toThrow();
});

test("DNS samples six independent UUID names and deduplicates resolver IPs", async () => {
  const hosts: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    hosts.push(new URL(String(input)).hostname);
    return Response.json([
      {
        ip: "192.0.2.1",
        mullvad_dns: false,
        mullvad_dns_hostname: `resolver-${hosts.length}`,
      },
      {
        ip: hosts.length === 6 ? "192.0.2.2" : "192.0.2.1",
        mullvad_dns: false,
      },
    ]);
  }) as unknown as typeof fetch;
  const result = await runDiagnostics(["dns"]);
  expect(hosts).toHaveLength(6);
  expect(new Set(hosts).size).toBe(6);
  expect(
    hosts.every((host) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.dnsleak\.am\.i\.mullvad\.net$/.test(
        host,
      ),
    ),
  ).toBe(true);
  expect(result.dns.status).toBe("ready");
  if (result.dns.status !== "ready")
    throw new Error("Expected complete DNS sample");
  expect(result.dns.value.map((row) => row.ip)).toEqual([
    "192.0.2.1",
    "192.0.2.2",
  ]);
  expect(result.dns.value[0]?.hostname).toBe("resolver-6");
  expect(result.ipv4.status).toBe("unknown");
  expect(result.ipv6.status).toBe("unknown");
});

test("one failed DNS probe rejects the whole sample without partial observations", async () => {
  for (const failure of ["http", "json", "parse"]) {
    let calls = 0;
    globalThis.fetch = (async () => {
      if (++calls === 3) {
        if (failure === "http")
          return new Response("unavailable", { status: 503 });
        if (failure === "json") return new Response("private metadata");
        return Response.json([{ ip: "invalid" }]);
      }
      return Response.json([{ ip: "192.0.2.1", mullvad_dns: false }]);
    }) as unknown as typeof fetch;
    const result = await runDiagnostics(["dns"]);
    expect(calls).toBe(6);
    expect(result.dns.status).toBe("error");
    expect(result.dns).not.toHaveProperty("value");
    expect(JSON.stringify(result)).not.toContain("private metadata");
  }
});
