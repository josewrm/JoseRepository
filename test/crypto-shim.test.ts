import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex } from "../src/browser/crypto-shim.ts";

test("browser sha256 matches node:crypto (event hashes stay identical across builds)", () => {
  for (const input of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "é ü 中文 🚀", JSON.stringify({ x: 1, y: "Valencia" }).repeat(40)]) {
    assert.equal(sha256Hex(input), createHash("sha256").update(input).digest("hex"), input.slice(0, 20));
  }
});
