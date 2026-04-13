import { describe, expect, it, vi } from "vitest";
import { AuthManager, isNearExpiry } from "../src/auth.js";
import { RefreshCoordinator } from "../src/refresh.js";
import type { TokenRecord } from "../src/types.js";
import { PluginError } from "../src/errors.js";

describe("auth", () => {
  it("detects near-expiry token", () => {
    const now = () => 1_000;
    const token = { accessToken: "a", refreshToken: "r", expiresAt: 1_200, accountId: "1" };
    expect(isNearExpiry(token, now)).toBe(true);
  });

  it("refreshes with single-flight manager callback", async () => {
    const tokens: TokenRecord[] = [
      { accessToken: "old", refreshToken: "rr", expiresAt: Date.now() + 1_000, accountId: "acc" }
    ];
    const saved: TokenRecord[] = [];

    const refreshFn = vi.fn(async () => ({
      accessToken: "new",
      refreshToken: "rr2",
      expiresAt: Date.now() + 60_000,
      accountId: "acc"
    }));

    const manager = new AuthManager({
      coordinator: new RefreshCoordinator(),
      refreshFn,
      loadTokensFn: async () => tokens,
      saveTokensFn: async (next) => {
        saved.splice(0, saved.length, ...next);
      }
    });

    const refreshed = await manager.getActiveToken("acc");
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(saved[0]?.accessToken).toBe("new");
    expect(refreshed.accessToken).toBe("new");
  });

  it("emits missing credentials canonical error", async () => {
    const manager = new AuthManager({
      coordinator: new RefreshCoordinator(),
      loadTokensFn: async () => []
    });

    await expect(manager.getActiveToken()).rejects.toMatchObject({
      code: "E_AUTH_MISSING_CREDENTIALS",
      message: "No Qwen OAuth credentials found"
    });
  });

  it("emits invalid credentials canonical error", async () => {
    const malformed = new AuthManager({
      coordinator: new RefreshCoordinator(),
      loadTokensFn: async () => [
        { accessToken: "", refreshToken: "x", expiresAt: 1000, accountId: "bad" }
      ]
    });

    await expect(malformed.getActiveToken()).rejects.toMatchObject({
      code: "E_AUTH_INVALID_CREDENTIALS",
      message: "Stored credentials are invalid or malformed. Re-authenticate with Qwen OAuth."
    });

    const manager = new AuthManager({
      coordinator: new RefreshCoordinator(),
      loadTokensFn: async () => [
        { accessToken: "a", refreshToken: "b", expiresAt: Date.now() + 10_000, accountId: "real" }
      ]
    });

    await expect(manager.getActiveToken("missing")).rejects.toMatchObject({
      code: "E_AUTH_SCOPE_UNSUPPORTED",
      message: "Requested account is not available."
    });
  });

  it("supports multi-account rotation", async () => {
    const manager = new AuthManager({
      coordinator: new RefreshCoordinator(),
      loadTokensFn: async () => [
        { accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() + 120_000, accountId: "one" },
        { accessToken: "a2", refreshToken: "r2", expiresAt: Date.now() + 120_000, accountId: "two" }
      ],
      saveTokensFn: async () => undefined
    });

    const first = await manager.getActiveToken();
    const second = await manager.getActiveToken();
    expect(first.accountId).not.toBe(second.accountId);
    expect(["one", "two"]).toContain(first.accountId);
    expect(["one", "two"]).toContain(second.accountId);
  });

  it("emits refresh upstream rejected canonical error", async () => {
    const manager = new AuthManager({
      coordinator: new RefreshCoordinator(),
      loadTokensFn: async () => [
        { accessToken: "old", refreshToken: "r", expiresAt: Date.now() + 200, accountId: "acc" }
      ],
      saveTokensFn: async () => undefined,
      refreshFn: async () => ({
        accessToken: "",
        refreshToken: "r",
        expiresAt: Date.now() - 1,
        accountId: "acc"
      })
    });

    await expect(manager.getActiveToken("acc")).rejects.toMatchObject({
      code: "E_REFRESH_UPSTREAM_REJECTED",
      message: "Upstream refresh produced invalid token"
    });
  });

  it("emits headless unsupported canonical error", async () => {
    const manager = new AuthManager({ coordinator: new RefreshCoordinator() });
    const previousDisplay = process.env.DISPLAY;
    const previousWayland = process.env.WAYLAND_DISPLAY;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;

    try {
      if (process.platform === "win32") {
        return;
      }

      await manager.failIfHeadlessWithoutSupport();
      throw new Error("expected headless failure");
    } catch (error) {
      if (process.platform !== "win32") {
        expect(error).toBeInstanceOf(PluginError);
        expect((error as PluginError).code).toBe("E_AUTH_HEADLESS_UNSUPPORTED");
        expect((error as PluginError).message).toContain("Headless OAuth is unsupported in v1");
      }
    } finally {
      if (previousDisplay !== undefined) {
        process.env.DISPLAY = previousDisplay;
      }
      if (previousWayland !== undefined) {
        process.env.WAYLAND_DISPLAY = previousWayland;
      }
    }
  });
});
