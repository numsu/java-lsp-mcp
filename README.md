# java-lsp-mcp

Java semantic intelligence for Model Context Protocol (MCP) clients, powered by Eclipse JDT Language Server and ECJ.

`java-lsp-mcp` gives coding agents semantic navigation, diagnostics, compilation, tests, and refactoring previews. It never edits source files: changes are returned as hash-bound edits and optional diffs for the client to apply.

## Features

- Workspace and dependency navigation
- Maven, Gradle, Eclipse, modular, and unmanaged projects
- Current-snapshot diagnostics and ECJ compilation
- Parallel JUnit tests, suspended JDWP test launches, affected-test discovery, and JaCoCo coverage
- Read-only fixes, refactorings, import, and formatting previews
- Bounded, paginated agent-friendly results

## Prerequisites

- **Node.js 24+** — the server runs on your Node; release launchers use `node` from `PATH`.
- **A JDK** — pointed to by `JAVA_HOME` or `--tooling-jdk`. It runs JDT LS and your tests.
- **A Java workspace** — Maven, Gradle, Eclipse, modular, or unmanaged.

Release archives bundle JDT LS, JUnit, and JaCoCo. Everything else comes from the prerequisites above.

## Installation

Download the archive for your platform from the [releases page](https://github.com/numsu/java-lsp-mcp/releases), unpack it, and run:

```sh
java-lsp-mcp/bin/java-lsp-mcp serve --workspace /absolute/path/to/project --trust-workspace
```

On Windows use `bin\java-lsp-mcp.cmd`. Then verify with `java-lsp-mcp doctor --workspace /project`.

To use it in VS Code, add the launcher to `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "java-lsp-mcp": {
      "command": "/absolute/path/to/java-lsp-mcp/bin/java-lsp-mcp",
      "args": ["serve", "--workspace", "/absolute/path/to/project", "--trust-workspace"]
    }
  }
}
```

`java-lsp-mcp print-config generic --workspace /project --trust-workspace` prints the equivalent snippet for other clients.

## Configuration

Flags for `serve` (a `java-lsp-mcp.json` or `java-lsp-mcp.toml` file in the workspace and `JAVA_LSP_MCP_*` environment variables work too; flags win, then env, then the file):

| Flag | What it does |
|---|---|
| `--workspace` | The project to work on (absolute path, required). |
| `--trust-workspace` | Allow Maven/Gradle import, compilation, and test execution. Without it the server only reads code — review the project first. |
| `--tooling-jdk` | JDK that runs JDT LS (defaults to `JAVA_HOME`). |
| `--project-jdk` | JDK that runs your tests (defaults to the tooling JDK). |
| `--offline` | Never touch the network; Maven/Gradle resolve from caches only. |
| `--exclude-project` | Leave a module out of import, compilation, and tests (repeatable). |
| `--test-classpath-entry` | Extra directory or jar on the test runtime classpath (repeatable). |
| `--jdtls-home` | Use your own JDT Language Server instead of the bundled one. |
| `--source-encoding` | Override file-encoding detection when the project has no Eclipse settings. |
| `--timeout`, `--result-budget` | Shared operation timeout in ms and per-result output budget in bytes. |
| `--log-level`, `--max-heap`, `--result-mode` | Operational tuning; all logs go to stderr, never stdout. |

Other commands: `doctor` checks the setup, `version` prints versions, `describe-tools` prints the complete machine-readable tool schemas, `print-config` generates client configuration, and `clear-cache` wipes the workspace index.

## Tools

| Tool | Purpose |
|---|---|
| `java_status` | Readiness and runtime status |
| `java_outline` | Source declarations |
| `java_search_symbols` | Workspace and dependency symbols |
| `java_find_definition` | Symbol declarations |
| `java_find_references` | Semantic usages |
| `java_call_hierarchy` | Callers and callees; incoming callers default to production scope |
| `java_type_hierarchy` | Supertypes, subtypes, implementations |
| `java_diagnostics` | Current-snapshot diagnostics |
| `java_compile` | ECJ workspace compilation with automatic loaded-prerequisite recovery |
| `java_update_projects` | Maven/Gradle configuration re-sync into JDT (`force` for full reimport) |
| `java_run_tests` | JUnit execution or suspended JDWP debug launch (`debug: true`) |
| `java_find_affected_tests` | Statically connected tests |
| `java_find_unused_code` | Candidate unused private members |
| `java_code_actions` | Available fixes and refactorings |
| `java_edit_preview` | Rename, action, import, format previews |
| `java_debug_targets` | Discover local JVMs started with the JDWP agent |
| `java_debug_attach`, `java_debug_sessions`, `java_debug_detach` | JDWP debug-session lifecycle |
| `java_debug_set_breakpoints`, `java_debug_wait_for_stop` | Source breakpoints and bounded stop-event waits |
| `java_debug_threads`, `java_debug_stack_trace`, `java_debug_variables` | Filtered runtime thread/stack, local, collection, and object inspection |
| `java_debug_execute` | Continue and step over, into, or out |
| `java_debug_hot_swap` | ECJ/JDI Hot Code Replace with change and active-frame reporting |

Run `java-lsp-mcp describe-tools` for the complete machine-readable tool schemas.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

Build from source with:

```sh
npm ci
npm run fetch-runtime
npm run check
bin/java-lsp-mcp serve --workspace /absolute/path/to/project --trust-workspace
```

## Security

Review [SECURITY.md](SECURITY.md) before granting workspace trust. Report vulnerabilities privately.

## License

MIT. See [LICENSE](LICENSE).
