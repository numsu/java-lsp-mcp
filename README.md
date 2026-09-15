# java-lsp-mcp

Java semantic intelligence for Model Context Protocol (MCP) clients, powered by Eclipse JDT Language Server and ECJ.

`java-lsp-mcp` gives coding agents semantic navigation, diagnostics, compilation, tests, and refactoring previews. It never edits source files: changes are returned as hash-bound edits and optional diffs for the client to apply.

## Features

- Workspace and dependency navigation
- Maven, Gradle, Eclipse, modular, and unmanaged projects
- Current-snapshot diagnostics and ECJ compilation
- Parallel JUnit tests, affected-test discovery, and JaCoCo coverage
- Read-only fixes, refactorings, import, and formatting previews
- Bounded, paginated agent-friendly results

## Requirements

Release archives bundle Node.js and JDT LS; provide a JDK through `JAVA_HOME` or `--tooling-jdk`. Source builds require Node.js 24 and npm.

## Quick start

```sh
npm ci
npm run fetch-runtime
npm run check
bin/java-lsp-mcp serve --workspace /absolute/path/to/project --trust-workspace
```

On Windows use `bin\java-lsp-mcp.cmd`. Run `java-lsp-mcp doctor --workspace /project` to check setup. See [Getting started](docs/getting-started.md) for client configuration and trust guidance.

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
| `java_compile` | ECJ workspace compilation |
| `java_run_tests` | JUnit test execution |
| `java_find_affected_tests` | Statically connected tests |
| `java_find_unused_code` | Candidate unused private members |
| `java_code_actions` | Available fixes and refactorings |
| `java_edit_preview` | Rename, action, import, format previews |

See the [tool reference](docs/tools.md) or run `java-lsp-mcp describe-tools`.

## Documentation

- [Documentation index](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Tool reference](docs/tools.md)
- [Configuration](docs/configuration.md)
- [Workflows and testing](docs/workflows.md)
- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Releases](docs/releases.md)

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Review [SECURITY.md](SECURITY.md) before granting workspace trust. Report vulnerabilities privately.

## License

MIT. See [LICENSE](LICENSE).
