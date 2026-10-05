import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";

export interface InputWarning {
  code: "INPUT_CLAMPED";
  path: string;
  requested: number;
  applied: number;
  message: string;
}

type Schema = {
  "x-clamp"?: [number, number];
  "x-cap"?: number;
  "x-range"?: boolean;
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
};
const schemas = new WeakMap<z.ZodType, Schema>();
const warningScope = new AsyncLocalStorage<InputWarning[]>();

export function withInputWarnings<T>(warnings: InputWarning[], run: () => T): T {
  return warningScope.run(warnings, run);
}

export function clampSourceValue(path: string, requested: number, min: number, max: number): number {
  const applied = Math.max(min, Math.min(max, Math.trunc(requested)));
  if (applied !== requested) warningScope.getStore()?.push({ code: "INPUT_CLAMPED", path, requested, applied, message: `${path}: clamped ${requested} to ${applied}` });
  return applied;
}

/** Preserve the raw values through SDK validation; normalize before service dispatch. */
export function normalizeInput(schema: z.ZodType, input: unknown): { input: unknown; warnings: InputWarning[] } {
  let json = schemas.get(schema);
  if (!json) {
    json = z.toJSONSchema(schema, { io: "input" }) as Schema;
    schemas.set(schema, json);
  }
  const warnings: InputWarning[] = [];
  const warn = (path: string, requested: number, applied: number, array = false): void => {
    warnings.push({ code: "INPUT_CLAMPED", path, requested, applied,
      message: array ? `${path}: kept ${applied} of ${requested} entries; omitted ${requested - applied}` : `${path}: clamped ${requested} to ${applied}` });
  };
  const visit = (value: unknown, rule: Schema, path: string): unknown => {
    if (typeof value === "number" && Number.isFinite(value) && rule["x-clamp"]) {
      const [min, max] = rule["x-clamp"];
      const applied = Math.max(min, Math.min(max, Math.trunc(value)));
      if (applied !== value) warn(path, value, applied);
      return applied;
    }
    if (Array.isArray(value)) {
      const cap = rule["x-cap"];
      if (cap !== undefined && value.length > cap) {
        warn(path, value.length, cap, true);
        value = value.slice(0, cap);
      }
      return (value as unknown[]).map((item, index) => rule.items ? visit(item, rule.items, `${path}[${index}]`) : item);
    }
    if (value && typeof value === "object") {
      const result = { ...value } as Record<string, unknown>;
      for (const [key, child] of Object.entries(rule.properties ?? {})) {
        if (key in result) result[key] = visit(result[key], child, path ? `${path}.${key}` : key);
      }
      if (rule["x-range"] && ["line", "column", "endLine", "endColumn"].every(key => typeof result[key] === "number")) {
        const { line, column, endLine, endColumn } = result as Record<string, number>;
        if (endLine! < line! || endLine === line && endColumn! < column!) {
          if (endLine !== line) warn(`${path}.endLine`, endLine!, line!);
          if (endColumn !== column) warn(`${path}.endColumn`, endColumn!, column!);
          result.endLine = line; result.endColumn = column;
        }
      }
      let normalized: unknown = result;
      for (const branch of [...(rule.oneOf ?? []), ...(rule.anyOf ?? []), ...(rule.allOf ?? [])]) normalized = visit(normalized, branch, path);
      return normalized;
    }
    return value;
  };
  return { input: visit(input, json, ""), warnings };
}
