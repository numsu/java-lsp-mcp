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

test("snapshot identities are signed and survive continuation cursors", () => {
  const signer = new CursorSigner(Buffer.alloc(32, 7), 100);
  const cursor = signer.sign("query", 2, 1, 1000, "result-snapshot");
  assert.deepEqual(signer.verifyPage(cursor, "query", 1, 1001), { offset: 2, snapshotId: "result-snapshot" });
  assert.equal(signer.verify(cursor, "query", 1, 1001), 2);
  const [body, mac] = cursor.split(".");
  const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as { s: string };
  payload.s = "another-snapshot";
  assert.throws(() => signer.verifyPage(Buffer.from(JSON.stringify(payload)).toString("base64url") + "." + mac, "query", 1, 1001), /signature/u);
});
