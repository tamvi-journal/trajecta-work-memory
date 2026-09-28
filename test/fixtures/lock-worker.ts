// Child process for the multi-process lock tests. One JSON argument, one JSON line out.
import fs from "node:fs";
import path from "node:path";
import { TrajectaStore } from "../../src/store.ts";
import { withRootWriteLock, LOCK_DIR, lockStats } from "../../src/lock.ts";
import { clusterJournal } from "../../src/clusters.ts";

const args = JSON.parse(process.argv[2]);
const surface = { kind: "local" as const, name: `worker-${args.name ?? process.pid}`, session: `local:${process.pid}` };
const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

function waitFor(file: string) {
  const until = Date.now() + 20_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) throw new Error("barrier timeout");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  }
}

try {
  const store = new TrajectaStore(args.root, undefined, args.crashAt ? (point) => { if (point === args.crashAt) process.exit(4); } : undefined);
  if (args.barrier) waitFor(args.barrier);
  switch (args.action) {
    case "capture": {
      const result = store.capture({
        operationId: args.op, workId: args.workId, expectedRevision: args.expectedRevision,
        surface, kind: "progress", summary: `from ${args.name}`,
      });
      out({ ok: true, revision: result.work.revision, stats: lockStats });
      break;
    }
    case "captures": {
      for (let index = 0; index < args.count; index += 1) {
        const current = store.getWork(args.workId);
        store.capture({ operationId: `operation:${args.name}-${index}`, workId: args.workId, expectedRevision: current.revision, surface, kind: "progress", summary: `${args.name} ${index}` });
      }
      out({ ok: true });
      break;
    }
    case "assigns": {
      const journal = clusterJournal(args.root);
      for (let index = 0; index < args.count; index += 1) {
        const cluster = index % 2 ? "alpha" : "beta";
        journal.append(`operation:${args.name}-assign-${index}`, { workId: args.workId, cluster, index }, () => ({
          type: "assign" as const, workId: args.workId, cluster, reason: `${args.name} ${index}`, surface,
        }));
      }
      out({ ok: true });
      break;
    }
    case "hold-and-crash":
      withRootWriteLock(args.root, () => process.exit(3));
      break;
    case "mkdir-only":
      fs.mkdirSync(path.join(args.root, LOCK_DIR), { recursive: true });
      process.exit(0);
      break;
    default:
      throw new Error(`unknown action ${args.action}`);
  }
} catch (error) {
  out({ ok: false, error: (error as Error).name, message: (error as Error).message, stats: lockStats });
}
