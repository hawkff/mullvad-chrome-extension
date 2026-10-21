import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../../public/manifest.json";

test("manifest confines extension execution and network access", () => {
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.minimum_chrome_version).toBe("102");
  expect(manifest.incognito).toBe("spanning");
  expect(manifest.permissions).toEqual(["storage", "proxy"]);
  expect(manifest.optional_permissions).toEqual(["privacy", "tabs"]);
  expect(manifest.host_permissions).toEqual([
    "https://api.mullvad.net/*",
    "https://ipv4.am.i.mullvad.net/*",
    "https://ipv6.am.i.mullvad.net/*",
    "https://*.dnsleak.am.i.mullvad.net/*",
  ]);
  expect(manifest.content_security_policy.extension_pages).toBe(
    "script-src 'self'; object-src 'self'",
  );
  expect(manifest).not.toHaveProperty("externally_connectable");
  expect(manifest).not.toHaveProperty("content_scripts");
});

for (const development of [false, true]) {
  test(`${development ? "development" : "production"} bundle contains local entrypoints`, async () => {
    const process = Bun.spawn(
      ["bun", "scripts/build.ts", ...(development ? ["--development"] : [])],
      { stdout: "pipe", stderr: "pipe" },
    );
    const error = await new Response(process.stderr).text();
    expect(await process.exited, error).toBe(0);
    const directory = join("dist", development ? "development" : "production");
    const built = await Bun.file(join(directory, "manifest.json")).json();
    expect(built).toEqual(manifest);
    for (const file of [
      built.background.service_worker,
      built.action.default_popup,
      built.options_ui.page,
      "ui/index.js",
    ]) {
      expect(await Bun.file(join(directory, file)).exists()).toBe(true);
    }
    // Chrome refuses to load an extension whose declared icon file is missing.
    for (const [size, file] of [
      ...Object.entries(built.icons),
      ...Object.entries(built.action.default_icon),
    ]) {
      // A PNG header stores width and height as big-endian integers at bytes 16 and 20.
      const png = new DataView(
        await Bun.file(join(directory, String(file))).arrayBuffer(),
      );
      expect([png.getUint32(16), png.getUint32(20)]).toEqual([
        Number(size),
        Number(size),
      ]);
    }
    const worker = await Bun.file(
      join(directory, built.background.service_worker),
    ).text();
    expect(worker).not.toMatch(/\bimport\s*\(/);
    expect(worker.includes("mullvadDev")).toBe(development);
    if (!development) {
      expect([...new Bun.Glob("**/*.map").scanSync(directory)]).toEqual([]);
      expect([...new Bun.Glob("**/*debug*").scanSync(directory)]).toEqual([]);
    }
  });
}

test("production dead-code elimination excludes development-only modules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "extension-build-"));
  try {
    const entry = join(directory, "entry.ts");
    await Bun.write(
      entry,
      'if (__DEV__) { await import("./debug/not-present.ts"); } export const production = true;',
    );
    const result = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      define: { __DEV__: "false" },
      minify: true,
    });
    expect(result.success).toBe(true);
    expect(await result.outputs[0]?.text()).not.toContain("debug");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
