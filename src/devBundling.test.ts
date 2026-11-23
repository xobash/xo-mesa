// @vitest-environment node
import { transform } from "esbuild";
import { expect, it } from "vitest";

// The dev server pre-bundles dependencies with esbuild. With esbuild's default
// dev target it rejected the Word engine's top-level await, so `npm run mesa`
// stopped before the window opened while the production build still passed.
// The config sits outside the `src` project, so it is loaded at run time.
const CONFIG_PATH = "../vite.config";

it("pre-bundles dependencies for the same webview floor as the production build", async () => {
  const { default: resolved } = (await import(/* @vite-ignore */ CONFIG_PATH)) as {
    default: { optimizeDeps?: { esbuildOptions?: { target?: unknown } }; build?: { target?: unknown } };
  };
  const devTarget = resolved.optimizeDeps?.esbuildOptions?.target;
  expect(devTarget).toEqual(resolved.build?.target);
  const out = await transform("const ready = await Promise.resolve(1); export { ready };", {
    format: "esm",
    target: devTarget as string[],
  });
  expect(out.code).toContain("await");
});
