import test from "node:test";
import assert from "node:assert/strict";
import { TemporaryResultCache } from "../../src/results/temporary-cache.js";

test("cache bounds entry count and evicts the least recently used snapshot", () => {
  const cache = new TemporaryResultCache<string>(120_000, 2);
  try {
    cache.set("a", "A", "1"); cache.set("b", "B", "1");
    assert.equal(cache.get("a", "1"), "A");
    cache.set("c", "C", "1");
    assert.equal(cache.get("b", "1"), undefined);
    assert.equal(cache.get("a", "1"), "A"); assert.equal(cache.size, 2);
  } finally { cache.clear(); }
});

test("cache bounds retained serialized bytes and bypasses oversized results", () => {
  const cache = new TemporaryResultCache<string>(120_000, 32, 10);
  try {
    cache.set("a", "aaaa", "1"); cache.set("b", "bbbb", "1");
    assert.equal(cache.get("a", "1"), undefined); assert.equal(cache.byteSize, 6);
    assert.equal(cache.set("large", "x".repeat(11), "1"), false);
    assert.equal(cache.get("b", "1"), "bbbb"); assert.equal(cache.size, 1);
    cache.set("b", "b", "1"); assert.equal(cache.byteSize, 3);
  } finally { cache.clear(); }
});

test("expired snapshots are evicted without another request and reads do not extend lifetime", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const cache = new TemporaryResultCache<string>(100, 32);
  try {
    cache.set("a", "A", "1");
    t.mock.timers.tick(75); assert.equal(cache.get("a", "1"), "A");
    t.mock.timers.tick(25); assert.equal(cache.size, 0); assert.equal(cache.byteSize, 0);
    assert.equal(cache.get("a", "1"), undefined);
  } finally { cache.clear(); }
});

test("changing workspace/session context clears every retained result", () => {
  const cache = new TemporaryResultCache<string>();
  try {
    cache.set("a", "A", "1:1"); cache.set("b", "B", "1:1");
    assert.equal(cache.get("a", "2:1"), undefined); assert.equal(cache.size, 0);
    cache.set("c", "C", "2:1"); assert.equal(cache.get("c", "2:2"), undefined); assert.equal(cache.byteSize, 0);
  } finally { cache.clear(); }
});
