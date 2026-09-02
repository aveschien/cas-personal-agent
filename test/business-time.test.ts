import assert from "node:assert/strict";
import test from "node:test";

import {
  businessTimeZone,
  formatBusinessLocalDateTime,
  normalizeBusinessTimestamp,
} from "../src/business-time.js";

test("business time is always interpreted and emitted in Beijing time", () => {
  assert.equal(businessTimeZone, "Asia/Shanghai");
  assert.equal(
    formatBusinessLocalDateTime("2026-09-02T18:10:00.000Z"),
    "2026-09-03 02:10:00",
  );
  assert.equal(
    normalizeBusinessTimestamp("2026-09-02T16:00:00Z", "deadlineAt"),
    "2026-09-03T00:00:00+08:00",
  );
  assert.equal(
    normalizeBusinessTimestamp(
      "2026-09-02T09:00:00-07:00",
      "checkpointAt",
    ),
    "2026-09-03T00:00:00+08:00",
  );
});
