# java-lsp-mcp

Give your coding agent a better understanding of Java code.

`java-lsp-mcp` is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects AI coding tools to Eclipse's Java language tooling. It helps agents navigate a project, check changes, run tests, and investigate problems using the same understanding of Java that powers Eclipse.

It works with Maven, Gradle, Eclipse, modular Java, and unmanaged projects.

## What it can do

- **Explore code:** find symbols, definitions, references, callers, implementations, and type relationships.
- **Check changes:** report compiler diagnostics and compile projects with Eclipse's Java compiler (ECJ).
- **Run tests:** execute selected JUnit tests, collect coverage, and find tests that may be affected by a change. Tests compile automatically before running.
- **Review improvements:** identify potentially unused private members and preview fixes, renames, formatting, and import changes.
- **Debug Java:** set breakpoints, inspect threads and variables, step through execution, and replace supported code changes in a running JVM.

Source changes are returned as previews for your coding tool to apply. The server does not edit your source files itself. Compilation and tests can produce build output and execute project code.

## Getting started

### 1. Install the prerequisites

You'll need:

- **Node.js 24 or later**, available on your `PATH`.
- **A JDK**, with `JAVA_HOME` pointing to its installation directory. You can also select it with `--tooling-jdk`.
- **A Java project** and an MCP-compatible coding client.

### 2. Download a release

Download the archive for your operating system from [GitHub Releases](https://github.com/numsu/java-lsp-mcp/releases) and extract it. Releases include the Java language server, test runner, and coverage tooling; Node.js and the JDK are installed separately.

From the extracted directory, check your setup:

```sh
./bin/java-lsp-mcp doctor --workspace /absolute/path/to/project
```

On Windows, use the Windows launcher:

```powershell
.\bin\java-lsp-mcp.cmd doctor --workspace C:\dev\my-project
```

### 3. Connect your coding client

For VS Code, create `.vscode/mcp.json` in your Java project:

```json
{
  "servers": {
    "java-lsp-mcp": {
      "command": "/absolute/path/to/java-lsp-mcp/bin/java-lsp-mcp",
      "args": [
        "serve",
        "--workspace", "/absolute/path/to/project",
        "--trust-workspace"
      ]
    }
  }
}
```

Replace both paths with your own absolute paths. On Windows, set `command` to the extracted `bin/java-lsp-mcp.cmd` launcher; forward slashes work in the JSON paths.

For other clients, add a local MCP server using the same command and arguments. From the extracted directory, you can print those settings with:

```sh
./bin/java-lsp-mcp print-config generic --workspace /absolute/path/to/project --trust-workspace
```

Your client starts the server and communicates with it over standard input and output. You can also launch it manually with the same arguments:

```sh
./bin/java-lsp-mcp serve --workspace /absolute/path/to/project --trust-workspace
```

Use `--trust-workspace` only for projects you trust: importing Maven or Gradle projects, compiling, and running tests can execute project-controlled code. Without this flag, build import is disabled. See [SECURITY.md](SECURITY.md) for more information.

## Using it

Once connected, ask your agent to do things like:

- "Find the callers of this method and explain how the request flows through them."
- "Check this change for compiler errors and run the relevant tests."
- "Show me a preview of renaming this class and updating its references."
- "Find private members that might be unused."
- "Debug this failing test and inspect the values at the breakpoint."

The first project import may take a little time. `java_status` reports readiness and startup problems.

Related lookups can be batched in one request, and tests and unused-code analysis can cover multiple files. Numeric limits clamp to supported values and oversized batches are capped, with warnings in the response. For client developers, print the shared agent guidance and detailed tool inputs with:

```sh
./bin/java-lsp-mcp describe-tools
```

Compilation and selected tests are useful for quick feedback. Keep using your project's Maven or Gradle commands when you need its full build lifecycle, code generation, packaging, or integration-test setup. Affected-test and unused-code results are candidates for review.

## Configuration

Most projects only need `--workspace` and `--trust-workspace`. These options cover common setups:

| Option | When to use it |
| --- | --- |
| `--tooling-jdk /path/to/jdk` | Choose the JDK for the language server instead of `JAVA_HOME`. |
| `--project-jdk /path/to/jdk` | Use a different JDK to run your tests. |
| `--offline` | Use cached dependencies without network access. |
| `--exclude-project module-name` | Leave a module out of import, compilation, and tests. Repeat for additional modules. |
| `--source-encoding encoding` | Specify an encoding for legacy source files. Otherwise, Eclipse settings and automatic UTF-8/Windows-1252 detection apply. |
| `--test-classpath-entry /path/to/resources` | Add resources or a JAR needed by your tests. Repeat for additional entries. |

You can also keep settings in `java-lsp-mcp.json` or `java-lsp-mcp.toml` in the workspace, or use `JAVA_LSP_MCP_*` environment variables. Command-line options take precedence over environment variables, which take precedence over the configuration file.

Run `./bin/java-lsp-mcp help` for the full command list and options.

## Troubleshooting

Start with `doctor` to check the workspace, Node.js, JDK, and bundled language server. If your client cannot start the server, check its launcher path and whether Node.js is available to that client.

If dependencies or test sources are missing, check that the project is trusted and that its Maven or Gradle setup works locally. After changing a build file, ask the agent to refresh project configuration with `java_update_projects`.

If the project index appears stale, stop the server, clear the workspace cache, and restart it:

```sh
./bin/java-lsp-mcp clear-cache --workspace /absolute/path/to/project --trust-workspace
```

Use the same workspace and configuration options as your server. Diagnostic logs go to standard error and are usually available in your client's MCP output panel.

## Contributing

Bug reports, documentation improvements, and pull requests are welcome. For bug reports, include your operating system, Node.js and JDK versions, client, and a small reproduction where possible. Remove secrets and private source from logs before sharing them.

To work on the server, clone this repository, set `JAVA_HOME`, and run:

```sh
npm ci
npm run fetch-runtime
npm run check
```

Start your local build against a Java project with:

```sh
node bin/java-lsp-mcp.js serve --workspace /absolute/path/to/project --trust-workspace
```

`npm run check` builds the server and runs unit and protocol tests. Run `npm run test:integration` for runtime integration tests; these require the JDK and downloaded runtime components.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution requirements and release checks. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
