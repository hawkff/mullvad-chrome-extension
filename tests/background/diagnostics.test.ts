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
