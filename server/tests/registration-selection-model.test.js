import assert from "node:assert/strict";
import test from "node:test";
import { toggleSelectedIds } from "../../src/pages/registration/registration-model.js";

test("selection scope adds missing ids without dropping existing selections", () => {
  assert.deepEqual(toggleSelectedIds([1, 4], [1, 2, 3]), [1, 4, 2, 3]);
});

test("selection scope removes only that scope when every id is selected", () => {
  assert.deepEqual(toggleSelectedIds([1, 2, 3, 4], [1, 2, 3]), [4]);
});

test("empty selection scope leaves the current selection unchanged", () => {
  assert.deepEqual(toggleSelectedIds([1, 2], []), [1, 2]);
});
