import { describe, expect, it } from "vitest";
import { RefreshCoordinator } from "../src/refresh.js";
import { PluginError } from "../src/errors.js";

const token = {
  accessToken: "a",
  refreshToken: "r",
  expiresAt: Date.now() + 30_000,
  accountId: "acc1"
};

describe("refresh coordinator", () => {
  it("deduplicates concurrent refresh calls", async () => {
    const coordinator = new RefreshCoordinator();
    let calls = 0;

    const fn = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return token;
    };

    const [a, b] = await Promise.all([
      coordinator.runSingleFlight("acc1", fn),
      coordinator.runSingleFlight("acc1", fn)
    ]);

    expect(calls).toBe(1);
    expect(a.accountId).toBe("acc1");
    expect(b.accountId).toBe("acc1");
  });

  it("emits singleflight timeout canonical error", async () => {
    const coordinator = new RefreshCoordinator();
    const stalled = async () => new Promise<typeof token>(() => undefined);

    try {
      await coordinator.runSingleFlight("acc1", stalled, 10);
      throw new Error("expected timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError);
      expect((error as PluginError).code).toBe("E_REFRESH_SINGLEFLIGHT_TIMEOUT");
      expect((error as PluginError).message).toContain("Refresh lock wait exceeded");
    }
  });
});
