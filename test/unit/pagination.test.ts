import test from "node:test";
import assert from "node:assert/strict";
import { CursorSigner, fingerprint } from "../../src/results/pagination.js";

test("signs and validates cursors", () => {
  const signer = new CursorSigner(Buffer.alloc(32, 7), 100); const q = fingerprint({ q: "A" }); const cursor = signer.sign(q, 50, 3, 1000);
  assert.equal(signer.verify(cursor, q, 3, 1050), 50);
  assert.throws(() => signer.verify(cursor, fingerprint({ q: "B" }), 3, 1050), /different query/u);
  assert.throws(() => signer.verify(cursor, q, 4, 1050), /index changed/u);
  assert.throws(() => signer.verify(cursor, q, 3, 1101), /expired/u);
  assert.throws(() => signer.verify(`${cursor}x`, q, 3, 1050), /signature/u);
});
