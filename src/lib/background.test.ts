import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/monitoring/capture-error", () => ({ captureError: vi.fn() }));

import { waitUntil } from "@vercel/functions";
import { captureError } from "@/lib/monitoring/capture-error";
import { runInBackground } from "@/lib/background";

beforeEach(() => vi.clearAllMocks());

describe("runInBackground", () => {
  it("runs the task and registers it with waitUntil so the platform keeps the function alive", async () => {
    const task = vi.fn().mockResolvedValue("done");

    const promise = runInBackground("test-task", task);
    await promise;

    expect(task).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledWith(promise);
  });

  it("swallows and reports task errors instead of throwing", async () => {
    const boom = new Error("gateway down");

    await expect(runInBackground("receipt-notifications", () => Promise.reject(boom))).resolves.toBeUndefined();

    expect(captureError).toHaveBeenCalledWith(boom, { context: "receipt-notifications" });
  });

  it("still runs the task when waitUntil is unavailable (local dev / tests)", async () => {
    vi.mocked(waitUntil).mockImplementationOnce(() => {
      throw new Error("no request context");
    });
    const task = vi.fn().mockResolvedValue(undefined);

    await runInBackground("test-task", task);

    expect(task).toHaveBeenCalledTimes(1);
  });
});
