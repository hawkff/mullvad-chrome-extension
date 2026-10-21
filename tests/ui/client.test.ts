import { describe, expect, test } from "bun:test";
import {
  freshness,
  isImportPreview,
  isSnapshot,
  searchServers,
  validateResponse,
} from "../../src/ui/client";
import { fixture } from "./fixture";

describe("UI command response boundary", () => {
  test("accepts complete snapshots, rejects malformed nested state", () => {
    expect(isSnapshot(fixture)).toBe(true);
    expect(isSnapshot({ ...fixture, privacy: null })).toBe(false);
    expect(
      isSnapshot({
        ...fixture,
        servers: { status: "ready", value: [{}], updatedAt: 1 },
      }),
    ).toBe(false);
    expect(
      isSnapshot({
        ...fixture,
        diagnostics: { ...fixture.diagnostics, scope: "active-tab" },
      }),
    ).toBe(false);
    expect(
      isSnapshot({
        ...fixture,
        incognitoProxy: { ...fixture.incognitoProxy, ownership: "mine" },
      }),
    ).toBe(false);
  });
  test("validates result against command and preserves actionable errors", () => {
    expect(
      validateResponse({ type: "snapshot" }, { ok: true, value: fixture }),
    ).toBe(true);
    expect(
      validateResponse(
        { type: "settings.export" },
        { ok: true, value: fixture },
      ),
    ).toBe(false);
    expect(
      validateResponse(
        { type: "snapshot" },
        {
          ok: false,
          error: { code: "permission-denied", message: "Allow access" },
        },
      ),
    ).toBe(true);
    expect(
      validateResponse({ type: "snapshot" }, { ok: false, error: {} }),
    ).toBe(false);
  });
  test("rejects regular snapshots for private-context requests", () => {
    expect(
      validateResponse(
        { type: "snapshot", context: "incognito" },
        { ok: true, value: fixture },
      ),
    ).toBe(false);
  });
  test("Firefox previews permit omitted preferences and random mode", () => {
    const { randomMode: _, ...routing } = fixture.settings.routing;
    expect(isImportPreview({ format: "firefox", routing })).toBe(true);
    expect(isImportPreview({ format: "chrome-only", routing })).toBe(false);
  });
});
test("location search combines country, city and hostname case-insensitively", () => {
  if (fixture.servers.status !== "ready")
    throw new Error("Test fixture is not ready");
  expect(
    searchServers(fixture.servers.value, "SWEDEN got").map(
      (server) => server.id,
    ),
  ).toEqual(["se-got-001"]);
  expect(searchServers(fixture.servers.value, "zzzz")).toEqual([]);
  expect(
    searchServers(fixture.servers.value, "").map((server) => server.country),
  ).toEqual(["Germany", "Sweden"]);
});
test("freshness distinguishes unknown, blocked and stale data", () => {
  expect(freshness({ status: "unknown" })).toBe("Not checked");
  expect(
    freshness({ status: "blocked", message: "Incognito unavailable" }),
  ).toContain("Incognito unavailable");
  expect(freshness({ status: "ready", updatedAt: 1, value: [] })).toContain(
    "Stale cached data",
  );
  expect(
    freshness({ status: "ready", updatedAt: Date.now(), value: [] }),
  ).toContain("Fresh cached data");
});
