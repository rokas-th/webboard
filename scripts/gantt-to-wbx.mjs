import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { convertGantt, readBack } from "../src/import/gantt.ts";
import { newId } from "../src/log/ids.ts";

const USAGE = 'Usage: scripts/gantt-to-wbx.mjs <in.gantt> [<out.wbx>] [--name "<plan name>"]';

function parseArgs(argv) {
  const positional = [];
  let name;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--name") {
      if (i + 1 >= argv.length) throw new Error(`--name needs a value\n${USAGE}`);
      name = argv[i + 1];
      i += 1;
    } else if (argv[i].startsWith("--")) {
      throw new Error(`Unknown option ${argv[i]}\n${USAGE}`);
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length < 1 || positional.length > 2) throw new Error(USAGE);
  const [input, given] = positional;
  if (given === undefined && !input.endsWith(".gantt")) throw new Error(`${input} does not end in .gantt; name the output file\n${USAGE}`);
  return { input, output: given ?? input.slice(0, -".gantt".length) + ".wbx", name };
}

const sameCounts = (a, b) => ["groups", "tasks", "milestones", "links", "notes"].every((k) => a[k] === b[k]);

const showCounts = (c) => `${c.groups} groups, ${c.tasks} tasks, ${c.milestones} milestones, ${c.links} links, ${c.notes} notes`;

function verify(bytes, output, counts) {
  const back = readBack(bytes, basename(output));
  if (!sameCounts(back, counts)) throw new Error(`The written plan reads back as ${showCounts(back)}, not ${showCounts(counts)}`);
}

function main() {
  const { input, output, name } = parseArgs(process.argv.slice(2));
  if (existsSync(output)) throw new Error(`${output} already exists; the converter does not overwrite files`);
  const g = convertGantt({ text: readFileSync(input, "utf8"), fileName: basename(input), name, dev: newId(), ses: newId(), now: Date.now() });
  verify(g.bytes, output, g.counts);
  writeFileSync(output, g.bytes, { flag: "wx" });
  try {
    verify(new Uint8Array(readFileSync(output)), output, g.counts);
  } catch (e) {
    unlinkSync(output);
    throw e;
  }
  console.log(`Plan: ${g.plan.name}`);
  console.log(`Counts: ${showCounts(g.counts)}`);
  console.log("Fidelity: every task and milestone shows the .gantt file's start and end; nothing unscheduled, held or in conflict");
  console.log("Dropped:");
  g.dropped.forEach((d) => console.log(`- ${d}`));
  console.log(`Wrote: ${output}`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
