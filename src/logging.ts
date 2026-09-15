export type LogLevel = "error" | "warn" | "info" | "debug";
const weights: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export class Logger {
  constructor(private readonly level: LogLevel) {}
  log(level: LogLevel, message: string, details?: unknown): void {
    if (weights[level] > weights[this.level]) return;
    const suffix = details === undefined ? "" : ` ${safe(details)}`;
    process.stderr.write(`[java-lsp-mcp] ${level}: ${message}${suffix}\n`);
  }
  error(message: string, details?: unknown): void { this.log("error", message, details); }
  warn(message: string, details?: unknown): void { this.log("warn", message, details); }
  info(message: string, details?: unknown): void { this.log("info", message, details); }
  debug(message: string, details?: unknown): void { this.log("debug", message, details); }
}

function safe(value: unknown): string {
  try { return JSON.stringify(value); } catch { return "[unserializable]"; }
}
