export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface Location { uri: string; range: Range }
export interface Diagnostic { range: Range; severity?: number; code?: string | number; message: string; source?: string; tags?: number[]; relatedInformation?: { location: Location; message: string }[] }
export interface SymbolInformation { name: string; kind: number; location: Location; containerName?: string }
export interface DocumentSymbol { name: string; detail?: string; kind: number; range: Range; selectionRange: Range; children?: DocumentSymbol[]; tags?: number[] }
export interface TextDocumentEdit { textDocument: { uri: string; version?: number }; edits: TextEdit[] }
export interface ResourceOperation { kind: "create" | "rename" | "delete"; uri?: string; oldUri?: string; newUri?: string }
export interface WorkspaceEdit { changes?: Record<string, TextEdit[]>; documentChanges?: Array<TextDocumentEdit | ResourceOperation> }
export interface TextEdit { range: Range; newText: string }
export interface CodeAction { title: string; kind?: string; diagnostics?: Diagnostic[]; isPreferred?: boolean; edit?: WorkspaceEdit; command?: { title: string; command: string; arguments?: unknown[] }; data?: unknown }
export interface HierarchyItem { name: string; kind: number; uri: string; range: Range; selectionRange: Range; detail?: string; data?: unknown }
export interface CallEdge { from?: HierarchyItem; to?: HierarchyItem; fromRanges?: Range[] }
export interface TypeEdge extends HierarchyItem {}
export interface DocumentHighlight { range: Range; kind?: 1 | 2 | 3 }
