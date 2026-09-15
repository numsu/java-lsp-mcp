# Configuration

Precedence: CLI, `JAVA_LSP_MCP_*` environment, `java-lsp-mcp.json`/`java-lsp-mcp.toml`, defaults. `--workspace` is required.

Commands are `serve`, `doctor`, `version`, `describe-tools`, `print-config`, and `clear-cache`. Options include `--offline`, `--trust-workspace`, `--max-heap` (default `2g`), `--tooling-jdk`, `--jdtls-home`, `--project-jdk`, `--source-encoding`, `--result-mode`, `--result-budget` (default 12000), `--log-level`, and `--timeout` (default 120000).

Environment names add the `JAVA_LSP_MCP_` prefix, for example `JAVA_LSP_MCP_TOOLING_JDK` and `JAVA_LSP_MCP_TIMEOUT_MS`. Tooling-JDK selection falls back to `JAVA_HOME`; project JDK selection is separate.

Repeat `--exclude-project` to remove exact matching projects from import, indexing, compilation, tests, and semantic tools. Repeat `--test-classpath-entry` to append test runtime paths; these do not affect ECJ compilation.

Sources default to strict UTF-8 and honor Eclipse resource encodings. An override selects a separate cache. JDT state lives in the platform cache under `java-lsp-mcp/workspaces/<hash>`. Offline mode prevents runtime downloads; project dependency resolution remains separate.
