import { beforeEach, describe, expect, test } from "bun:test";
import type { Command } from "../../src/shared/messages";
import type { Snapshot } from "../../src/shared/state";

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
let optedIn: boolean;
let privateWindow: boolean;
let proxyPermission: boolean;
let privacyPermission: boolean;
let failStorage: boolean;
let writes: number;
let rtc: unknown;
let rtcOwner: string;
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
  owner = "controllable_by_this_extension";
  optedIn = true;
  privateWindow = true;
  proxyPermission = true;
  privacyPermission = true;
  failStorage = false;
  writes = 0;
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
          ) =>
            done({
              value: incognito ? (privateProxy ?? regular) : regular,
              levelOfControl: owner,
              incognitoSpecific: incognito && privateProxy !== undefined,
            }),
          set: (
            { value, scope }: { value: unknown; scope: string },
            done: () => void,
          ) => {
            if (scope === "regular") regular = value;
            else privateProxy = value;
            owner = "controlled_by_this_extension";
            done();
          },
          clear: ({ scope }: { scope: string }, done: () => void) => {
            if (scope === "regular") regular = { mode: "system" };
            else privateProxy = undefined;
            owner = "controllable_by_this_extension";
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
    expect(state.incognitoProxy.applied).toBe(true);
    expect(state.incognitoProxy.settingScope).toBe("regular");
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
