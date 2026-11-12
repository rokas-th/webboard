import type { Hex } from "./colour";
import { medianCut, pixelsOf } from "./importer";

export const IMAGE_WIDTH = 96;
const IMAGE_COLOURS = 8;

const decode = (file: File): Promise<ImageBitmap> =>
  createImageBitmap(file).catch(() => {
    throw new Error(`${file.name} is not an image WebBoard can read.`);
  });

export const readImageColours = async (file: File): Promise<readonly Hex[]> => {
  const bitmap = await decode(file);
  const height = Math.max(1, Math.round((IMAGE_WIDTH * bitmap.height) / bitmap.width));
  const canvas = document.createElement("canvas");
  canvas.width = IMAGE_WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    bitmap.close();
    throw new Error("This webview cannot draw images, so WebBoard cannot read colours from them.");
  }
  ctx.drawImage(bitmap, 0, 0, IMAGE_WIDTH, height);
  bitmap.close();
  const colours = medianCut(pixelsOf(ctx.getImageData(0, 0, IMAGE_WIDTH, height).data), IMAGE_COLOURS);
  if (colours.length === 0) throw new Error(`${file.name} has no visible pixels.`);
  return colours;
};
