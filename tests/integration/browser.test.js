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
    socket.onclose = () => reject(Error("CDP connection closed"));
    socket.onerror = () => {
      socket.close();
      reject(Error("CDP connection failed"));
    };
  });
  let id = 0;
  const pending = new Map();
  socket.onclose = () => {
    for (const resolve of pending.values())
      resolve({ error: { message: "CDP connection closed" } });
    pending.clear();
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = async (method, params = {}) => {
    if (socket.readyState !== WebSocket.OPEN)
      throw Error("CDP connection closed");
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
      let cdp;
      try {
        cdp = await attach(targetId);
        await waitFor(
          () => evaluate(cdp, "document.readyState === 'complete'"),
          "page ready",
        );
        return cdp;
      } catch (error) {
        cdp?.close();
        // Reload may already have removed this target; preserve the readiness error.
        await browser("Target.closeTarget", { targetId }).catch(() => {});
        throw error;
      }
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

async function incognitoOptions(chrome, extensions, id, previous) {
  previous.close();
  await waitFor(
    () =>
      evaluate(
        extensions,
        `new Promise(r=>chrome.developerPrivate.getExtensionInfo(${JSON.stringify(id)},info=>r(Boolean(info?.incognitoAccess?.isActive))))`,
      ),
    "Incognito configuration enabled",
  );
  let page;
  try {
    return await waitFor(async () => {
      try {
        page ??= await chrome.page(`chrome-extension://${id}/options.html`);
        if (!(await evaluate(page, "Boolean(globalThis.chrome?.runtime?.id)")))
          throw Error("Extension context not ready");
        const snapshot = await message(page, { type: "snapshot" });
        if (snapshot && !snapshot.ok)
          throw Error(
            `Incognito readiness snapshot rejected: ${snapshot.error.code}`,
          );
        return snapshot?.value?.incognitoAllowed && page;
      } catch (error) {
        page?.close();
        page = undefined;
        // Only transport/context loss during reload is retryable here.
        if (
          !/CDP connection (?:failed|closed)|WebSocket.*(?:not open|closed|closing)|Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed|No target with given id|Extension context (?:invalidated|not ready)|Could not establish connection|message port closed|message channel closed/i.test(
            String(error),
          )
        )
          throw error;
        return false;
      }
    }, "Incognito options page and snapshot after reload");
  } catch (error) {
    page?.close();
    throw error;
  }
}

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
    const enabled = await message(regular, {
      type: "settings.update",
      patch: { enabled: true },
    });
    expect(enabled.ok).toBe(true);
    expect(enabled.value.settings.routing.globalServerId).toBe(
      "internal-default",
    );
    expect(enabled.value.proxy.applied).toBe(true);
    const extensions = await chrome.page("chrome://extensions/");
    await evaluate(
      extensions,
      "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true});true",
    );
    await evaluate(
      extensions,
      `chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(id)},incognitoAccess:true},()=>{});true`,
    );
    regular = await incognitoOptions(chrome, extensions, id, regular);
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
    await evaluate(
      regular,
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Routing').click()",
    );
    await waitFor(
      () =>
        evaluate(regular, "Boolean(document.querySelector('#website-domain'))"),
      "manual domain entry",
    );
    const setDomain = (domain) =>
      evaluate(
        regular,
        `(()=>{const input=document.querySelector('#website-domain');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(domain)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
    const click = (text) =>
      evaluate(
        regular,
        `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`,
      );
    await setDomain("https://example.co.uk/path");
    await click("Choose site location");
    await waitFor(
      () =>
        evaluate(regular, "Boolean(document.querySelector('#server-search'))"),
      "manual-domain location picker",
    );
    await click("Use VPN-internal default");
    await waitFor(
      () =>
        evaluate(
          regular,
          "document.querySelector('[role=alert]')?.textContent.includes('invalid-input')",
        ),
      "authoritative invalid host error",
    );
    expect(await message(regular, { type: "settings.export" })).toEqual(stable);
    await setDomain("example.co.uk");
    await click("Use VPN-internal default");
    await waitFor(
      () => evaluate(regular, "!document.querySelector('#server-search')"),
      "manual parent rule saved",
    );
    const manual = await message(regular, { type: "snapshot" });
    expect(manual.value.settings.routing.rules).toContainEqual({
      host: "example.co.uk",
      serverId: "internal-default",
      enabled: true,
    });
    await setDomain("Example.com.");
    await click("Choose site location");
    await waitFor(
      () =>
        evaluate(regular, "Boolean(document.querySelector('#server-search'))"),
      "variant-domain picker",
    );
    await click("Use VPN-internal default");
    await waitFor(
      () => evaluate(regular, "!document.querySelector('#server-search')"),
      "canonical rule created",
    );
    expect(
      (
        await message(regular, { type: "snapshot" })
      ).value.settings.routing.rules.some(
        (rule) => rule.host === "example.com",
      ),
    ).toBe(true);
    await setDomain("EXAMPLE.COM.");
    expect(
      await evaluate(
        regular,
        "document.querySelector('#website-domain').value",
      ),
    ).toBe("EXAMPLE.COM.");
    await waitFor(
      () =>
        evaluate(
          regular,
          "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Reset site rule')",
        ),
      "canonical existing rule controls before mutation",
    );
    if (Bun.env.BROWSER_EVIDENCE_DIR) {
      await mkdir(Bun.env.BROWSER_EVIDENCE_DIR, { recursive: true });
      await regular("Emulation.setDeviceMetricsOverride", {
        width: 800,
        height: 850,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(
        regular,
        "document.querySelector('label[for=website-domain]').scrollIntoView({block:'start'})",
      );
      const image = await regular("Page.captureScreenshot", { format: "png" });
      await writeFile(
        join(Bun.env.BROWSER_EVIDENCE_DIR, "canonical-domain-controls.png"),
        Buffer.from(image.data, "base64"),
      );
    }
    await click("Reset site rule");
    await waitFor(
      () =>
        evaluate(
          regular,
          "!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Reset site rule')",
        ),
      "canonical rule removed",
    );
    for (const [saved, variant] of [
      ["example.com", "Example.com."],
      ["xn--bcher-kva.de", "BÜCHER.de."],
    ]) {
      expect(
        (
          await message(regular, {
            type: "exclusion.set",
            host: saved,
            excluded: true,
          })
        ).ok,
      ).toBe(true);
      await click("Refresh status");
      await waitFor(
        () =>
          evaluate(
            regular,
            "document.body.innerText.includes('Status refreshed.')",
          ),
        "saved exclusion refreshed",
      );
      await setDomain(variant);
      expect(
        await evaluate(
          regular,
          "document.querySelector('#website-domain').value",
        ),
      ).toBe(variant);
      await waitFor(
        () =>
          evaluate(
            regular,
            "Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='Remove exclusion').length > 1",
          ),
        "canonical exclusion lookup before mutation",
      );
      await click("Remove exclusion");
      expect(
        (await message(regular, { type: "snapshot" })).value.settings.routing
          .exclusions,
      ).not.toContain(saved);
    }
    await message(regular, {
      type: "rule.upsert",
      rule: {
        host: "example.com",
        enabled: true,
        serverId: "internal-default",
      },
    });
    await message(regular, {
      type: "exclusion.set",
      host: "example.com",
      excluded: true,
    });
    await click("Refresh status");
    await waitFor(
      () =>
        evaluate(
          regular,
          "document.body.innerText.includes('Status refreshed.')",
        ),
      "entries refreshed before invalid input",
    );
    await setDomain("https://example.com/");
    expect(
      await evaluate(
        regular,
        "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Reset site rule')",
      ),
    ).toBe(false);
    expect(
      await evaluate(
        regular,
        "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Add exclusion')",
      ),
    ).toBe(true);
    await message(regular, { type: "rule.remove", host: "example.com" });
    await message(regular, {
      type: "exclusion.set",
      host: "example.com",
      excluded: false,
    });
    await setDomain("excluded.example.co.uk");
    await click("Add exclusion");
    await waitFor(
      () =>
        evaluate(
          regular,
          "document.querySelector('.rule') && document.body.innerText.includes('Inactive while random mode is on')",
        ),
      "inactive saved exclusion warning",
    );
    expect(
      (await message(regular, { type: "snapshot" })).value.settings.routing
        .exclusions,
    ).toContain("excluded.example.co.uk");
    expect(
      await evaluate(
        regular,
        "document.body.innerText.includes('Random mode overrides global and website selections and all exclusions')",
      ),
    ).toBe(true);
    expect(
      await evaluate(
        regular,
        "document.body.innerText.includes('Saved exclusions are inactive')",
      ),
    ).toBe(true);
    const toggleRandom = () =>
      evaluate(
        regular,
        "Array.from(document.querySelectorAll('label')).find(label=>label.textContent.trim()==='Random mode').querySelector('input').click()",
      );
    await toggleRandom();
    await waitFor(
      () =>
        evaluate(
          regular,
          "document.body.innerText.includes('Direct while random mode is off')",
        ),
      "exclusion active without random mode",
    );
    expect(
      await evaluate(
        regular,
        "document.body.innerText.includes('Inactive while random mode is on')",
      ),
    ).toBe(false);
    await toggleRandom();
    await waitFor(
      () =>
        evaluate(
          regular,
          "document.body.innerText.includes('Saved exclusions are inactive')",
        ),
      "random override restored",
    );
    expect(
      (await chrome.targets())
        .filter((target) => target.type === "page")
        .every((target) => !target.url.startsWith("https://example.co.uk")),
    ).toBe(true);
    for (const width of [360, 800]) {
      await regular("Emulation.setDeviceMetricsOverride", {
        width,
        height: 850,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(
        regular,
        "document.querySelector('label[for=website-domain]').scrollIntoView({block:'start'})",
      );
      expect(
        await evaluate(
          regular,
          "document.documentElement.scrollWidth <= innerWidth",
        ),
      ).toBe(true);
      if (Bun.env.BROWSER_EVIDENCE_DIR) {
        const image = await regular("Page.captureScreenshot", {
          format: "png",
        });
        await writeFile(
          join(Bun.env.BROWSER_EVIDENCE_DIR, `options-domain-${width}.png`),
          Buffer.from(image.data, "base64"),
        );
      }
    }
    expect(
      (
        await message(regular, {
          type: "server.select",
          serverId: catalog.value[0].id,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await message(regular, {
          type: "settings.update",
          patch: { enabled: false, randomMode: false },
        })
      ).ok,
    ).toBe(true);
    await evaluate(regular, "chrome.storage.local.set({'servers.v1':[]})");
    const retiringWorker = (await chrome.targets()).find(
      (target) => target.type === "service_worker",
    );
    await chrome.browser("Target.closeTarget", { targetId: retiringWorker.id });
    const retired = await message(regular, { type: "snapshot" });
    expect(retired.ok).toBe(true);
    expect(retired.value.settings.routing.globalServerId).toBe(
      catalog.value[0].id,
    );
    expect(
      retired.value.history.some(
        (entry) => entry.serverId === catalog.value[0].id,
      ),
    ).toBe(true);
    expect((await message(regular, { type: "settings.export" })).ok).toBe(true);
    expect((await message(regular, { type: "history.clear" })).ok).toBe(true);
    expect(
      (
        await message(regular, {
          type: "server.select",
          serverId: "internal-default",
        })
      ).ok,
    ).toBe(true);
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
  let socksRequests = 0;
  const target = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/probe") hits++;
      return new Response("controlled target", {
        headers: { Connection: "close" },
      });
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
      socksRequests++;
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
      `--host-resolver-rules=MAP probe.test ${ip}, MAP *.probe.test ${ip}`,
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
    const request = async (host = "probe.test") => {
      const result = await page("Page.navigate", {
        url: `http://${host}:${target.port}/probe?${sequence++}`,
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
    const mixedPac = generatePac({
      settings: {
        enabled: false,
        globalServerId: null,
        randomMode: false,
        exclusions: [],
        rules: [
          { host: "blocked.probe.test", enabled: true, serverId: "retired" },
          {
            host: "proxy-control.probe.test",
            enabled: true,
            serverId: "controlled.relays.mullvad.net",
          },
          {
            host: "proxied.probe.test",
            enabled: true,
            serverId: "controlled.relays.mullvad.net",
          },
        ],
      },
      servers: [
        {
          id: "controlled.relays.mullvad.net",
          hostname: "controlled.relays.mullvad.net",
          ipv4: ip,
          ipv6: "",
          port: socks.address().port,
          online: true,
          country: "Control",
          countryCode: "XX",
          city: "Control",
        },
      ],
      sessionSeed: "mixed-control",
    });
    await install(mixedPac);
    const mixedBaseline = hits;
    expect(
      (await request("direct-control.probe.test")).errorText,
    ).toBeUndefined();
    expect(
      (await request("proxy-control.probe.test")).errorText,
    ).toBeUndefined();
    expect(hits).toBe(mixedBaseline + 2);
    expect((await request("blocked.probe.test")).errorText).toBe(
      "net::ERR_MANDATORY_PROXY_CONFIGURATION_FAILED",
    );
    expect(hits).toBe(mixedBaseline + 2);
    // Fresh destination hosts prevent earlier successful PAC decisions masking backoff.
    const afterError = {};
    for (const host of ["direct.probe.test", "proxied.probe.test"]) {
      const beforeHits = hits;
      const beforeSocks = socksRequests;
      const result = await request(host);
      if (result.errorText) {
        expect(result.errorText).toBe(
          "net::ERR_MANDATORY_PROXY_CONFIGURATION_FAILED",
        );
        expect(hits).toBe(beforeHits);
        afterError[host] = "mandatory-backoff";
      } else {
        expect(hits).toBe(beforeHits + 1);
        if (host === "proxied.probe.test")
          expect(socksRequests).toBeGreaterThan(beforeSocks);
        afterError[host] = host.startsWith("direct") ? "direct" : "socks5";
      }
    }
    // Chromium may back off the entire mandatory PAC after one destination throws.
    console.log(
      "Mixed mandatory PAC after runtime error:",
      JSON.stringify(afterError),
    );
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
  let reloadServer;
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
    let page = await chrome.page(`chrome-extension://${id}/options.html`);
    const extensions = await chrome.page("chrome://extensions/");
    await evaluate(
      extensions,
      "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true});true",
    );
    await evaluate(
      extensions,
      `chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(id)},incognitoAccess:true},()=>{});true`,
    );
    page = await incognitoOptions(chrome, extensions, id, page);
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
    let reloadHits = 0;
    reloadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/reload") reloadHits++;
        return new Response("reload target", {
          headers: { "Cache-Control": "no-store" },
        });
      },
    });
    expect(
      await evaluate(
        page,
        "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Use active website')",
      ),
    ).toBe(false);
    await evaluate(
      page,
      "Array.from(document.querySelectorAll('label')).find(l=>l.textContent.includes('Reload the active website')).querySelector('input').click()",
    );
    await waitFor(
      async () =>
        (await message(page, { type: "snapshot" })).value.settings.preferences
          .autoReload,
      "auto-reload preference enabled with granted tabs access",
    );
    const reloadUrl = new URL("reload", reloadServer.url).href;
    const liveTab = await evaluate(
      page,
      `chrome.tabs.create({url:${JSON.stringify(reloadUrl)},active:true})`,
    );
    await waitFor(() => reloadHits === 1, "initial controlled website load");
    const oldTargets = new Set(
      (await chrome.targets()).map((target) => target.id),
    );
    await evaluate(
      page,
      `chrome.action.openPopup({windowId:${liveTab.windowId}})`,
    );
    const popupTarget = await waitFor(
      async () =>
        (await chrome.targets()).find(
          (target) =>
            target.url.endsWith("/popup.html") && !oldTargets.has(target.id),
        ),
      "fresh auto-reload popup",
    );
    const popup = await chrome.attach(popupTarget.id);
    await waitFor(
      () =>
        evaluate(
          popup,
          "Boolean(document.querySelector('input[type=checkbox]')) && !document.querySelector('input[type=checkbox]').disabled",
        ),
      "fresh popup ready",
    );
    // No Use active website action: a global change must independently find the current website.
    await evaluate(
      popup,
      "document.querySelector('input[type=checkbox]').click()",
    );
    await waitFor(() => reloadHits === 2, "fresh-popup global change reload");
    expect(reloadHits).toBe(2);
    await evaluate(
      page,
      `chrome.tabs.update(${liveTab.id},{url:'about:blank'})`,
    );
    await Bun.sleep(200);
    await evaluate(
      popup,
      "document.querySelector('input[type=checkbox]').click()",
    );
    await waitFor(
      () =>
        evaluate(
          popup,
          "document.querySelector('[role=alert]')?.textContent.includes('HTTP or HTTPS')",
        ),
      "no valid website reload target",
    );
    expect(reloadHits).toBe(2);
    await chrome.browser("Target.closeTarget", { targetId: popupTarget.id });
    // Even with a valid active website, options changes must not reload it.
    await evaluate(
      page,
      `chrome.tabs.update(${liveTab.id},{url:${JSON.stringify(reloadUrl)}})`,
    );
    await waitFor(() => reloadHits === 3, "new current website load");
    await evaluate(
      page,
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Refresh status').click()",
    );
    await waitFor(
      () =>
        evaluate(page, "document.body.innerText.includes('Status refreshed.')"),
      "options refreshed",
    );
    await evaluate(
      page,
      "document.querySelector('input[type=checkbox]').click()",
    );
    await waitFor(
      async () =>
        (await message(page, { type: "snapshot" })).value.settings.routing
          .enabled,
      "options global change saved",
    );
    await Bun.sleep(200);
    expect(reloadHits).toBe(3);
    const privateOld = new Set(
      (await chrome.targets()).map((target) => target.id),
    );
    const privateWindow = await evaluate(
      page,
      `chrome.windows.create({incognito:true,url:${JSON.stringify(reloadUrl)}})`,
    );
    await waitFor(
      () => reloadHits === 4,
      "initial private controlled website load",
    );
    await evaluate(
      page,
      `chrome.action.openPopup({windowId:${privateWindow.id}})`,
    );
    const privateTarget = await waitFor(
      async () =>
        (await chrome.targets()).find(
          (target) =>
            target.url.endsWith("/popup.html") && !privateOld.has(target.id),
        ),
      "shared-preference private popup",
    );
    const privatePopup = await chrome.attach(privateTarget.id);
    await waitFor(
      () =>
        evaluate(
          privatePopup,
          "Boolean(document.querySelector('input[type=checkbox]'))",
        ),
      "private popup ready",
    );
    expect(
      await evaluate(
        privatePopup,
        "new Promise(r=>chrome.windows.getCurrent({},w=>r(w.incognito)))",
      ),
    ).toBe(true);
    expect(
      (
        await message(privatePopup, {
          type: "settings.update",
          context: "incognito",
          patch: { enabled: false },
        })
      ).ok,
    ).toBe(true);
    await evaluate(
      privatePopup,
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Refresh status').click()",
    );
    await waitFor(
      () =>
        evaluate(
          privatePopup,
          "document.body.innerText.includes('Status refreshed.')",
        ),
      "private override reflected in UI",
    );
    await message(page, {
      type: "settings.update",
      patch: { autoReload: false },
    });
    expect(
      (await message(privatePopup, { type: "snapshot", context: "incognito" }))
        .value.settings.preferences.autoReload,
    ).toBe(false);
    const sharedDisabledStorage = await local(page);
    await evaluate(
      privatePopup,
      "document.querySelector('input[type=checkbox]').click()",
    );
    await waitFor(
      () =>
        evaluate(
          privatePopup,
          "document.body.innerText.includes('Settings updated.')",
        ),
      "private route with shared reload disabled",
    );
    await Bun.sleep(250);
    expect(reloadHits).toBe(4);
    expect(await local(page)).toEqual(sharedDisabledStorage);
    await message(page, {
      type: "settings.update",
      patch: { autoReload: true },
    });
    const sharedEnabledStorage = await local(page);
    await evaluate(
      privatePopup,
      "document.querySelector('input[type=checkbox]').click()",
    );
    await waitFor(
      () => reloadHits === 5,
      "private popup uses current shared enabled preference",
    );
    expect(await local(page)).toEqual(sharedEnabledStorage);
    expect(
      (
        await message(privatePopup, {
          type: "settings.export",
          context: "incognito",
        })
      ).value.settings.preferences.autoReload,
    ).toBe(true);
    await evaluate(page, `chrome.windows.remove(${privateWindow.id})`);
    await waitFor(
      async () => !(await session(page))["session.v1"].privateState,
      "shared-preference private override cleanup",
    );
    const afterPrivateHits = reloadHits;
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
    const revokedTargets = new Set(
      (await chrome.targets()).map((target) => target.id),
    );
    await evaluate(
      page,
      `chrome.action.openPopup({windowId:${liveTab.windowId}})`,
    );
    const revokedTarget = await waitFor(
      async () =>
        (await chrome.targets()).find(
          (target) =>
            target.url.endsWith("/popup.html") &&
            !revokedTargets.has(target.id),
        ),
      "popup after tab permission revocation",
    );
    const revokedPopup = await chrome.attach(revokedTarget.id);
    await waitFor(
      () =>
        evaluate(
          revokedPopup,
          "Boolean(document.querySelector('input[type=checkbox]'))",
        ),
      "revoked-permission popup ready",
    );
    await evaluate(
      revokedPopup,
      "document.querySelector('input[type=checkbox]').click()",
    );
    await waitFor(
      () =>
        evaluate(
          revokedPopup,
          "document.querySelector('[role=alert]')?.textContent.includes('Tab access is unavailable')",
        ),
      "visible revoked-permission reload failure",
    );
    expect(reloadHits).toBe(afterPrivateHits);
    if (Bun.env.BROWSER_EVIDENCE_DIR) {
      await mkdir(Bun.env.BROWSER_EVIDENCE_DIR, { recursive: true });
      const image = await revokedPopup("Page.captureScreenshot", {
        format: "png",
      });
      await writeFile(
        join(Bun.env.BROWSER_EVIDENCE_DIR, "autoreload-permission-error.png"),
        Buffer.from(image.data, "base64"),
      );
    }
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
    reloadServer?.stop(true);
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
