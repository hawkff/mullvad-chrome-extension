import { beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect as connectTcp, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generatePac, validateServers } from "../../src/core";

// These tests load real extensions; no Chrome APIs are replaced by page fixtures.
beforeAll(async () => {
  const build = Bun.spawn(["bun", "scripts/build.ts", "--development"], {
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await build.exited, await new Response(build.stderr).text()).toBe(0);
});

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = async (method, params = {}) => {
    let timer;
    const current = ++id;
    try {
      const message = await Promise.race([
        new Promise((resolve) => {
          pending.set(current, resolve);
          socket.send(JSON.stringify({ id: current, method, params }));
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error(`CDP timeout: ${method}`)),
            10000,
          );
        }),
      ]);
      if (message.error) throw Error(JSON.stringify(message.error));
      return message.result;
    } finally {
      clearTimeout(timer);
      pending.delete(current);
    }
  };
  send.close = () => socket.close();
  return send;
}
async function evaluate(cdp, expression) {
  const result = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(action, description) {
  for (let i = 0; i < 100; i++) {
    const value = await action();
    if (value) return value;
    await Bun.sleep(100);
  }
  throw Error(`Timed out waiting for ${description}`);
}
async function launch(extension, flags = [], display) {
  if (!Bun.which("chromium"))
    throw Error(
      "Integration browser tests require chromium on PATH; install Chromium.",
    );
  const profile = await mkdtemp(join(tmpdir(), "proxy-integration-"));
  const process = Bun.spawn(
    [
      "chromium",
      ...(display ? [] : ["--headless"]),
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--remote-allow-origins=*",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      ...flags,
      "about:blank",
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...Bun.env, ...(display ? { DISPLAY: display } : {}) },
    },
  );
  const connections = [];
  let browser;
  try {
    const port = await waitFor(async () => {
      try {
        return (
          await readFile(join(profile, "DevToolsActivePort"), "utf8")
        ).split("\n")[0];
      } catch {
        return false;
      }
    }, "isolated Chromium CDP");
    const base = `http://127.0.0.1:${port}`;
    const version = await (await fetch(`${base}/json/version`)).json();
    browser = await connect(version.webSocketDebuggerUrl);
    connections.push(browser);
    const targets = async () => (await fetch(`${base}/json`)).json();
    const attach = async (id) => {
      const target = await waitFor(
        async () => (await targets()).find((t) => t.id === id),
        "current target",
      );
      const cdp = await connect(target.webSocketDebuggerUrl);
      connections.push(cdp);
      return cdp;
    };
    const page = async (url) => {
      const { targetId } = await browser("Target.createTarget", { url });
      const cdp = await attach(targetId);
      await waitFor(
        () => evaluate(cdp, "document.readyState === 'complete'"),
        "page ready",
      );
      return cdp;
    };
    return {
      browser,
      targets,
      attach,
      page,
      downloads: join(profile, "downloads"),
      async close() {
        for (const connection of connections) connection.close();
        process.kill();
        await process.exited;
        await rm(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const connection of connections) connection.close();
    process.kill();
    await process.exited;
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}
const message = (page, command) =>
  evaluate(page, `chrome.runtime.sendMessage(${JSON.stringify(command)})`);
const local = (page) => evaluate(page, "chrome.storage.local.get(null)");
const session = (page) =>
  evaluate(page, "chrome.storage.session.get('session.v1')");

test("real extension Incognito messages, session expiry and worker restart", async () => {
  const chrome = await launch(resolve("dist/development"));
  try {
    const worker = await waitFor(
      async () =>
        (await chrome.targets()).find((t) => t.type === "service_worker"),
      "extension worker",
    );
    const id = new URL(worker.url).host;
    let regular = await chrome.page(`chrome-extension://${id}/options.html`);
    expect((await message(regular, { type: "snapshot" })).ok).toBe(true);
    const extensions = await chrome.page("chrome://extensions/");
    await evaluate(
      extensions,
      "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true});true",
    );
    await evaluate(
      extensions,
      `chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(id)},incognitoAccess:true},()=>{});true`,
    );
    // Opt-in reloads the extension. A newly created page wakes the replacement worker.
    await Bun.sleep(500);
    regular = await chrome.page(`chrome-extension://${id}/options.html`);
    await waitFor(
      async () =>
        (await message(regular, { type: "snapshot" })).value?.incognitoAllowed,
      "Incognito opt-in",
    );
    const createPrivate = async (existing) => {
      const old = new Set((await chrome.targets()).map((target) => target.id));
      const window =
        existing ||
        (await evaluate(
          regular,
          `chrome.windows.create({incognito:true,url:'about:blank'})`,
        ));
      await evaluate(
        regular,
        `chrome.windows.update(${window.id},{focused:true})`,
      );
      await evaluate(
        regular,
        `chrome.action.openPopup({windowId:${window.id}})`,
      );
      const target = await waitFor(
        async () =>
          (await chrome.targets()).find(
            (target) =>
              target.url.includes(id) &&
              target.type === "page" &&
              !old.has(target.id),
          ),
        "private extension page",
      );
      const page = await chrome.attach(target.id);
      await waitFor(
        () =>
          evaluate(
            page,
            "document.readyState === 'complete' && Boolean(chrome.runtime?.id)",
          ),
        "private page ready",
      );
      return { window, page };
    };
    const first = await createPrivate();
    expect(
      await evaluate(
        first.page,
        "new Promise(r=>chrome.windows.getCurrent({},w=>r(w.incognito)))",
      ),
    ).toBe(true);
    const snapshot = await message(first.page, {
      type: "snapshot",
      context: "incognito",
    });
    expect(snapshot.ok).toBe(true);
    const diagnostic = await message(first.page, {
      type: "diagnostics.run",
      context: "incognito",
      checks: ["ipv4", "dns"],
    });
    expect(diagnostic).toMatchObject({ ok: false, error: { code: "blocked" } });
    expect(diagnostic.error.message).toContain("private-context");
    expect(
      await evaluate(
        first.page,
        "document.body.innerText.includes('Incognito')",
      ),
    ).toBe(true);
    const saved = await message(regular, {
      type: "server.select",
      serverId: "internal-default",
    });
    expect(saved.ok).toBe(true);
    const inherited = await message(first.page, {
      type: "snapshot",
      context: "incognito",
    });
    expect(inherited.value.incognitoProxy.settingScope).toBe("regular");
    const baseline = await local(regular);
    const regularBefore = await message(regular, { type: "snapshot" });
    const override = await message(first.page, {
      type: "settings.update",
      context: "incognito",
      patch: { enabled: false },
    });
    expect(override.ok).toBe(true);
    expect(await evaluate(first.page, "document.body.clientWidth")).toBe(384);
    expect(
      await evaluate(
        first.page,
        "document.body.innerText.includes('Regular settings')",
      ),
    ).toBe(true);
    if (Bun.env.BROWSER_EVIDENCE_DIR) {
      await mkdir(Bun.env.BROWSER_EVIDENCE_DIR, { recursive: true });
      const image = await first.page("Page.captureScreenshot", {
        format: "png",
      });
      await writeFile(
        join(Bun.env.BROWSER_EVIDENCE_DIR, "private-popup.png"),
        Buffer.from(image.data, "base64"),
      );
    }
    expect(override.value.incognitoProxy.settingScope).toBe(
      "incognito_session_only",
    );
    expect(await local(regular)).toEqual(baseline);
    expect(
      (await message(regular, { type: "snapshot" })).value.incognitoProxy,
    ).toEqual(regularBefore.value.incognitoProxy);
    expect((await message(first.page, { type: "snapshot" })).ok).toBe(false);
    expect(
      (await message(regular, { type: "snapshot", context: "incognito" })).ok,
    ).toBe(false);
    const second = await createPrivate();
    const [nonLastMutation] = await Promise.all([
      message(second.page, {
        type: "settings.update",
        context: "incognito",
        patch: { enabled: true },
      }),
      evaluate(regular, `chrome.windows.remove(${first.window.id})`),
    ]);
    expect(nonLastMutation.ok).toBe(true);
    const privateBeforeRestart = (await session(regular))["session.v1"];
    const privateWorker = (await chrome.targets()).find(
      (target) => target.type === "service_worker",
    );
    await chrome.browser("Target.closeTarget", { targetId: privateWorker.id });
    const privateRestarted = await message(second.page, {
      type: "snapshot",
      context: "incognito",
    });
    expect(privateRestarted.value.incognitoProxy.settingScope).toBe(
      "incognito_session_only",
    );
    expect((await session(regular))["session.v1"].privateSeed).toBe(
      privateBeforeRestart.privateSeed,
    );
    expect((await session(regular))["session.v1"].privateSeed).toBeTruthy();
    const unrelated = await evaluate(
      regular,
      "chrome.windows.create({url:'about:blank'})",
    );
    const oldPopup = (await chrome.targets()).find((target) =>
      target.url.endsWith("/popup.html"),
    );
    if (oldPopup)
      await chrome.browser("Target.closeTarget", { targetId: oldPopup.id });
    await Bun.sleep(100);
    second.page = (await createPrivate(second.window)).page;
    // Actual browser operations overlap; deterministic edge timing is covered by controller tests.
    const [mutation] = await Promise.all([
      message(second.page, {
        type: "settings.update",
        context: "incognito",
        patch: { randomMode: false },
      }),
      evaluate(regular, `chrome.windows.remove(${unrelated.id})`),
    ]);
    expect(mutation.ok).toBe(true);
    expect((await session(regular))["session.v1"].privateSeed).toBeTruthy();
    await evaluate(regular, `chrome.windows.remove(${second.window.id})`);
    await waitFor(
      async () => !(await session(regular))["session.v1"].privateSeed,
      "last-private-window seed cleanup",
    );
    expect((await session(regular))["session.v1"].privateState).toBeUndefined();
    const reopened = await createPrivate();
    const fresh = await message(reopened.page, {
      type: "snapshot",
      context: "incognito",
    });
    expect(fresh.value.history).toEqual([]);
    expect(fresh.value.incognitoProxy.settingScope).toBe("regular");
    expect(await local(regular)).toEqual(baseline);
    await evaluate(regular, `chrome.windows.remove(${reopened.window.id})`);
    const random = await message(regular, {
      type: "settings.update",
      patch: { randomMode: true },
    });
    expect(random.ok).toBe(true);
    const before = await session(regular);

    const current = (await chrome.targets()).find(
      (target) => target.type === "service_worker",
    );
    await chrome.browser("Target.closeTarget", { targetId: current.id });
    await Bun.sleep(300);
    const restarted = await message(regular, { type: "snapshot" });
    expect(restarted.ok).toBe(true);
    expect(
      (await chrome.targets()).some((target) => target.id === current.id),
    ).toBe(false);
    expect(restarted.value.settings.routing.randomMode).toBe(true);
    expect((await session(regular))["session.v1"].seed).toBe(
      before["session.v1"].seed,
    );
    expect((await session(regular))["session.v1"].pool).toEqual(
      before["session.v1"].pool,
    );
    expect(before["session.v1"].seed).toBeTruthy();
    // A labeled controlled catalog allows Firefox endpoint conversion without a live VPN/API.
    const catalog = validateServers(
      await Bun.file("tests/core/fixtures/servers.json").json(),
    );
    expect(catalog.ok).toBe(true);
    await evaluate(
      regular,
      `chrome.storage.local.set({'servers.v1':${JSON.stringify(catalog.value)}})`,
    );
    const controlledSession = (await session(regular))["session.v1"];
    await evaluate(
      regular,
      `chrome.storage.session.set({'session.v1':${JSON.stringify({ ...controlledSession, pool: catalog.value })}})`,
    );
    const cachedWorker = (await chrome.targets()).find(
      (target) => target.type === "service_worker",
    );
    await chrome.browser("Target.closeTarget", { targetId: cachedWorker.id });
    const resumed = await message(regular, { type: "snapshot" });
    expect(resumed.value.settings.routing.randomMode).toBe(true);
    expect((await session(regular))["session.v1"].seed).toBe(
      controlledSession.seed,
    );
    expect((await session(regular))["session.v1"].pool).toEqual(catalog.value);
    const firefox = await Bun.file("tests/core/fixtures/firefox.json").json();
    const imported = await message(regular, {
      type: "settings.import",
      data: firefox,
    });
    expect(imported.ok).toBe(true);
    const exported = await message(regular, { type: "settings.export" });
    expect(exported.value.settings.routing.rules[0].serverId).toBe(
      catalog.value[0].id,
    );
    expect(
      (
        await message(regular, {
          type: "settings.import",
          data: exported.value,
        })
      ).ok,
    ).toBe(true);
    const stable = await message(regular, { type: "settings.export" });
    expect(
      (
        await message(regular, {
          type: "settings.import",
          data: {
            ...firefox,
            globalProxy: { ...firefox.globalProxy, proxyDNS: false },
          },
        })
      ).ok,
    ).toBe(false);
    expect(await message(regular, { type: "settings.export" })).toEqual(stable);
    await chrome.browser("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: chrome.downloads,
    });
    await evaluate(
      regular,
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Import / export').click()",
    );
    await waitFor(
      () =>
        evaluate(
          regular,
          "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Export settings')",
        ),
      "export control",
    );
    await evaluate(
      regular,
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Export settings').click()",
    );
    const download = await waitFor(async () => {
      try {
        return JSON.parse(
          await readFile(
            join(chrome.downloads, "mullvad-proxy-settings.json"),
            "utf8",
          ),
        );
      } catch {
        return false;
      }
    }, "actual export file download");
    expect(download).toEqual(stable.value);
  } finally {
    await chrome.close();
  }
}, 60000);

test("Incognito mandatory PAC runtime errors never fall back to a non-loopback target", async () => {
  const ip = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
  if (!ip)
    throw Error(
      "A non-loopback IPv4 interface is required for the PAC security gate",
    );
  const fixture = await mkdtemp(join(tmpdir(), "pac-control-"));
  let hits = 0;
  const target = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/probe") hits++;
      return new Response("controlled target");
    },
  });
  const clients = new Set();
  const socks = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    let buffer = Buffer.alloc(0);
    let greeting = true;
    socket.on("data", function handshake(data) {
      buffer = Buffer.concat([buffer, data]);
      if (greeting) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]);
        greeting = false;
        socket.write(Buffer.from([5, 0]));
      }
      if (buffer.length < 5) return;
      const length =
        buffer[3] === 3 ? 7 + buffer[4] : buffer[3] === 1 ? 10 : 22;
      if (buffer.length < length) return;
      socket.removeListener("data", handshake);
      const upstream = connectTcp(target.port, ip, () => {
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (buffer.length > length) upstream.write(buffer.subarray(length));
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      clients.add(upstream);
      upstream.on("close", () => clients.delete(upstream));
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
  });
  let chrome;
  try {
    await new Promise((resolve) => socks.listen(0, "0.0.0.0", resolve));
    await writeFile(
      join(fixture, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "PAC browser control",
        version: "1",
        incognito: "spanning",
        permissions: ["proxy"],
        background: { service_worker: "worker.js" },
        action: { default_popup: "popup.html" },
      }),
    );
    await writeFile(
      join(fixture, "worker.js"),
      "chrome.runtime.onInstalled.addListener(()=>{});",
    );
    await writeFile(
      join(fixture, "popup.html"),
      "<!doctype html><title>PAC browser control</title>",
    );
    chrome = await launch(fixture, [
      `--host-resolver-rules=MAP probe.test ${ip}`,
    ]);
    const worker = await waitFor(
      async () =>
        (await chrome.targets()).find((t) => t.type === "service_worker"),
      "PAC fixture worker",
    );
    const id = new URL(worker.url).host;
    const extensions = await chrome.page("chrome://extensions/");
    await evaluate(
      extensions,
      "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true});true",
    );
    await evaluate(
      extensions,
      `chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(id)},incognitoAccess:true},()=>{});true`,
    );
    await Bun.sleep(500);
    const control = await chrome.page(`chrome-extension://${id}/popup.html`);
    const old = new Set((await chrome.targets()).map((t) => t.id));
    const window = await evaluate(
      control,
      "chrome.windows.create({incognito:true,url:'about:blank'})",
    );
    const privateTarget = await waitFor(
      async () =>
        (await chrome.targets()).find(
          (t) => t.type === "page" && !old.has(t.id),
        ),
      "private destination target",
    );
    const page = await chrome.attach(privateTarget.id);
    const install = async (data) => {
      await evaluate(
        control,
        `new Promise((resolve,reject)=>chrome.proxy.settings.set({value:{mode:'pac_script',pacScript:{data:${JSON.stringify(data)},mandatory:true}},scope:'incognito_session_only'},()=>chrome.runtime.lastError?reject(Error(chrome.runtime.lastError.message)):resolve(true)))`,
      );
      expect(
        await evaluate(
          control,
          "new Promise(r=>chrome.proxy.settings.get({incognito:true},r))",
        ),
      ).toMatchObject({
        incognitoSpecific: true,
        value: { mode: "pac_script", pacScript: { mandatory: true } },
      });
    };
    let sequence = 0;
    const request = async () => {
      const result = await page("Page.navigate", {
        url: `http://probe.test:${target.port}/probe?${sequence++}`,
      });
      await Bun.sleep(200);
      return result;
    };
    await install('function FindProxyForURL(){return "DIRECT";}');
    await request();
    expect(hits).toBe(1);
    await install(
      `function FindProxyForURL(){return "SOCKS5 ${ip}:${socks.address().port}";}`,
    );
    await request();
    expect(hits).toBe(2);
    const pac = generatePac({
      settings: {
        enabled: true,
        globalServerId: "missing",
        randomMode: false,
        rules: [],
        exclusions: [],
      },
      servers: [],
      sessionSeed: "browser-control",
    });
    await install(pac);
    for (let i = 0; i < 4; i++) {
      expect((await request()).errorText).toBe(
        "net::ERR_MANDATORY_PROXY_CONFIGURATION_FAILED",
      );
      expect(hits).toBe(2);
    }
    await evaluate(control, `chrome.windows.remove(${window.id})`);
  } finally {
    if (chrome) await chrome.close();
    for (const client of clients) client.destroy();
    socks.close();
    target.stop(true);
    await rm(fixture, { recursive: true, force: true });
  }
}, 60000);

test("actual optional permission grants and revocation", async () => {
  if (!Bun.which("Xvfb") || !Bun.which("xdotool"))
    throw Error("Permission browser gate requires Xvfb and xdotool");
  const xvfb = Bun.spawn(
    [
      "Xvfb",
      "-displayfd",
      "1",
      "-screen",
      "0",
      "1280x900x24",
      "-nolisten",
      "tcp",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const reader = xvfb.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  const display = `:${new TextDecoder().decode(first.value).trim()}`;
  let chrome;
  try {
    chrome = await launch(resolve("dist/development"), [], display);
    const worker = await waitFor(
      async () =>
        (await chrome.targets()).find(
          (target) => target.type === "service_worker",
        ),
      "permission worker",
    );
    const id = new URL(worker.url).host;
    const page = await chrome.page(`chrome-extension://${id}/options.html`);
    const grantPending = page("Runtime.evaluate", {
      expression:
        "chrome.permissions.request({permissions:['privacy','tabs']})",
      userGesture: true,
      awaitPromise: true,
      returnByValue: true,
    });
    await Bun.sleep(700);
    const key = Bun.spawn(["xdotool", "key", "Return"], {
      env: { ...Bun.env, DISPLAY: display },
    });
    expect(await key.exited).toBe(0);
    const grant = await grantPending;
    expect(grant.result.value).toBe(false);
    expect(
      (
        await message(page, {
          type: "privacy.set",
          control: "webRtcNonProxiedUdp",
          enabled: true,
        })
      ).ok,
    ).toBe(false);
    const accepted = page("Runtime.evaluate", {
      expression:
        "chrome.permissions.request({permissions:['privacy','tabs']})",
      userGesture: true,
      awaitPromise: true,
      returnByValue: true,
    });
    await Bun.sleep(700);
    const acceptKey = Bun.spawn(["xdotool", "key", "Tab", "Return"], {
      env: { ...Bun.env, DISPLAY: display },
    });
    expect(await acceptKey.exited).toBe(0);
    expect((await accepted).result.value).toBe(true);
    expect(
      (
        await message(page, {
          type: "privacy.set",
          control: "webRtcNonProxiedUdp",
          enabled: true,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await message(page, {
          type: "privacy.restore",
          control: "webRtcNonProxiedUdp",
        })
      ).ok,
    ).toBe(true);
    expect(
      await evaluate(
        page,
        "chrome.permissions.remove({permissions:['privacy','tabs']})",
      ),
    ).toBe(true);
    expect(
      await evaluate(
        page,
        "chrome.permissions.contains({permissions:['privacy','tabs']})",
      ),
    ).toBe(false);
    expect(
      (
        await message(page, {
          type: "privacy.set",
          control: "webRtcNonProxiedUdp",
          enabled: true,
        })
      ).ok,
    ).toBe(false);
  } finally {
    if (chrome) await chrome.close();
    xvfb.kill();
    await xvfb.exited;
  }
}, 30000);

test("another extension owns proxy without destructive restoration", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "proxy-owner-"));
  let chrome;
  try {
    await writeFile(
      join(fixture, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Proxy ownership control",
        version: "1",
        permissions: ["proxy"],
      }),
    );
    await writeFile(
      join(fixture, "control.html"),
      "<!doctype html><title>Proxy ownership control</title>",
    );
    chrome = await launch(`${resolve("dist/development")},${fixture}`);
    const worker = await waitFor(
      async () =>
        (await chrome.targets()).find((target) =>
          target.url.endsWith("/background/index.js"),
        ),
      "application worker",
    );
    const id = new URL(worker.url).host;
    const page = await chrome.page(`chrome-extension://${id}/options.html`);
    expect(
      (
        await message(page, {
          type: "server.select",
          serverId: "internal-default",
        })
      ).ok,
    ).toBe(true);
    const extensions = await chrome.page("chrome://extensions/");
    const otherId = await evaluate(
      extensions,
      "chrome.developerPrivate.getExtensionsInfo({}).then(items=>items.find(item=>item.name==='Proxy ownership control').id)",
    );
    const control = await chrome.page(
      `chrome-extension://${otherId}/control.html`,
    );
    await evaluate(
      control,
      "new Promise((resolve,reject)=>chrome.proxy.settings.set({value:{mode:'direct'},scope:'regular'},()=>chrome.runtime.lastError?reject(Error(chrome.runtime.lastError.message)):resolve(true)))",
    );
    const snapshot = await message(page, { type: "snapshot" });
    expect(snapshot.value.proxy.ownership).toBe(
      "controlled_by_other_extensions",
    );
    expect(snapshot.value.proxy.applied).toBe(false);
    expect(
      (
        await message(page, {
          type: "settings.update",
          patch: { enabled: false },
        })
      ).ok,
    ).toBe(false);
    expect(
      await evaluate(
        control,
        "new Promise(resolve=>chrome.proxy.settings.get({},resolve))",
      ),
    ).toMatchObject({
      levelOfControl: "controlled_by_this_extension",
      value: { mode: "direct" },
    });
    await evaluate(
      control,
      "new Promise(resolve=>chrome.proxy.settings.clear({scope:'regular'},resolve))",
    );
    await waitFor(
      async () =>
        (await message(page, { type: "snapshot" })).value.proxy.applied,
      "own PAC restored after competing owner clears",
    );
  } finally {
    if (chrome) await chrome.close();
    await rm(fixture, { recursive: true, force: true });
  }
}, 30000);
