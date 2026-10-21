import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("App browser workflows, responsive layout and keyboard focus", async () => {
  if (!Bun.which("chromium"))
    throw new Error(
      "UI browser gate requires a real chromium executable on PATH. Install Chromium before running bun test tests/ui.",
    );
  const dir = await mkdtemp(join(tmpdir(), "proxy-ui-"));
  const bundle = await Bun.build({
    entrypoints: ["tests/ui/browser-entry.tsx"],
    outdir: dir,
    target: "browser",
    format: "esm",
  });
  expect(bundle.success).toBe(true);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith(".js") || path.endsWith(".css"))
        return new Response(Bun.file(join(dir, path.slice(1))));
      return new Response(
        '<!doctype html><html><head><link rel="stylesheet" href="/browser-entry.css"></head><body><div id="root"></div><script type="module" src="/browser-entry.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const chrome = Bun.spawn(
    [
      "chromium",
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-allow-origins=*",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9324",
      `--user-data-dir=${dir}/profile`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  let socket: WebSocket | undefined;
  try {
    let pages: { webSocketDebuggerUrl: string }[] = [];
    for (let i = 0; i < 80; i++) {
      try {
        pages = await (await fetch("http://127.0.0.1:9324/json")).json();
        if (pages.length) break;
      } catch {
        /* Chromium is starting. */
      }
      await Bun.sleep(100);
    }
    if (!pages[0]) throw new Error("Chromium CDP did not start");
    const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
    socket = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = reject;
    });
    let id = 0;
    const pending = new Map<
      number,
      (value: { result: { result: { value: unknown } } }) => void
    >();
    ws.onmessage = (event) => {
      const value = JSON.parse(String(event.data));
      pending.get(value.id)?.(value);
      pending.delete(value.id);
    };
    const cdp = (method: string, params: object = {}) =>
      new Promise<{ result: { result: { value: unknown } } }>((resolve) => {
        const current = ++id;
        pending.set(current, resolve);
        ws.send(JSON.stringify({ id: current, method, params }));
      });
    const evaluate = async (expression: string) =>
      (
        await cdp("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        })
      ).result?.result?.value;
    const wait = async (expression: string) => {
      for (let i = 0; i < 80; i++) {
        if (await evaluate(expression)) return;
        await Bun.sleep(50);
      }
      throw new Error(
        `Timed out: ${expression}; page: ${await evaluate("document.body.innerText")}`,
      );
    };
    const click = (text: string) =>
      evaluate(
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})?.click()`,
      );
    await cdp("Emulation.setDeviceMetricsOverride", {
      width: 384,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp("Page.navigate", { url: `${server.url}popup.html` });
    await wait("document.body.textContent.includes('Browser proxy')");
    expect(
      await evaluate("document.body.textContent.includes('Proxy on')"),
    ).toBe(true);
    expect(
      await evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).toBe(true);
    await wait(
      "!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Change global location')?.disabled",
    );
    await evaluate("document.querySelector('input[type=checkbox]').click()");
    await wait("document.querySelector('input[type=checkbox]').checked");
    await click("Change global location");
    await wait("!!document.querySelector('#server-search')");
    expect(
      await evaluate(
        "Array.from(document.querySelectorAll('.server-list button')).find(b => b.textContent.includes('Berlin')).disabled",
      ),
    ).toBe(true);
    await evaluate(
      `(()=>{const input=document.querySelector('#server-search');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'SWEDEN got');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await wait("document.querySelectorAll('.server-list li').length === 1");
    expect(
      await evaluate(
        "document.querySelector('.server-list').textContent.includes('Gothenburg')",
      ),
    ).toBe(true);
    await click("Close");
    await wait("!document.querySelector('#server-search')");
    await click("Use active website");
    await wait(
      "document.querySelector('[role=alert]')?.textContent.includes('denied')",
    );
    await cdp("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
    });
    expect(await evaluate("document.activeElement !== document.body")).toBe(
      true,
    );
    expect(
      await evaluate(
        "document.body.textContent.includes('PRIVATE_STATUS_NOT_INSPECTED')",
      ),
    ).toBe(false);
    expect(
      await evaluate(
        "document.body.textContent.includes('Effective private routing is not confirmed')",
      ),
    ).toBe(false);
    await cdp("Page.navigate", { url: `${server.url}options.html` });
    await wait(
      "document.body.textContent.includes('This regular page does not inspect or monitor private routing')",
    );
    expect(
      await evaluate("document.body.textContent.includes('Proxy on')"),
    ).toBe(true);
    expect(
      await evaluate(
        "document.body.textContent.includes('PRIVATE_STATUS_NOT_INSPECTED')",
      ),
    ).toBe(false);
    expect(
      await evaluate(
        "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Use active website')",
      ),
    ).toBe(false);
    await evaluate(
      "Array.from(document.querySelectorAll('label')).find(l=>l.textContent.includes('Reload the active website')).querySelector('input').click()",
    );
    await wait(
      "document.querySelector('[role=alert]')?.textContent.includes('denied tab access')",
    );
    expect(
      await evaluate(
        "Array.from(document.querySelectorAll('label')).find(l=>l.textContent.includes('Reload the active website')).querySelector('input').checked",
      ),
    ).toBe(false);
    await cdp("Page.navigate", { url: `${server.url}options.html?incognito` });
    await wait("document.body.textContent.includes('Incognito window')");
    await wait("document.body.textContent.includes('Browser proxy')");
    expect(
      await evaluate(
        "document.body.textContent.includes('Effective context: incognito')",
      ),
    ).toBe(true);
    expect(
      await evaluate(
        "document.body.textContent.includes('Inherited regular routing')",
      ),
    ).toBe(true);
    await evaluate("document.querySelector('input[type=checkbox]').click()");
    await wait(
      "document.body.textContent.includes('Private-session routing override')",
    );
    expect(
      await evaluate(
        "document.body.textContent.includes('last Incognito window closes')",
      ),
    ).toBe(true);
    await click("Import / export");
    await wait("!!document.querySelector('#import-json')");
    expect(
      await evaluate("document.body.textContent.includes('upstream Firefox')"),
    ).toBe(true);
    await evaluate(
      `(()=>{const input=document.querySelector('#import-json');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'{}');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await click("Validate import");
    await wait(
      "document.querySelector('[role=alert]')?.textContent.includes('proxyDNS=false')",
    );
    expect(
      await evaluate(
        "document.body.textContent.includes('Confirm replacement')",
      ),
    ).toBe(false);
    await evaluate(
      `(()=>{const input=document.querySelector('#import-json');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'{"compatible":true}');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await click("Validate import");
    await wait("document.body.textContent.includes('Confirm replacement')");
    expect(
      await evaluate("document.documentElement.dataset.imported"),
    ).toBeUndefined();
    await evaluate("window.confirm = () => false");
    await click("Confirm replacement");
    expect(
      await evaluate("document.documentElement.dataset.imported"),
    ).toBeUndefined();
    await evaluate("window.confirm = () => true");
    await click("Confirm replacement");
    await wait("document.documentElement.dataset.imported === 'true'");
    expect(
      await evaluate(
        "document.body.textContent.includes('Confirm replacement')",
      ),
    ).toBe(false);
    for (const width of [360, 800]) {
      await cdp("Emulation.setDeviceMetricsOverride", {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      expect(
        await evaluate("document.documentElement.scrollWidth <= innerWidth"),
      ).toBe(true);
    }
    await cdp("Page.navigate", { url: `${server.url}popup.html?incognito` });
    await wait("document.body.textContent.includes('Run checks')");
    await click("Run checks");
    await wait(
      "document.querySelector('[role=alert]')?.textContent.includes('private-route fetch')",
    );
    expect(
      await evaluate(
        "document.body.textContent.includes('No regular observations were returned')",
      ),
    ).toBe(true);
    await cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    expect(
      await evaluate(
        "getComputedStyle(document.querySelector('button')).transitionDuration",
      ),
    ).toBe("0s");
  } finally {
    socket?.close();
    chrome.kill();
    await chrome.exited;
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
