import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../services/ipc";
import { toast } from "../common/Toast";
import { printNow } from "./print";
import { startPrint } from "./start";

vi.mock("./print", () => ({ printNow: vi.fn(async () => undefined) }));
vi.mock("../common/Toast", () => ({ toast: vi.fn() }));

afterEach(() => {
  vi.mocked(toast).mockClear();
  vi.mocked(printNow).mockReset();
});

describe("startPrint (product-8)", () => {
  it("shows the sheet before it prints and leaves it shown once printing has started", async () => {
    const seen: boolean[] = [];
    let on = false;
    vi.mocked(printNow).mockImplementation(async () => {
      seen.push(on);
    });
    await startPrint("macos", (next) => {
      on = next;
    });
    expect([seen, on]).toEqual([[true], true]);
    expect(vi.mocked(printNow).mock.calls).toEqual([["macos"]]);
  });

  it("hides the sheet and resolves on a refusal", async () => {
    const set = vi.fn<(on: boolean) => void>();
    vi.mocked(printNow).mockRejectedValueOnce(new AppError("print.failed", "Could not open the print dialog: no window."));
    await startPrint("macos", set);
    expect(set.mock.calls).toEqual([[true], [false]]);
    expect(vi.mocked(toast).mock.calls).toEqual([["Could not open the print dialog: no window.", "bad"]]);
  });

  it("hides the sheet and rejects on any other failure", async () => {
    const set = vi.fn<(on: boolean) => void>();
    vi.mocked(printNow).mockRejectedValueOnce(new Error("Print is not offered on iOS"));
    await expect(startPrint("ios", set)).rejects.toThrow("Print is not offered on iOS");
    expect(set.mock.calls).toEqual([[true], [false]]);
    expect(toast).not.toHaveBeenCalled();
  });
});
