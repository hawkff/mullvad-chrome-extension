import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  canonicalHost,
  generatePac,
  resolveRoute,
  validateCommand,
  validateImport,
  validateServers,
} from "../../src/core";
import type { RoutingContext } from "../../src/shared/state";
import firefox from "./fixtures/firefox.json";
import wireServers from "./fixtures/servers.json";

const catalog = validateServers(wireServers);
if (!catalog.ok) throw new Error(catalog.error);
const servers = catalog.value;
const id = servers[0].id;
function context(): RoutingContext {
  return {
    settings: {
      enabled: true,
      globalServerId: id,
      randomMode: false,
      rules: [],
      exclusions: [],
    },
    servers: structuredClone(servers),
    sessionSeed: "session-a",
  };
}
function pac(ctx: RoutingContext) {
  return runInNewContext(
    `${generatePac(ctx)};FindProxyForURL`,
    Object.create(null),
  ) as (url: string, host: string) => string;
}
function check(ctx: RoutingContext, hosts: string[]) {
  const emitted = pac(ctx);
  for (const host of hosts) {
    const route = resolveRoute(host, ctx);
    if (route.kind === "blocked") {
      expect(() => emitted(`https://${host}/`, host)).toThrow();
      continue;
    }
    const canonical = canonicalHost(host);
    const expected =
      route.kind === "proxy"
        ? `SOCKS5 ${route.endpoint.host}:${route.endpoint.port}`
        : "DIRECT";
    expect(
      emitted(`https://${host}/`, canonical.ok ? canonical.value : host),
    ).toBe(expected);
  }
}
describe("canonical hosts and local literal bypass", () => {
  test("canonicalization rejects URL syntax/injection and ambiguous numeric addresses", () => {
    expect(canonicalHost("BÜCHER.de.")).toEqual({
      ok: true,
      value: "xn--bcher-kva.de",
    });
    expect(canonicalHost("WWW.Example.COM.")).toEqual({
      ok: true,
      value: "www.example.com",
    });
    expect(canonicalHost("[::1]")).toEqual({
      ok: true,
      value: "0:0:0:0:0:0:0:1",
    });
    for (const host of [
      "https://example.com",
      "x:80",
      "x/path",
      "x\n",
      "*.com",
      "127.1",
      "999.1.1.1",
      'x";throw 1;//',
      "",
      "a..com",
      "[::1%eth0]",
    ])
      expect(canonicalHost(host).ok).toBe(false);
  });
  test("IPv4, IPv6 and mapped literals; no DNS resolution", () => {
    const ctx = context();
    const local = [
      "localhost",
      "a.localhost",
      "10.0.0.1",
      "127.0.0.2",
      "172.16.0.1",
      "192.168.1.2",
      "169.254.1.1",
      "224.0.0.1",
      "[::1]",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "::ffff:192.168.1.1",
    ];
    for (const host of local)
      expect(resolveRoute(host, ctx)).toEqual({
        kind: "direct",
        reason: "local",
      });
    check(ctx, [...local, "8.8.8.8", "2606:4700:4700::1111", "example.com"]);
    expect(generatePac(ctx)).not.toMatch(/dnsResolve|isResolvable|isInNet\(/);
  });
});
describe("upstream route precedence and executable PAC", () => {
  test("exact, registrable parent (not arbitrary ancestor), exclusions, disabled fallthrough", () => {
    const ctx = context();
    ctx.settings.enabled = false;
    ctx.settings.rules = [
      { host: "example.co.uk", enabled: true, serverId: "internal-default" },
      { host: "www.example.co.uk", enabled: false, serverId: id },
      { host: "foo.example.com", enabled: true, serverId: id },
      { host: "github.io", enabled: true, serverId: id },
    ];
    expect(resolveRoute("www.example.co.uk", ctx)).toMatchObject({
      kind: "proxy",
      source: "parent",
      serverId: "internal-default",
    });
    expect(resolveRoute("bar.foo.example.com", ctx).kind).toBe("direct");
    // Upstream tldts defaults: ICANN suffixes, not private suffixes.
    expect(resolveRoute("project.github.io", ctx)).toMatchObject({
      kind: "proxy",
      source: "parent",
    });
    ctx.settings.exclusions = ["example.co.uk"];
    expect(resolveRoute("www.example.co.uk", ctx)).toEqual({
      kind: "direct",
      reason: "excluded",
    });
    check(ctx, [
      "www.example.co.uk",
      "example.co.uk",
      "a.foo.example.com",
      "foo.example.com",
      "project.github.io",
      "www.ck",
      "a.b.ck",
      "xn--bcher-kva.de",
    ]);
  });
  test("random overrides exclusions and global/site, stable by registrable domain and seed", () => {
    const ctx = context();
    ctx.settings.enabled = false;
    ctx.settings.randomMode = true;
    ctx.settings.exclusions = ["example.com"];
    ctx.servers.push({
      ...servers[0],
      id: "other.mullvad.net",
      hostname: "other.mullvad.net",
      ipv4: "1.2.3.4",
    });
    expect(resolveRoute("example.com", ctx)).toMatchObject({
      kind: "proxy",
      source: "random",
    });
    expect(resolveRoute("www.example.com", ctx)).toEqual(
      resolveRoute("example.com", ctx),
    );
    const before = resolveRoute("example.com", ctx);
    ctx.servers.reverse();
    expect(resolveRoute("example.com", ctx)).toEqual(before);
    check(ctx, [
      "example.com",
      "www.example.com",
      "a.co.uk",
      "b.co.uk",
      "localhost",
      "8.8.8.8",
      "[::1]",
    ]);
  });
  test("missing/offline/invalid data fail closed, never DIRECT failover", () => {
    for (const mutate of [
      (ctx: RoutingContext) => {
        ctx.settings.globalServerId = null;
      },
      (ctx: RoutingContext) => {
        ctx.servers = [];
      },
      (ctx: RoutingContext) => {
        ctx.servers[0].online = false;
      },
      (ctx: RoutingContext) => {
        ctx.servers[0].ipv4 = "1.2.3.4; DIRECT";
      },
      (ctx: RoutingContext) => {
        ctx.settings.randomMode = true;
        ctx.sessionSeed = "";
      },
    ]) {
      const ctx = context();
      mutate(ctx);
      expect(resolveRoute("example.com", ctx).kind).toBe("blocked");
      expect(() => pac(ctx)("https://example.com", "example.com")).toThrow();
    }
  });
  test("malicious host/config cannot escape PAC", () => {
    const ctx = context();
    ctx.sessionSeed = '</script>\u2028";throw new Error("injected")';
    check(ctx, ['x";throw 1;//', "example.com", "evil\n.com"]);
    ctx.settings.rules.push({
      host: 'x";throw 1;//',
      enabled: true,
      serverId: id,
    });
    check(ctx, ["example.com"]);
  });
});
describe("validated imports are pure/atomic", () => {
  test("real upstream export shape converts default and per-site endpoints without resetting random", () => {
    const result = validateImport(firefox, servers);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toMatchObject({
      format: "firefox",
      routing: {
        enabled: true,
        globalServerId: "internal-default",
        exclusions: ["excluded.example"],
        rules: [{ host: "www.example.co.uk", serverId: id }],
      },
    });
    expect(result.value.routing).not.toHaveProperty("randomMode");
    expect(result.value).not.toHaveProperty("preferences");
    expect(
      validateImport(
        { ...firefox, globalProxy: {}, globalProxyDetails: {} },
        servers,
      ).ok,
    ).toBe(true);
  });
  test("native round trip validates settings/history", () => {
    const value = {
      version: 1,
      settings: {
        routing: context().settings,
        preferences: { autoReload: false, historyEnabled: true },
      },
      history: [],
    };
    expect(validateImport(value, servers)).toMatchObject({
      ok: true,
      value: { format: "native", routing: value.settings.routing, history: [] },
    });
    expect(validateImport({ ...value, version: 2 }, servers).ok).toBe(false);
  });
  test("reject incompatible, incomplete, mismatched and unknown values without mutation", () => {
    const invalid = [
      { ...firefox, extra: true },
      { ...firefox, globalProxy: { ...firefox.globalProxy, proxyDNS: false } },
      {
        ...firefox,
        globalProxyDetails: { ...firefox.globalProxyDetails, proxyDNS: false },
      },
      { ...firefox, globalProxy: { ...firefox.globalProxy, type: "socks4" } },
      { ...firefox, globalProxy: { ...firefox.globalProxy, host: "10.1.1.1" } },
      { ...firefox, globalProxyDetails: { socksEnabled: "true" } },
      { ...firefox, hostProxiesDetails: {} },
      { ...firefox, excludedHosts: ["Example.com", "example.com."] },
      { ...firefox, excludedHosts: ["bücher.de", "xn--bcher-kva.de"] },
      {
        ...firefox,
        globalProxy: { ...firefox.globalProxy, username: "secret" },
      },
    ];
    for (const data of invalid) {
      const before = JSON.stringify(data);
      expect(validateImport(data, servers).ok).toBe(false);
      expect(JSON.stringify(data)).toBe(before);
    }
  });
});
test("server and command runtime trust boundaries", () => {
  expect(validateServers(wireServers).ok).toBe(true);
  for (const data of [
    null,
    {},
    [{ ...wireServers[0], port: 0 }],
    [{ ...wireServers[0], online: "yes" }],
    [wireServers[0], wireServers[0]],
  ])
    expect(validateServers(data).ok).toBe(false);
  expect(
    validateCommand({
      type: "rule.remove",
      host: "EXAMPLE.COM.",
      context: "incognito",
    }),
  ).toEqual({
    ok: true,
    value: { type: "rule.remove", host: "example.com", context: "incognito" },
  });
  for (const data of [
    null,
    {},
    { type: "snapshot", extra: 1 },
    { type: "snapshot", context: "private" },
    { type: "settings.update", patch: { enabled: 1 } },
    { type: "settings.update", patch: { routing: {} } },
    { type: "diagnostics.run", checks: ["active-tab"] },
    { type: "privacy.set", control: "disableWebRTC", enabled: true },
  ])
    expect(validateCommand(data).ok).toBe(false);
});

test("Unicode rules, exclusions and native exports canonicalize without collisions", () => {
  const data = {
    version: 1,
    settings: {
      routing: {
        ...context().settings,
        rules: [
          { host: "BÜCHER.de.", enabled: true, serverId: "internal-default" },
        ],
        exclusions: ["食品.中国"],
      },
      preferences: { autoReload: true, historyEnabled: false },
    },
    history: [],
  };
  const preview = validateImport(data, servers);
  expect(preview.ok).toBe(true);
  if (!preview.ok) throw new Error(preview.error);
  expect(preview.value.routing.rules[0].host).toBe("xn--bcher-kva.de");
  const ctx = context();
  ctx.settings = { ...ctx.settings, ...preview.value.routing };
  expect(resolveRoute("bücher.de", ctx)).toMatchObject({
    kind: "proxy",
    serverId: "internal-default",
  });
  check(ctx, ["bücher.de", "xn--bcher-kva.de", "食品.中国"]);
  expect(
    validateImport(
      {
        ...data,
        settings: {
          ...data.settings,
          routing: {
            ...data.settings.routing,
            rules: [
              ...data.settings.routing.rules,
              { host: "xn--bcher-kva.de", enabled: false, serverId: id },
            ],
          },
        },
      },
      servers,
    ).ok,
  ).toBe(false);
  expect(
    validateImport(
      {
        ...data,
        settings: { ...data.settings, routing: preview.value.routing },
      },
      servers,
    ),
  ).toMatchObject({ ok: true, value: { routing: preview.value.routing } });
});

test("Firefox endpoints and metadata are cross-checked, not guessed", () => {
  const valid = structuredClone(firefox);
  valid.hostProxies["www.example.co.uk"].host = id;
  expect(validateImport(valid, servers).ok).toBe(true);
  valid.hostProxiesDetails["www.example.co.uk"].server = "se-sto-999";
  expect(validateImport(valid, servers).ok).toBe(false);
  for (const port of [0, 65536, 1080.5]) {
    expect(
      validateImport(
        { ...firefox, globalProxy: { ...firefox.globalProxy, port } },
        servers,
      ).ok,
    ).toBe(false);
  }
  expect(validateImport({ ...firefox, hostProxies: {} }, servers).ok).toBe(
    false,
  );
  expect(
    validateImport(
      {
        ...firefox,
        globalProxy: { ...firefox.globalProxy, host: "10.64.0.2" },
      },
      servers,
    ).ok,
  ).toBe(false);
});

test("PSL wildcard and exception parent semantics match the PAC", () => {
  const ctx = context();
  ctx.settings.enabled = false;
  ctx.settings.rules = [
    { host: "www.ck", enabled: true, serverId: id },
    { host: "b.ck", enabled: true, serverId: id },
  ];
  expect(resolveRoute("a.www.ck", ctx)).toMatchObject({
    kind: "proxy",
    source: "parent",
  });
  expect(resolveRoute("a.b.ck", ctx).kind).toBe("direct");
  check(ctx, ["a.www.ck", "a.b.ck", "b.ck", "www.ck"]);
});

test("generated PAC uses only ASCII for Chrome proxy settings", () => {
  const input = context();
  const server = input.servers[0];
  if (!server) throw new Error("Missing fixture server");
  server.country = "Sverige å 😀";
  const pac = generatePac(input);
  expect([...pac].every((character) => character.charCodeAt(0) < 128)).toBe(
    true,
  );
  const sandbox: { FindProxyForURL?: (url: string, host: string) => string } =
    {};
  runInNewContext(pac, sandbox);
  expect(
    sandbox.FindProxyForURL?.("https://example.com", "example.com"),
  ).toContain("SOCKS5");
});
