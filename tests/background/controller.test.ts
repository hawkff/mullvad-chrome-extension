import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { Command } from "../../src/shared/messages";
import type { Snapshot } from "../../src/shared/state";
import wireServers from "../core/fixtures/servers.json";

// Inject routing doubles without replacing the module used by routing tests.
const routingCore = {
  canonicalHost: (input: string) => ({ ok: true, value: input.toLowerCase() }),
  generatePac: (input: unknown) => JSON.stringify(input),
  validateCommand: (input: unknown) => {
    const value = input as Command;
    if (
      !value ||
      ![
        "snapshot",
        "settings.update",
        "server.select",
        "history.clear",
        "settings.import",
        "settings.import.preview",
        "settings.export",
        "servers.refresh",
        "diagnostics.run",
        "privacy.set",
        "privacy.restore",
      ].includes(value.type) ||
      (value.context && !["regular", "incognito"].includes(value.context))
    )
      return { ok: false, error: "Invalid command" };
    return { ok: true, value };
  },
  validateImport: (input: {
    settings?: Snapshot["settings"];
    history?: [];
    version?: number;
  }) =>
    input?.version === 1 && input.settings && input.history
      ? {
          ok: true,
          value: {
            format: "native",
            routing: input.settings.routing,
            preferences: input.settings.preferences,
            history: input.history,
          },
        }
      : { ok: false, error: "Invalid import" },
  validateServers: () => ({ ok: false, error: "Invalid catalog" }),
} as unknown as typeof import("../../src/core/index");
const { Controller, trustedSender } = await import(
  "../../src/background/controller"
);
let local: Record<string, unknown>;
let session: Record<string, unknown>;
let regular: unknown;
let privateProxy: unknown;
let owner: string;
let privateOwner: string | undefined;
let optedIn: boolean;
let privateWindow: boolean;
let proxyPermission: boolean;
let privacyPermission: boolean;
let failStorage: boolean;
let writes: number;
let rtc: unknown;
let rtcOwner: string;
let onProxySet: (() => void) | undefined;
let privateQueries: number;
function area(data: () => Record<string, unknown>, persistent: boolean) {
  return {
    get: (key: string, done: (value: unknown) => void) =>
      done({ [key]: structuredClone(data()[key]) }),
    set: (value: Record<string, unknown>, done: () => void) => {
      if (persistent && failStorage) {
        Object.assign(chrome.runtime, {
          lastError: { message: "storage failed" },
        });
        done();
        Object.assign(chrome.runtime, { lastError: undefined });
        return;
      }
      Object.assign(data(), structuredClone(value));
      if (persistent) writes++;
      done();
    },
  };
}
beforeEach(() => {
  local = {};
  session = {};
  regular = { mode: "system" };
  privateProxy = undefined;
  privateOwner = undefined;
  owner = "controllable_by_this_extension";
  optedIn = true;
  privateWindow = true;
  proxyPermission = true;
  privacyPermission = true;
  failStorage = false;
  writes = 0;
  onProxySet = undefined;
  privateQueries = 0;
  rtc = "default";
  rtcOwner = "controllable_by_this_extension";
  Object.assign(globalThis, {
    chrome: {
      runtime: {
        id: "test",
        getURL: (path: string) =>
          `chrome-extension://test${path.startsWith("/") ? path : `/${path}`}`,
        lastError: undefined,
      },
      storage: {
        local: area(() => local, true),
        session: area(() => session, false),
      },
      extension: {
        isAllowedIncognitoAccess: (done: (value: boolean) => void) =>
          done(optedIn),
      },
      windows: {
        getAll: (_: unknown, done: (value: unknown[]) => void) =>
          done(privateWindow ? [{ id: 7, incognito: true }] : []),
        getLastFocused: (_: unknown, done: (value: unknown) => void) =>
          done({ incognito: false }),
      },
      permissions: {
        contains: (
          { permissions }: { permissions: string[] },
          done: (value: boolean) => void,
        ) =>
          done(
            permissions[0] === "proxy" ? proxyPermission : privacyPermission,
          ),
      },
      proxy: {
        settings: {
          get: (
            { incognito }: { incognito: boolean },
            done: (value: unknown) => void,
          ) => {
            if (incognito) privateQueries++;
            done({
              value: incognito ? (privateProxy ?? regular) : regular,
              levelOfControl:
                incognito && privateProxy !== undefined
                  ? (privateOwner ?? owner)
                  : owner,
              incognitoSpecific: incognito && privateProxy !== undefined,
            });
          },
          set: (
            { value, scope }: { value: unknown; scope: string },
            done: () => void,
          ) => {
            if (scope === "regular") {
              regular = value;
              owner = "controlled_by_this_extension";
            } else {
              privateProxy = value;
              privateOwner = "controlled_by_this_extension";
            }
            const hook = onProxySet;
            onProxySet = undefined;
            hook?.();
            done();
          },
          clear: ({ scope }: { scope: string }, done: () => void) => {
            if (scope === "regular") {
              regular = { mode: "system" };
              owner = "controllable_by_this_extension";
            } else {
              privateProxy = undefined;
              privateOwner = undefined;
            }
            done();
          },
        },
      },
      privacy: {
        network: {
          webRTCIPHandlingPolicy: {
            get: (_: unknown, done: (value: unknown) => void) =>
              done({ value: rtc, levelOfControl: rtcOwner }),
            set: ({ value }: { value: unknown }, done: () => void) => {
              rtc = value;
              rtcOwner = "controlled_by_this_extension";
              done();
            },
            clear: (_: unknown, done: () => void) => {
              rtc = "default";
              rtcOwner = "controllable_by_this_extension";
              done();
            },
          },
          networkPredictionEnabled: {
            get: (_: unknown, done: (value: unknown) => void) =>
              done({
                value: true,
                levelOfControl: "controllable_by_this_extension",
              }),
          },
        },
      },
      action: {
        setBadgeText: (_: unknown, done: () => void) => done(),
        setBadgeBackgroundColor: (_: unknown, done: () => void) => done(),
      },
    },
  });
});
async function snapshot(
  controller: InstanceType<typeof Controller>,
  context: "regular" | "incognito" = "regular",
): Promise<Snapshot> {
  const result = await controller.client({ type: "snapshot", context });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
describe("validated serialized controller", () => {
  test("defaults do not claim an active proxy", async () => {
    const result = await snapshot(new Controller(routingCore));
    expect(result.proxy.applied).toBe(false);
    expect(result.revision).toBe(0);
    expect(writes).toBe(0);
  });
  test("serialized writes and restart retain revision and session seed", async () => {
    const controller = new Controller(routingCore);
    await Promise.all([
      controller.client({
        type: "settings.update",
        patch: { autoReload: true },
      }),
      controller.client({
        type: "settings.update",
        patch: { historyEnabled: false },
      }),
    ]);
    const seed = structuredClone(session);
    const result = await snapshot(new Controller(routingCore));
    expect(result.revision).toBe(2);
    expect(result.settings.preferences).toEqual({
      autoReload: true,
      historyEnabled: false,
    });
    expect(session).toEqual(seed);
  });
  test("mandatory PAC is confirmed and regular scope inherits", async () => {
    const controller = new Controller(routingCore);
    const result = await controller.client({
      type: "server.select",
      serverId: "internal-default",
    });
    expect(result.ok).toBe(true);
    const state = await snapshot(controller);
    expect(state.proxy.applied).toBe(true);
    expect(state.proxy.settingScope).toBe("regular");
    expect(state.incognitoProxy.status).toBe("unknown");
    const privateState = await snapshot(controller, "incognito");
    expect(privateState.incognitoProxy.applied).toBe(true);
    expect(privateState.incognitoProxy.settingScope).toBe("regular");
  });
  test("other owners and revoked permission cannot overwrite routes", async () => {
    owner = "controlled_by_other_extensions";
    const controller = new Controller(routingCore);
    expect(
      (
        await controller.client({
          type: "settings.update",
          patch: { enabled: true },
        })
      ).ok,
    ).toBe(false);
    expect(writes).toBe(0);
    expect((await snapshot(controller)).proxy.status).toBe("blocked");
    proxyPermission = false;
    expect((await snapshot(controller)).proxy.permissionGranted).toBe(false);
  });
  test("bad storage and failed import never partially overwrite", async () => {
    local["state.v1"] = { version: 900 };
    expect(
      (await new Controller(routingCore).client({ type: "snapshot" })).ok,
    ).toBe(false);
    expect(writes).toBe(0);
    local = {};
    const controller = new Controller(routingCore);
    expect(
      (await controller.client({ type: "settings.import", data: {} })).ok,
    ).toBe(false);
    expect(writes).toBe(0);
  });
  test("storage error rolls PAC back and leaves persisted state intact", async () => {
    const controller = new Controller(routingCore);
    await snapshot(controller);
    failStorage = true;
    expect(
      (
        await controller.client({
          type: "server.select",
          serverId: "internal-default",
        })
      ).ok,
    ).toBe(false);
    expect(local["state.v1"]).toBeUndefined();
    expect(regular).toEqual({ mode: "system" });
  });
  test("private changes stay session-only, diagnostics blocked, and expire", async () => {
    const controller = new Controller(routingCore);
    expect(
      (
        await controller.client({
          type: "server.select",
          serverId: "internal-default",
          context: "incognito",
        })
      ).ok,
    ).toBe(true);
    expect(writes).toBe(0);
    expect((await snapshot(controller, "incognito")).history).toEqual([]);
    expect(
      (await snapshot(controller, "incognito")).incognitoProxy.settingScope,
    ).toBe("incognito_session_only");
    expect(
      (
        await controller.client({
          type: "diagnostics.run",
          checks: ["ipv4"],
          context: "incognito",
        })
      ).ok,
    ).toBe(false);
    privateWindow = false;
    privateProxy = undefined;
    controller.privateWindowChanged();
    await snapshot(controller);
    expect(JSON.stringify(session)).not.toContain("privateState");
  });
  test("privacy restore clears only our override", async () => {
    const controller = new Controller(routingCore);
    expect(
      (
        await controller.client({
          type: "privacy.set",
          control: "webRtcNonProxiedUdp",
          enabled: true,
        })
      ).ok,
    ).toBe(true);
    expect(rtc).toBe("disable_non_proxied_udp");
    await controller.client({
      type: "privacy.restore",
      control: "webRtcNonProxiedUdp",
    });
    expect(rtc).toBe("default");
    rtc = "external";
    rtcOwner = "controlled_by_other_extensions";
    await controller.client({
      type: "privacy.restore",
      control: "webRtcNonProxiedUdp",
    });
    expect(rtc).toBe("external");
  });
  test("rejects malformed, external, content script, and wrong-context messages", async () => {
    const controller = new Controller(routingCore);
    expect((await controller.execute({ type: "eval" })).ok).toBe(false);
    for (const sender of [
      { id: "other", url: "chrome-extension://other/popup.html" },
      { id: "test", url: "https://example.org/popup.html" },
      {
        id: "test",
        url: "chrome-extension://test/options.html",
        tab: { url: "https://example.org", incognito: false },
      },
    ])
      expect(
        trustedSender(
          sender as unknown as chrome.runtime.MessageSender,
          "regular",
        ),
      ).toBe(false);
    expect(
      (
        await controller.execute(
          { type: "snapshot", context: "incognito" },
          { id: "test", url: "chrome-extension://test/popup.html" },
        )
      ).ok,
    ).toBe(false);
  });
});

test("private last-window close then immediate reopen cannot resurrect old state", async () => {
  const controller = new Controller(routingCore);
  await controller.client({
    type: "server.select",
    serverId: "internal-default",
    context: "incognito",
  });
  controller.privateWindowChanged(7);
  controller.privateWindowCreated({
    id: 8,
    incognito: true,
  } as chrome.windows.Window);
  await snapshot(controller);
  expect(JSON.stringify(session)).not.toContain("privateState");
  expect(JSON.stringify(session)).not.toContain("privateSeed");
  expect(privateProxy).toBeUndefined();
});
test("worker restart restores only the same live private session", async () => {
  const controller = new Controller(routingCore);
  await controller.client({
    type: "server.select",
    serverId: "internal-default",
    context: "incognito",
  });
  expect(
    (await snapshot(new Controller(routingCore), "incognito")).incognitoProxy
      .applied,
  ).toBe(true);
  optedIn = false;
  await snapshot(new Controller(routingCore));
  expect(JSON.stringify(session)).not.toContain("privateState");
});
test("private disable installs a confirmed session-only DIRECT override, not regular inheritance", async () => {
  const controller = new Controller(routingCore);
  await controller.client({
    type: "server.select",
    serverId: "internal-default",
  });
  expect(
    (
      await controller.client({
        type: "settings.update",
        patch: { enabled: false },
        context: "incognito",
      })
    ).ok,
  ).toBe(true);
  const result = await snapshot(controller, "incognito");
  expect(result.proxy.applied).toBe(true);
  expect(result.incognitoProxy.applied).toBe(false);
  expect(result.incognitoProxy.settingScope).toBe("incognito_session_only");
  expect(privateProxy).toEqual({ mode: "direct" });
});
test("privacy denial does not claim an override", async () => {
  privacyPermission = false;
  const controller = new Controller(routingCore);
  const result = await controller.client({
    type: "privacy.set",
    control: "webRtcNonProxiedUdp",
    enabled: true,
  });
  expect(result.ok).toBe(false);
  expect(rtc).toBe("default");
  expect((await snapshot(controller)).privacy.permissionGranted).toBe(false);
});

test("contextless proxy errors cannot expose private activity or alter mandatory routing", async () => {
  const listeners: ((details: {
    fatal: boolean;
    error: string;
    details: string;
  }) => void)[] = [];
  const event = () => ({ addListener: () => undefined });
  Object.assign(chrome.runtime, {
    onMessage: event(),
    onInstalled: event(),
    onStartup: event(),
  });
  Object.assign(chrome.permissions, { onRemoved: event() });
  Object.assign(chrome.windows, { onRemoved: event(), onCreated: event() });
  Object.assign(chrome.proxy.settings, { onChange: event() });
  Object.assign(chrome.proxy, {
    onProxyError: {
      addListener: (listener: (typeof listeners)[number]) =>
        listeners.push(listener),
    },
  });
  Object.assign(globalThis, { __DEV__: false });
  await import("../../src/background/index");
  const controller = new Controller(routingCore);
  await controller.client({
    type: "server.select",
    serverId: "internal-default",
    context: "incognito",
  });
  const before = await snapshot(controller);
  const beforePrivate = structuredClone(privateProxy);
  const beforeStorage = structuredClone({ local, session });
  // Chrome does not attribute this event to a browser context. There must be no
  // global error listener that exposes it to regular UI or clears mandatory PAC.
  for (const listener of listeners)
    listener({
      fatal: true,
      error: "ERR_PAC_SCRIPT_FAILED",
      details: "private.example",
    });
  const after = await snapshot(controller);
  expect(listeners).toHaveLength(0);
  expect(after).toEqual(before);
  expect(privateProxy).toEqual(beforePrivate);
  expect({ local, session }).toEqual(beforeStorage);
  expect(
    (privateProxy as { pacScript: { mandatory: boolean } }).pacScript.mandatory,
  ).toBe(true);
});

test("regular snapshots never inspect or reveal private override changes", async () => {
  const controller = new Controller(routingCore);
  await controller.client({
    type: "server.select",
    serverId: "internal-default",
  });
  let queries = privateQueries;
  const before = await snapshot(controller);
  expect(privateQueries).toBe(queries);
  await controller.client({
    type: "settings.update",
    patch: { enabled: false },
    context: "incognito",
  });
  queries = privateQueries;
  const after = await snapshot(controller);
  expect(privateQueries).toBe(queries);
  expect(after).toEqual(before);
  expect(after.incognitoProxy.status).toBe("unknown");
  privateProxy = {
    mode: "pac_script",
    pacScript: { data: "broken", mandatory: true },
  };
  const afterPrivateError = await snapshot(controller);
  expect(afterPrivateError).toEqual(before);
  expect(privateQueries).toBe(queries);
  await snapshot(new Controller(routingCore));
  expect(privateQueries).toBe(queries);
});

for (const closedWindow of [7, 99]) {
  test(`closing ${closedWindow === 7 ? "one of two private windows" : "an unrelated regular window"} during a private mutation preserves the session`, async () => {
    const controller = new Controller(routingCore);
    await snapshot(controller);
    controller.privateWindowCreated({
      id: 8,
      incognito: true,
    } as chrome.windows.Window);
    await snapshot(controller);
    onProxySet = () => controller.privateWindowChanged(closedWindow);
    const result = await controller.client({
      type: "server.select",
      serverId: "internal-default",
      context: "incognito",
    });
    expect(result.ok).toBe(true);
    const privateState = await snapshot(controller, "incognito");
    expect(privateState.revision).toBe(1);
    expect(privateState.incognitoProxy.applied).toBe(true);
    expect(privateState.settings.routing.globalServerId).toBe(
      "internal-default",
    );
    expect(JSON.stringify(session)).toContain("privateState");
  });
}

test("last private-window closure still invalidates a mutation after PAC application", async () => {
  const controller = new Controller(routingCore);
  await snapshot(controller);
  onProxySet = () => {
    privateWindow = false;
    privateProxy = undefined;
    controller.privateWindowChanged(7);
  };
  const result = await controller.client({
    type: "server.select",
    serverId: "internal-default",
    context: "incognito",
  });
  expect(result.ok).toBe(false);
  await snapshot(controller);
  expect(JSON.stringify(session)).not.toContain("privateState");
  expect(JSON.stringify(session)).not.toContain("privateSeed");
  expect(privateProxy).toBeUndefined();
});

// These persistence regressions deliberately use the real routing validators and PAC.
describe("real-core persisted routing", () => {
  function installedPac() {
    const value = regular as {
      pacScript: { mandatory: boolean; data: string };
    };
    expect(value.pacScript.mandatory).toBe(true);
    return runInNewContext(`${value.pacScript.data};FindProxyForURL`) as (
      url: string,
      host: string,
    ) => string;
  }
  const wire = wireServers[0];
  const extra = {
    ...wire,
    hostname: "se-got-wg-socks5-002.relays.mullvad.net",
    ipv4_address: "185.213.154.70",
  };
  async function refresh(
    controller: InstanceType<typeof Controller>,
    rows: unknown[],
  ) {
    const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(rows)),
    );
    try {
      expect((await controller.client({ type: "servers.refresh" })).ok).toBe(
        true,
      );
    } finally {
      fetcher.mockRestore();
    }
  }
  for (const availability of ["offline", "absent"]) {
    test(`existing ${availability} rule can be disabled without admitting unresolved targets`, async () => {
      const controller = new Controller();
      await refresh(controller, [wire, extra]);
      await controller.client({
        type: "settings.update",
        patch: { enabled: true },
      });
      for (const rule of [
        { host: "example.com", enabled: true, serverId: "internal-default" },
        { host: "unrelated.example", enabled: true, serverId: extra.hostname },
        { host: "child.example.com", enabled: true, serverId: wire.hostname },
      ]) {
        expect(
          (await controller.client({ type: "rule.upsert", rule })).ok,
        ).toBe(true);
      }
      await refresh(
        controller,
        availability === "offline"
          ? [{ ...wire, online: false }, extra]
          : [extra],
      );
      const restarted = new Controller();
      const before = await snapshot(restarted);
      expect(() =>
        installedPac()("https://child.example.com", "child.example.com"),
      ).toThrow(/Missing/);
      const saved = structuredClone(local["state.v1"]) as {
        revision: number;
        settings: Snapshot["settings"];
        history: Snapshot["history"];
      };
      const cache = structuredClone(local["servers.v1"]);
      const sessionBefore = structuredClone(session);
      const writesBefore = writes;
      expect(
        (
          await restarted.client({
            type: "rule.upsert",
            rule: {
              host: "CHILD.Example.COM.",
              enabled: false,
              serverId: wire.hostname,
            },
          })
        ).ok,
      ).toBe(true);
      const after = await snapshot(restarted);
      const expected = structuredClone(saved);
      expected.revision++;
      expected.settings.routing.rules[2].enabled = false;
      expect(local["state.v1"]).toEqual(expected);
      expect(local["servers.v1"]).toEqual(cache);
      expect(session).toEqual(sessionBefore);
      expect(writes).toBe(writesBefore + 1);
      expect(after.history).toEqual(before.history);
      // Disabling falls through to the enabled parent route, not a DIRECT override.
      expect(
        installedPac()("https://child.example.com", "child.example.com"),
      ).toBe("SOCKS5 10.64.0.1:1080");
      for (const rule of [
        { host: "child.example.com", enabled: true, serverId: wire.hostname },
        { host: "new.example", enabled: false, serverId: wire.hostname },
        { host: "new.example", enabled: false, serverId: "unknown" },
        { host: "child.example.com", enabled: false, serverId: "unknown" },
      ]) {
        const unchanged = structuredClone({ local, session, regular, writes });
        expect((await restarted.client({ type: "rule.upsert", rule })).ok).toBe(
          false,
        );
        expect({ local, session, regular, writes }).toEqual(unchanged);
      }
    });
  }
  test("fresh enable chooses internal default and survives worker and browser restart", async () => {
    const controller = new Controller();
    expect(
      (
        await controller.client({
          type: "settings.update",
          patch: { enabled: true },
        })
      ).ok,
    ).toBe(true);
    for (const restartBrowser of [false, true]) {
      if (restartBrowser) session = {};
      const restored = await snapshot(new Controller());
      expect(restored.settings.routing.globalServerId).toBe("internal-default");
      expect(installedPac()("https://example.org", "example.org")).toBe(
        "SOCKS5 10.64.0.1:1080",
      );
    }
  });
  test("retired route and history survive refresh and restart without blanket blocking", async () => {
    const controller = new Controller();
    await refresh(controller, [wire, extra]);
    expect(
      (
        await controller.client({
          type: "server.select",
          serverId: wire.hostname,
          host: "missing.example",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await controller.client({
          type: "server.select",
          serverId: extra.hostname,
          host: "valid.example",
        })
      ).ok,
    ).toBe(true);
    await refresh(controller, [extra]);
    session = {};
    const restarted = new Controller();
    const restored = await snapshot(restarted);
    expect(restored.settings.routing.rules).toHaveLength(2);
    expect(restored.history.map((row) => row.serverId)).toContain(
      wire.hostname,
    );
    const pac = installedPac();
    expect(() => pac("https://missing.example", "missing.example")).toThrow(
      /Missing/,
    );
    expect(pac("https://valid.example", "valid.example")).toBe(
      "SOCKS5 185.213.154.70:1080",
    );
    expect(pac("https://other.example", "other.example")).toBe("DIRECT");
    expect(pac("http://localhost", "localhost")).toBe("DIRECT");
    expect((await restarted.client({ type: "history.clear" })).ok).toBe(true);
    expect(
      (
        await restarted.client({
          type: "server.select",
          serverId: extra.hostname,
        })
      ).ok,
    ).toBe(true);
  });
  test("history-only retired IDs and missing cache do not prevent recovery", async () => {
    const controller = new Controller();
    await refresh(controller, [wire]);
    await controller.client({ type: "server.select", serverId: wire.hostname });
    await controller.client({
      type: "server.select",
      serverId: "internal-default",
    });
    await refresh(controller, []);
    expect((await snapshot(new Controller())).history[0].serverId).toBe(
      wire.hostname,
    );
    delete local["servers.v1"];
    session = {};
    const restarted = new Controller();
    expect((await snapshot(restarted)).history[0].serverId).toBe(wire.hostname);
    expect(installedPac()("https://example.org", "example.org")).toBe(
      "SOCKS5 10.64.0.1:1080",
    );
    expect((await restarted.client({ type: "history.clear" })).ok).toBe(true);
  });
  test("active route without cache remains unresolved and can be reselected", async () => {
    const controller = new Controller();
    await refresh(controller, [wire]);
    await controller.client({ type: "server.select", serverId: wire.hostname });
    delete local["servers.v1"];
    session = {};
    const restarted = new Controller();
    expect((await snapshot(restarted)).settings.routing.globalServerId).toBe(
      wire.hostname,
    );
    expect(() => installedPac()("https://example.org", "example.org")).toThrow(
      /Missing/,
    );
    expect(
      (
        await restarted.client({
          type: "server.select",
          serverId: "internal-default",
        })
      ).ok,
    ).toBe(true);
  });
  test("catalog growth and new selections do not change frozen random assignments", async () => {
    const controller = new Controller();
    await refresh(controller, [wire]);
    await controller.client({
      type: "settings.update",
      patch: { randomMode: true },
    });
    const before = installedPac()("https://example.org", "example.org");
    await refresh(controller, [wire, extra]);
    expect(
      (
        await controller.client({
          type: "server.select",
          serverId: extra.hostname,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await controller.client({
          type: "server.select",
          serverId: extra.hostname,
          host: "site.example",
        })
      ).ok,
    ).toBe(true);
    await snapshot(new Controller());
    expect(installedPac()("https://example.org", "example.org")).toBe(before);
    expect(installedPac()("https://site.example", "site.example")).toBe(before);
    expect(before).toBe("SOCKS5 185.213.154.69:1080");
  });
  test("invalid imports cannot mutate proxy or storage", async () => {
    const controller = new Controller();
    const state = await snapshot(controller);
    for (const routing of [
      { ...state.settings.routing, enabled: true },
      { ...state.settings.routing, enabled: true, globalServerId: "unknown" },
      {
        ...state.settings.routing,
        rules: [
          { host: "bad/url", enabled: true, serverId: "internal-default" },
        ],
      },
    ]) {
      const before = structuredClone({ local, session, regular, writes });
      expect(
        (
          await controller.client({
            type: "settings.import",
            data: {
              version: 1,
              settings: { ...state.settings, routing },
              history: [],
            },
          })
        ).ok,
      ).toBe(false);
      expect({ local, session, regular, writes }).toEqual(before);
    }
  });
});
