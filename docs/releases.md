# Release process

Archives target Windows, macOS, and Linux on x64 and arm64. Build with `npm run build-release -- --platform linux-x64`. Names are versionless for stable configuration paths.

## Publishing a version

Push a tag `v<version>` where `<version>` matches the `version` field in `package.json` (the release workflow fails fast on a mismatch). The workflow builds every platform archive and publishes them, plus a CycloneDX SBOM, as a GitHub release named after the tag. Archive names stay versionless so editor configuration never changes; the version is carried by the release tag. A GitHub release that already exists is not overwritten—delete it and re-run by pushing the tag again.

Verify an archive on a matching platform with `npm run smoke-release -- --bundle artifacts/java-lsp-mcp-<platform>.<zip|tar.gz>`; it extracts the archive and runs the `version --json` launcher with a sanitized `PATH` that exposes only the system Node.js (plus `SystemRoot` on Windows).

Pinned versions: MCP `2026-07-28`, server SDK `2.0.0`, JDT LS `1.60.0-202606262232`, JUnit `1.14.4`, JaCoCo `0.8.15`, and conformance runner `0.2.0-alpha.11`. URLs, licenses, and SHA-256 hashes are in `runtime/versions.lock.json`. Node.js 24+ and a JDK are external prerequisites, not bundled runtimes.

Updates require authoritative hashes, runtime fetch, builds, unit/protocol/integration tests, SBOM generation, every platform target, and sanitized-PATH smoke tests. The conformance runner's full suite assumes capabilities this tools-only server does not advertise; run only applicable scenarios. See [Contributing](../CONTRIBUTING.md).
