import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { convertGantt, countsText, GanttError, readBack } from "../src/import/gantt.ts";
import { newId } from "../src/log/ids.ts";
import { writeNew } from "./write-new.mjs";

const USAGE = 'Usage: scripts/gantt-to-wbx.mjs <in.gantt> [<out.webboard>] [--name "<plan name>"]';

class ArgError extends Error {}

function parseArgs(argv) {
  const positional = [];
  let name;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--name") {
      if (i + 1 >= argv.length) throw new ArgError(`--name needs a value\n${USAGE}`);
      name = argv[i + 1];
      i += 1;
    } else if (argv[i].startsWith("--")) {
      throw new ArgError(`Unknown option ${argv[i]}\n${USAGE}`);
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length < 1 || positional.length > 2) throw new ArgError(USAGE);
  const [input, given] = positional;
  if (given === undefined && !input.endsWith(".gantt")) throw new ArgError(`${input} does not end in .gantt; name the output file\n${USAGE}`);
  return { input, output: given ?? input.slice(0, -".gantt".length) + ".webboard", name };
}

function main() {
  const { input, output, name } = parseArgs(process.argv.slice(2));
  if (existsSync(output)) throw new ArgError(`${output} already exists; the converter does not overwrite files`);
  const g = convertGantt({ text: readFileSync(input, "utf8"), fileName: basename(input), name, dev: newId(), ses: newId(), now: Date.now() });
  writeNew(output, g.bytes, (written) => readBack(written, basename(output), g));
  console.log(`Plan: ${g.plan.name}`);
  console.log(`Counts: ${countsText(g.counts)}`);
  console.log(
    "Fidelity: every task and milestone shows the .gantt file's start, end and status, in the converted plan and in the written file read back; nothing unscheduled, held or in conflict",
  );
  console.log("Dropped:");
  g.dropped.forEach((d) => console.log(`- ${d}`));
  console.log(`Wrote: ${output}`);
}

const stackOf = (e) => (e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e));

try {
  main();
} catch (e) {
  if (e instanceof GanttError || e instanceof ArgError) console.error(e.message);
  else if (e instanceof AggregateError) console.error([stackOf(e), ...e.errors.map((x, i) => `[${i}] ${stackOf(x)}`)].join("\n"));
  else console.error(stackOf(e));
  process.exit(1);
}
