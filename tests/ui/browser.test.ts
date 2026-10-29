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
    await wait("document.body.textContent.includes('Proxy routing')");
    expect(
      await evaluate("document.body.textContent.includes('Proxy on')"),
    ).toBe(true);
    expect(
      await evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).toBe(true);
    await wait(
      "!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Change global location')?.disabled",
    );
    // Opening the popup runs the connection checks and reads the current website.
    await wait(
      "document.querySelector('.checks')?.textContent.includes('198.51.100.24')",
    );
    await wait(
      "document.querySelector('.hostname')?.textContent === 'news.example.org'",
    );
    expect(
      await evaluate(
        "document.body.textContent.includes('Connects directly. Choose a location to proxy only this website.')",
      ),
    ).toBe(true);
    expect(
      await evaluate(
        "Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Use active website')",
      ),
    ).toBe(false);
    expect(await evaluate("!!document.querySelector('footer')")).toBe(false);
    // Details live inline; there are no disclosures to reset or a separate refresh button.
    expect(await evaluate("!!document.querySelector('details')")).toBe(false);
    expect(
      await evaluate(
        "Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Refresh status')",
      ),
    ).toBe(false);
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
    await evaluate("document.querySelector('.server-list .star').click()");
    await wait(
      "document.querySelector('.server-list .star')?.getAttribute('aria-pressed') === 'true'",
    );
    await evaluate(
      `(()=>{const input=document.querySelector('#server-search');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    // An empty search shows favorites above the full list.
    await wait(
      "document.querySelector('.server-list .country')?.textContent === 'Favorites'",
    );
    expect(
      await evaluate(
        "document.querySelector('.server-list li').textContent.includes('Gothenburg, Sweden')",
      ),
    ).toBe(true);
    await click("Close");
    await wait("!document.querySelector('#server-search')");
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
      await evaluate("document.body.textContent.includes('Incognito routing')"),
    ).toBe(false);
    expect(
      await evaluate(
        'document.body.textContent.includes("couldn\'t get through")',
      ),
    ).toBe(false);
    // A failed check explains what to do instead of leaving a silent red pill.
    await cdp("Page.navigate", { url: `${server.url}popup.html?offline` });
    await wait(
      "document.querySelector('.notice')?.textContent === \"The connection check failed. Make sure you're online and Mullvad VPN is connected.\"",
    );
    // Local addresses connect directly even in random mode, as in the PAC.
    await cdp("Page.navigate", { url: `${server.url}popup.html?local` });
    await wait(
      "document.body.textContent.includes('Local address. It always connects directly.')",
    );
    // A favorite that left the server list keeps its star so it can be removed.
    await cdp("Page.navigate", { url: `${server.url}popup.html?retired` });
    // A disabled fieldset disables its buttons without setting their disabled property.
    await wait(
      "Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Change global location' && !b.matches(':disabled'))",
    );
    await click("Change global location");
    await wait(
      "document.querySelector('.server-list li')?.textContent.includes('No longer listed')",
    );
    await evaluate("document.querySelector('.server-list .star').click()");
    await wait(
      "!document.querySelector('.server-list').textContent.includes('No longer listed')",
    );
    await cdp("Page.navigate", { url: `${server.url}options.html` });
    await wait("document.body.textContent.includes('Website rules')");
    // Typed URLs fail inline, before any command reaches the worker.
    await evaluate(
      `(()=>{const input=document.querySelector('#website-domain');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'https://example.com/path');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await wait(
      "document.querySelector('.field-error')?.textContent.startsWith('Enter a domain such as example.com')",
    );
    expect(
      await evaluate(
        "Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Choose site location').disabled",
      ),
    ).toBe(true);
    await evaluate(
      `(()=>{const input=document.querySelector('#website-domain');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'example.com');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await wait("!document.querySelector('.field-error')");
    expect(
      await evaluate(
        "Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Choose site location').disabled",
      ),
    ).toBe(false);
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
    // Reloading needs no permission prompt: the popup click grants access to that tab.
    await evaluate(
      "Array.from(document.querySelectorAll('label')).find(l=>l.textContent.includes('Reload the current website')).querySelector('input').click()",
    );
    await wait(
      "Array.from(document.querySelectorAll('label')).find(l=>l.textContent.includes('Reload the current website')).querySelector('input').checked",
    );
    expect(await evaluate("!!document.querySelector('[role=alert]')")).toBe(
      false,
    );
    // A declined privacy permission leaves the switch off and says why.
    await click("Privacy");
    await evaluate(
      "Array.from(document.querySelectorAll('label')).find(l=>l.textContent.includes('Stop WebRTC')).querySelector('input').click()",
    );
    await wait(
      "document.querySelector('[role=alert]')?.textContent.includes(\"didn't grant the privacy permission\")",
    );
    expect(
      await evaluate(
        "Array.from(document.querySelectorAll('label')).find(l=>l.textContent.includes('Stop WebRTC')).querySelector('input').checked",
      ),
    ).toBe(false);
    await cdp("Page.navigate", { url: `${server.url}options.html?incognito` });
    await wait("document.body.textContent.includes('Incognito window')");
    await wait("document.body.textContent.includes('Browser proxy')");
    expect(
      await evaluate(
        "document.body.textContent.includes('Incognito uses your regular routing')",
      ),
    ).toBe(true);
    await evaluate("document.querySelector('input[type=checkbox]').click()");
    await wait(
      "document.body.textContent.includes('Incognito uses its own routing until you close the last Incognito window')",
    );
    await click("Import / export");
    await wait("!!document.querySelector('#import-json')");
    expect(
      await evaluate(
        'document.body.textContent.includes("Mullvad\'s Firefox extension")',
      ),
    ).toBe(true);
    await evaluate(
      `(()=>{const input=document.querySelector('#import-json');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'{}');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await click("Validate import");
    await wait(
      "document.querySelector('[role=alert]')?.textContent.includes('Turn on proxy DNS')",
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
    // A spanning worker cannot run checks on the private route, so private popups never start them.
    await wait(
      "document.body.textContent.includes('Checks only run in regular windows')",
    );
    expect(
      await evaluate(
        "Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Open mullvad.net/check')",
      ),
    ).toBe(true);
    expect(
      await evaluate(
        "Array.from(document.querySelectorAll('.pill')).map(pill => pill.firstChild.nextSibling.textContent).join()",
      ),
    ).toBe("Proxy");
    expect(
      await evaluate(
        "Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Check again')",
      ),
    ).toBe(false);
    await wait(
      "document.querySelector('.hostname')?.textContent === 'news.example.org'",
    );
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
