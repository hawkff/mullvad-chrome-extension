import { describe, expect, test } from "bun:test";
import { proxyStatus } from "../../src/shared/status";
import {
  checkStatus,
  checksCoverSite,
  currentWebsiteTab,
  exitStatus,
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
  const relay = {
    ...fixture.servers.value[0],
    hostname: "se-got-wg-socks5-001.relays.mullvad.net",
  };
  expect(searchServers([relay], "se-got-001")).toEqual([relay]);
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
    "Stale",
  );
  expect(freshness({ status: "ready", updatedAt: 0, value: [] })).toContain(
    "unknown time",
  );
  expect(
    freshness({ status: "ready", updatedAt: Date.now(), value: [] }),
  ).toMatch(/^Updated /);
});

test("status summary names route exceptions and any non-Mullvad address", () => {
  const snapshot = structuredClone(fixture);
  const servers =
    snapshot.servers.status === "ready" ? snapshot.servers.value : [];
  snapshot.proxy = { ...snapshot.proxy, applied: true, status: "ready" };
  snapshot.settings.routing = {
    ...snapshot.settings.routing,
    enabled: true,
    globalServerId: "se-got-001",
    rules: [{ host: "example.com", enabled: true, serverId: "de-ber-001" }],
    exclusions: ["intranet.example"],
  };
  const { routing } = snapshot.settings;
  expect(proxyStatus(snapshot.proxy, routing, servers)).toEqual({
    tone: "on",
    title: "Proxy on",
    detail:
      "All websites via Gothenburg, Sweden, except 1 website rule and 1 exclusion.",
  });
  routing.globalServerId = "retired";
  expect(proxyStatus(snapshot.proxy, routing, servers).detail).toContain(
    "via an unavailable server",
  );
  routing.enabled = false;
  snapshot.proxy.applied = false;
  expect(proxyStatus(snapshot.proxy, routing, servers).tone).toBe("warn");
  routing.rules = [];
  expect(proxyStatus(snapshot.proxy, routing, servers).title).toBe("Proxy off");
  const checks = structuredClone(snapshot.diagnostics);
  checks.ipv4 = {
    status: "ready",
    updatedAt: 1,
    value: { ip: "198.51.100.1", isMullvad: true },
  };
  expect(exitStatus(checks)).toEqual(["on", "Mullvad", "198.51.100.1"]);
  checks.ipv6 = {
    status: "ready",
    updatedAt: 1,
    value: { ip: "2001:db8::1", isMullvad: false },
  };
  expect(exitStatus(checks)).toEqual(["error", "Not Mullvad", "2001:db8::1"]);
  checks.ipv4 = { status: "error", message: "Timed out" };
  checks.ipv6 = {
    status: "ready",
    updatedAt: 1,
    value: {
      ip: "2001:db8::1",
      isMullvad: true,
      city: "Gothenburg",
      country: "Sweden",
    },
  };
  expect(exitStatus(checks)).toEqual([
    "on",
    "Mullvad · Gothenburg, Sweden",
    "2001:db8::1",
  ]);
  expect(
    checkStatus({
      status: "ready",
      updatedAt: 1,
      value: [
        { ip: "198.51.100.53", isMullvad: true, hostname: "se-got-dns-001" },
      ],
    }),
  ).toEqual(["on", "Mullvad · 1 resolver", "se-got-dns-001"]);
  expect(
    checkStatus({
      status: "ready",
      updatedAt: 1,
      value: [
        { ip: "198.51.100.53", isMullvad: true, hostname: "se-got-dns-001" },
        {
          ip: "203.0.113.9",
          isMullvad: false,
          hostname: "",
          organization: "Example ISP",
        },
      ],
    }),
  ).toEqual([
    "error",
    "Not Mullvad · 1 of 2 resolvers",
    "203.0.113.9 (Example ISP)",
  ]);
});

test("connection checks describe only websites on their route", () => {
  const servers =
    fixture.servers.status === "ready" ? fixture.servers.value : [];
  const routing = {
    enabled: true,
    globalServerId: "se-got-001",
    randomMode: false,
    rules: [{ host: "example.com", enabled: true, serverId: "de-ber-001" }],
    exclusions: ["intranet.example"],
  };
  expect(checksCoverSite("news.example.org", routing, servers)).toBe(true);
  expect(checksCoverSite("www.example.com", routing, servers)).toBe(false);
  expect(checksCoverSite("intranet.example", routing, servers)).toBe(false);
  expect(
    checksCoverSite(
      "news.example.org",
      { ...routing, randomMode: true },
      servers,
    ),
  ).toBe(false);
  // With the global route off, the checks and unruled websites both connect directly.
  expect(
    checksCoverSite(
      "news.example.org",
      { ...routing, enabled: false },
      servers,
    ),
  ).toBe(true);
  // A rule for one check host splits that check from the global route.
  expect(
    checksCoverSite(
      "news.example.org",
      {
        ...routing,
        exclusions: [...routing.exclusions, "ipv6.am.i.mullvad.net"],
      },
      servers,
    ),
  ).toBe(false);
});

test("Incognito scope labels distinguish inheritance, overrides and unknown state", () => {
  const proxy = { ...fixture.incognitoProxy, applied: true };
  expect(
    incognitoScopeDescription({ ...proxy, settingScope: "regular" }),
  ).toContain("Incognito uses your regular routing");
  expect(
    incognitoScopeDescription({
      ...proxy,
      settingScope: "incognito_session_only",
    }),
  ).toContain("its own routing until you close the last Incognito window");
  expect(incognitoScopeDescription(proxy)).toContain("hasn't confirmed which");
  expect(
    incognitoScopeDescription({
      ...proxy,
      applied: false,
      settingScope: "regular",
    }),
  ).not.toContain("regular routing");
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
  let window = { id: 7, incognito: false };
  let tab: {
    id: number;
    windowId: number;
    active: boolean;
    incognito: boolean;
    url?: string;
  } = {
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
    await expect(currentWebsiteTab("regular")).rejects.toThrow(
      "no current website",
    );
    // Without an activeTab grant Chrome omits the URL.
    tab = { ...tab, url: undefined };
    await expect(currentWebsiteTab("incognito")).rejects.toThrow(
      "HTTP or HTTPS",
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "chrome", previous);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});
