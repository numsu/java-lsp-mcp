import test from "node:test";
import assert from "node:assert/strict";
import { budgetItems, compact } from "../../src/results/budget.js";
test("budgets complete items and never truncates JSON", () => { const result = budgetItems(["aaaa", "bbbb", "cccc"], 25, items => ({ items })); assert.ok(result.items.length > 0); assert.doesNotThrow(() => JSON.parse(JSON.stringify({ items: result.items }))); assert.equal(result.items.length + result.omitted, 3); });
test("omits empty and null fields", () => assert.deepEqual(compact({ a: 1, b: null, c: [], d: "" }), { a: 1 }));
