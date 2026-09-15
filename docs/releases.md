# Release process

Archives target Windows, macOS, and Linux on x64 and arm64. Build with `npm run build-release -- --platform linux-x64`. Names are versionless for stable configuration paths.

Pinned versions: MCP `2026-07-28`, server SDK `2.0.0`, Node `24.19.0`, JDT LS `1.60.0-202606262232`, JUnit `1.14.4`, JaCoCo `0.8.15`, and conformance runner `0.2.0-alpha.11`. URLs, licenses, and SHA-256 hashes are in `runtime/versions.lock.json`.

Updates require authoritative hashes, runtime fetch, builds, unit/protocol/integration tests, SBOM generation, every platform target, and sanitized-PATH smoke tests. The conformance runner's full suite assumes capabilities this tools-only server does not advertise; run only applicable scenarios. See [Contributing](../CONTRIBUTING.md).
