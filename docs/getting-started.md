# Getting started

`java-lsp-mcp` exposes JDT and ECJ over MCP stdio, keeps logs on stderr, and returns edit previews instead of modifying Java files. It supports MCP `2026-07-28` and the `2025-11-25` compatibility handshake.

Release archives bundle the app, Node.js, JDT LS, JUnit, and JaCoCo, but not a JDK. Set `JAVA_HOME` or `--tooling-jdk`. Archives target Windows, macOS, and Linux on x64 and arm64.

Build from source with `npm ci`, `npm run fetch-runtime`, and `npm run check`. Use `bin/java-lsp-mcp` or Windows `bin\java-lsp-mcp.cmd`.

## MCP configuration

```yaml
command: /absolute/path/to/java-lsp-mcp/bin/java-lsp-mcp
args:
  - serve
  - --workspace
  - /absolute/path/to/project
  - --trust-workspace
```

Generate this with `java-lsp-mcp print-config generic --workspace /project --trust-workspace`, and check setup with `doctor`.

Maven/Gradle import can execute repository logic. Without trust, build import is disabled; tests also require trust. All tools share a 120-second readiness gate, so no startup sleep is needed. Observe it with `java_status` and `{"waitForReady":true}`.
