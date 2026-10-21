import { describe, expect, test } from "bun:test";
import {
  currentWebsiteTab,
  freshness,
  incognitoScopeDescription,
  isImportPreview,
  isSnapshot,
  resolveUiContext,
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
  expect(freshness({ status: "ready", updatedAt: 0, value: [] })).toContain(
    "unknown time",
  );
  expect(
    freshness({ status: "ready", updatedAt: Date.now(), value: [] }),
  ).toContain("Fresh cached data");
});

test("Incognito scope labels distinguish inheritance, overrides and unknown state", () => {
  const proxy = { ...fixture.incognitoProxy, applied: true };
  expect(
    incognitoScopeDescription({ ...proxy, settingScope: "regular" }),
  ).toContain("Inherited regular routing");
  expect(
    incognitoScopeDescription({
      ...proxy,
      settingScope: "incognito_session_only",
    }),
  ).toContain("last Incognito window closes");
  expect(incognitoScopeDescription(proxy)).toContain("has not confirmed");
  expect(
    incognitoScopeDescription({
      ...proxy,
      applied: false,
      settingScope: "regular",
    }),
  ).not.toContain("Inherited");
});

test("window context resolves before UI mount and never defaults on failure", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  try {
    for (const incognito of [true, false]) {
      Object.defineProperty(globalThis, "chrome", {
        configurable: true,
        value: { windows: { getCurrent: async () => ({ incognito }) } },
      });
      expect(await resolveUiContext()).toBe(
        incognito ? "incognito" : "regular",
      );
    }
    for (const getCurrent of [
      async () => ({}),
      async () => {
        throw new Error("unavailable");
      },
    ]) {
      Object.defineProperty(globalThis, "chrome", {
        configurable: true,
        value: { windows: { getCurrent } },
      });
      await expect(resolveUiContext()).rejects.toThrow("Cannot determine");
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "chrome", previous);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("active website lookup uses its hosting window and rejects stale/unsafe targets", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  let allowed = true;
  let window = { id: 7, incognito: false };
  let tab = {
    id: 4,
    windowId: 7,
    active: true,
    incognito: false,
    url: "https://example.com",
  };
  try {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        permissions: { contains: async () => allowed },
        windows: { getCurrent: async () => window },
        tabs: {
          query: async (query: object) => {
            expect(query).toEqual({ active: true, windowId: 7 });
            return [{ id: 4 }];
          },
          get: async (id: number) => {
            expect(id).toBe(4);
            return tab;
          },
        },
      },
    });
    expect((await currentWebsiteTab("regular")).id).toBe(4);
    for (const patch of [
      { active: false },
      { windowId: 8 },
      { incognito: true },
      { id: 5 },
      { url: "chrome-extension://test/options.html" },
      { url: "about:blank" },
    ]) {
      tab = {
        id: 4,
        windowId: 7,
        active: true,
        incognito: false,
        url: "https://example.com",
        ...patch,
      };
      await expect(currentWebsiteTab("regular")).rejects.toThrow();
    }
    tab = {
      id: 4,
      windowId: 7,
      active: true,
      incognito: true,
      url: "https://example.com",
    };
    window = { id: 7, incognito: true };
    expect((await currentWebsiteTab("incognito")).id).toBe(4);
    await expect(currentWebsiteTab("regular")).rejects.toThrow("context");
    allowed = false;
    await expect(currentWebsiteTab("incognito")).rejects.toThrow("Tab access");
  } finally {
    if (previous) Object.defineProperty(globalThis, "chrome", previous);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});
