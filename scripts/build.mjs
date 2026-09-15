import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
await build({ entryPoints: ["src/index.ts"], outfile: "dist/server.mjs", bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: true, banner: { js: "#!/usr/bin/env node\nimport { createRequire as __javaLspMcpCreateRequire } from 'node:module'; const require = __javaLspMcpCreateRequire(import.meta.url);" } });
await mkdir("dist/runtime/debug", { recursive: true });
await cp("java-debug-bridge/DebugBridge.java", "dist/runtime/debug/DebugBridge.java");
