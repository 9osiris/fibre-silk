import { test } from "node:test";
import assert from "node:assert/strict";
import { average } from "../src/average.js";

test("average of [2, 4] is 3", () => {
  assert.equal(average([2, 4]), 3);
});

test("average of a single element", () => {
  assert.equal(average([10]), 10);
});

test("empty list throws", () => {
  assert.throws(() => average([]));
});
