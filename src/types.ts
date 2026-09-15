export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface PublicLocation {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  origin: "workspace" | "dependency";
  editable: boolean;
}

export interface Snapshot {
  path: string;
  uri: string;
  content: string;
  hash: string;
  version: number;
  mtimeMs: number;
  syncedAt?: number;
}

export interface PositionTarget { path: string; line: number; column: number }
export interface QualifiedTarget { qualifiedName: string }
export type SymbolTarget = PositionTarget | QualifiedTarget;

export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspLocation { uri: string; range: LspRange }

export class JavaLspMcpError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: Json) {
    super(message);
    this.name = "JavaLspMcpError";
  }
}
