#!/usr/bin/env -S node --experimental-strip-types
import process from "node:process";
import { TrajectaStore } from "./store.ts";
import { importLifecycle } from "./import-lifecycle.ts";

const [command, ...args] = process.argv.slice(2);
const store = new TrajectaStore(process.env.TRAJECTA_HOME);

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  if (command === "list") print(store.list());
  else if (command === "route") print(store.route(args.join(" ")));
  else if (command === "packet") {
    const [workId, target, ...cue] = args;
    if (!workId || !["cloud", "local"].includes(target)) throw new Error("Usage: trajecta packet <work-id> <cloud|local> <cue>");
    print(store.transfer(workId, cue.join(" "), target as "cloud" | "local"));
  } else if (command === "import-awm" || command === "import-lwm") {
    const [source] = args;
    if (!source) throw new Error(`Usage: trajecta ${command} <source-root>   (the folder that holds state/ and config/)`);
    const report = importLifecycle(store, source, command === "import-awm" ? "awm" : "lwm");
    print({ ...report, registry: report.registry ? { clusters: Object.keys(report.registry.clusters) } : null });
  } else {
    process.stdout.write("Trajecta — keep the work, skip the handoff.\n\nCommands:\n  list\n  route <cue>\n  packet <work-id> <cloud|local> <cue>\n  import-awm <source-root>\n  import-lwm <source-root>\n");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
