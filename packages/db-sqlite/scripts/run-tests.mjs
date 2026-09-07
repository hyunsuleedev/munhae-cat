import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The desktop package rebuilds better-sqlite3 for Electron. Run database tests with
// that same embedded Node ABI so `pnpm test` does not flip the native binding back
// and forth between the system Node and the application runtime.
const desktopRequire = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
const electronPath = desktopRequire("electron");
const vitestPath = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const result = spawnSync(electronPath, [vitestPath, "run", ...process.argv.slice(2)], {
  cwd: packageRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
