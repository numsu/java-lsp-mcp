# Security

Report vulnerabilities privately through the repository host's security advisory feature. Do not include secrets or private source in public reports.

All tool paths are canonicalized beneath the fixed startup workspace and existing symlink targets are checked. Semantic edit previews reject dependency/external locations and never call `workspace/applyEdit`. Runtime downloads are versioned and SHA-256 verified. MCP stdout is protocol-only.

Treat `--trust-workspace` as permission for JDT's Maven/Gradle importers to run repository-controlled build logic. The default disables build import. Dependency archives and JDT itself remain complex parsers; use supported pinned versions and review SBOM/notices when updating.
