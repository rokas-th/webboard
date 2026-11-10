import * as nodeFs from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * @param {string} output
 * @param {Uint8Array} bytes
 * @param {(written: Uint8Array) => void} check
 * @param {Pick<typeof nodeFs, "openSync" | "writeFileSync" | "closeSync" | "readFileSync" | "linkSync" | "unlinkSync">} [fs]
 */
export function writeNew(output, bytes, check, fs = nodeFs) {
  const temp = join(dirname(output), `.${basename(output)}.${process.pid}.tmp`);
  let fd = null;
  let created = false;
  try {
    fd = fs.openSync(temp, "wx");
    created = true;
    fs.writeFileSync(fd, bytes);
    const open = fd;
    fd = null;
    fs.closeSync(open);
    check(new Uint8Array(fs.readFileSync(temp)));
    fs.linkSync(temp, output);
    fs.unlinkSync(temp);
  } catch (original) {
    const open = fd;
    const cleanup = [...(open === null ? [] : [() => fs.closeSync(open)]), ...(created ? [() => fs.unlinkSync(temp)] : [])];
    const failures = cleanup.flatMap((step) => {
      try {
        step();
        return [];
      } catch (e) {
        return [e];
      }
    });
    if (failures.length > 0) {
      const why = original instanceof Error ? original.message : String(original);
      throw new AggregateError([original, ...failures], `${why}; removing the temp file ${temp} failed too`);
    }
    throw original;
  }
}
