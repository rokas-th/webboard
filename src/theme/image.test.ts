import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_WIDTH, readImageColours } from "./image";

const file = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });

const stubCanvas = (data: Uint8ClampedArray) => {
  const drawImage = vi.fn();
  const getImageData = vi.fn((_x: number, _y: number, w: number, h: number) => ({ data, width: w, height: h }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({ drawImage, getImageData })) as unknown as HTMLCanvasElement["getContext"]);
  return { drawImage, getImageData };
};

const stubBitmap = (width: number, height: number) => {
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", vi.fn(() => Promise.resolve({ width, height, close })));
  return close;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("readImageColours", () => {
  it("reads a decoded image of red and blue", async () => {
    const close = stubBitmap(2, 1);
    const { drawImage, getImageData } = stubCanvas(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]));
    const colours = await readImageColours(file);
    expect([...colours].sort()).toEqual(["#0000FF", "#FF0000"]);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, IMAGE_WIDTH, 48);
    expect(getImageData).toHaveBeenCalledWith(0, 0, IMAGE_WIDTH, 48);
    expect(close).toHaveBeenCalled();
  });

  it("keeps at least one pixel of height for a very wide image", async () => {
    stubBitmap(10000, 1);
    const { getImageData } = stubCanvas(new Uint8ClampedArray([255, 0, 0, 255]));
    await readImageColours(file);
    expect(getImageData).toHaveBeenCalledWith(0, 0, IMAGE_WIDTH, 1);
  });

  it("names the file when it cannot be decoded", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(() => Promise.reject(new DOMException("bad", "InvalidStateError"))));
    await expect(readImageColours(file)).rejects.toThrow("photo.png is not an image WebBoard can read.");
  });

  it("rejects an image with no visible pixels", async () => {
    stubBitmap(2, 1);
    stubCanvas(new Uint8ClampedArray([255, 0, 0, 0, 0, 0, 255, 10]));
    await expect(readImageColours(file)).rejects.toThrow("photo.png has no visible pixels.");
  });
});
