import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("debug is lazy development-only and worker-only with no eval endpoint", async () => {
  const entry = await readFile(
    new URL("../../src/background/index.ts", import.meta.url),
    "utf8",
  );
  const debug = await readFile(
    new URL("../../src/debug/index.ts", import.meta.url),
    "utf8",
  );
  expect(entry).toContain("if (__DEV__)");
  expect(entry).toContain('import("../debug/index")');
  expect(debug).toContain('typeof document === "undefined"');
  expect(debug).not.toMatch(
    /\beval\s*\(|new Function|onMessageExternal|createServer/,
  );
});
