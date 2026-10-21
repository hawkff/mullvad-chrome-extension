import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const development = process.argv.includes("--development");
const outdir = resolve("dist", development ? "development" : "production");
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp("public", outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: ["src/background/index.ts", "src/ui/index.tsx"],
  root: "src",
  outdir,
  target: "browser",
  format: "esm",
  // Extension service workers cannot load modules with dynamic import().
  splitting: false,
  minify: !development,
  sourcemap: development ? "external" : "none",
  define: {
    __DEV__: JSON.stringify(development),
    "process.env.NODE_ENV": JSON.stringify(
      development ? "development" : "production",
    ),
  },
  metafile: true,
});
if (!result.success)
  throw new AggregateError(result.logs, "Extension build failed");
if (!result.metafile) throw new Error("Missing build metadata");
if (
  !development &&
  Object.keys(result.metafile.inputs).some((path) => path.includes("/debug/"))
) {
  throw new Error("Production bundle includes debug modules");
}
console.log(`Built ${development ? "development" : "production"} extension`);
