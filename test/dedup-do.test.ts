import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect } from "vitest";

import { DedupDO } from "../src/dedup-do";

// Each test uses a unique DO name to avoid cross-test state interference.
// DO instances persist within a single test run; unique names guarantee isolation.
describe("DedupDO (real runtime via @cloudflare/vitest-pool-workers)", () => {
  describe("trySend — atomic check-and-mark", () => {
    it("first call for a key returns action='send'", async () => {
      const id = env.DEDUP.idFromName("send-1");
      const stub = env.DEDUP.get(id);
      const result = await stub.trySend("send-1");
      expect(result.action).toBe("send");
    });

    it("second call for the same key returns action='skip'", async () => {
      const id = env.DEDUP.idFromName("skip-1");
      const stub = env.DEDUP.get(id);
      await stub.trySend("skip-1");
      const result = await stub.trySend("skip-1");
      expect(result.action).toBe("skip");
    });

    it("different keys are independent (both return 'send')", async () => {
      const idA = env.DEDUP.idFromName("indep-a");
      const idB = env.DEDUP.idFromName("indep-b");
      const stubA = env.DEDUP.get(idA);
      const stubB = env.DEDUP.get(idB);
      const r1 = await stubA.trySend("indep-a");
      const r2 = await stubB.trySend("indep-b");
      expect(r1.action).toBe("send");
      expect(r2.action).toBe("send");
    });

    it("marks the key in real SQLite storage after first call", async () => {
      const id = env.DEDUP.idFromName("storage-1");
      const stub = env.DEDUP.get(id);
      await stub.trySend("storage-1");

      await runInDurableObject(stub, async (_instance: DedupDO, state) => {
        const stored = await state.storage.get("storage-1");
        expect(stored).toBeDefined();
      });
    });
  });

  describe("alarm scheduling", () => {
    it("sets an alarm ~5 minutes in the future (configured DEDUP_TTL_MS=300000)", async () => {
      const id = env.DEDUP.idFromName("alarm-1");
      const stub = env.DEDUP.get(id);
      const before = Date.now();
      await stub.trySend("alarm-1");
      const after = Date.now();

      await runInDurableObject(stub, async (_instance: DedupDO, state) => {
        const alarmTs = await state.storage.getAlarm();
        expect(alarmTs).not.toBeNull();
        const ttl = 5 * 60 * 1000;
        expect(alarmTs!).toBeGreaterThanOrEqual(before + ttl - 5000);
        expect(alarmTs!).toBeLessThanOrEqual(after + ttl + 5000);
      });
    });

    it("does not set a new alarm on dedup hit (skip)", async () => {
      const id = env.DEDUP.idFromName("alarm-skip-1");
      const stub = env.DEDUP.get(id);
      await stub.trySend("alarm-skip-1"); // sets alarm

      // Get the alarm timestamp after first call
      let firstAlarm: number | null = null;
      await runInDurableObject(stub, async (_i: DedupDO, state) => {
        firstAlarm = await state.storage.getAlarm();
      });

      await stub.trySend("alarm-skip-1"); // should NOT change the alarm

      await runInDurableObject(stub, async (_i: DedupDO, state) => {
        const secondAlarm = await state.storage.getAlarm();
        // Alarm should be unchanged (same scheduled time)
        expect(secondAlarm).toBe(firstAlarm);
      });
    });
  });

  describe("alarm handler — self-cleaning", () => {
    it("fires the alarm handler via runDurableObjectAlarm", async () => {
      const id = env.DEDUP.idFromName("fire-1");
      const stub = env.DEDUP.get(id);
      await stub.trySend("fire-1");

      // Fire the alarm immediately (no waiting for TTL)
      const alarmRan = await runDurableObjectAlarm(stub);
      expect(alarmRan).toBe(true);
    });

    it("clears storage when the alarm fires", async () => {
      const id = env.DEDUP.idFromName("clear-1");
      const stub = env.DEDUP.get(id);
      await stub.trySend("clear-1");

      // Verify key exists before alarm
      await runInDurableObject(stub, async (_i: DedupDO, state) => {
        expect(await state.storage.get("clear-1")).toBeDefined();
      });

      await runDurableObjectAlarm(stub);

      // Verify key is gone after alarm
      await runInDurableObject(stub, async (_i: DedupDO, state) => {
        expect(await state.storage.get("clear-1")).toBeUndefined();
      });
    });

    it("after alarm, same key returns action='send' again", async () => {
      const id = env.DEDUP.idFromName("reuse-1");
      const stub = env.DEDUP.get(id);
      await stub.trySend("reuse-1");
      expect((await stub.trySend("reuse-1")).action).toBe("skip");

      await runDurableObjectAlarm(stub);

      // Key cleared — should allow again
      const result = await stub.trySend("reuse-1");
      expect(result.action).toBe("send");
    });
  });
});
