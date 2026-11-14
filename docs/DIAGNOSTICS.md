# Post-mortem diagnostics

What is left of a pod after it died, and where to find it.

The admin port answers while the process lives and somebody is looking
(`POST /debug/heapdump`, `/debug/report`, `/debug/cpu-profile`). A pod that
crashed or ran out of memory at night gives neither, so the service takes the
evidence at the moment it exists and ships it to object storage.

It is two services of `@base/observability`, turned on per app in
`ObservabilityModule.forRoot`:

| Option | Service | In this repo |
| --- | --- | --- |
| `enableCrashReport` | `CrashReportService` | api, worker |
| `enableHeapSnapshot` | `HeapSnapshotService` | api |

Both write to the container's temp directory; with `HEAP_SNAPSHOT_S3_BUCKET`
set they upload what they wrote and delete the local copy. Without a bucket
the files die with the pod — mount a volume there or set the bucket.

| Event | What is captured | When it is shipped |
| --- | --- | --- |
| crash: an uncaught exception or an unhandled rejection | Node's diagnostic report (JSON: the JavaScript and native stacks, heap statistics, libuv handles, the environment) and a heap snapshot | at once, before the process exits — the upload has 10 s |
| memory pressure: heap used ≥ `HEAP_OOM_THRESHOLD` (0.85) of the V8 heap limit, checked every `HEAP_OOM_POLL_INTERVAL_MS` (10 s) | a heap snapshot | at once |
| `kill -USR2 <pid>`, `POST /debug/heapdump` | a heap snapshot | at once |
| `POST /debug/report` | a diagnostic report and a heap snapshot, the process keeps running | at once |
| `POST /debug/cpu-profile?seconds=10` | a `.cpuprofile`, returned in the response — not stored | — |
| OOM kill by the kernel, SIGKILL, node loss | nothing at that moment — there is no hook | the memory-pressure snapshot is the evidence, taken before |

A background task that fails for good (`background.panic`, see
`guardBackground`) stops the process in order instead: it is in the logs with
its stack, not here.

## Where it goes

```
<HEAP_SNAPSHOT_S3_PREFIX>/<service>/<pod>/heap-2026-11-11T05-09-38-994Z-oom.heapsnapshot
<CRASH_REPORT_S3_PREFIX>/<service>/<pod>/<date>/crash-2026-11-11T05-09-37-095Z-uncaught.json
                                                 crash-2026-11-11T05-09-37-095Z-uncaught.heapsnapshot
```

`heap-snapshots` and `crash-reports` by default; the last word of a file name
is what triggered it (`oom`, `signal`, `manual`, `uncaught`). The pod name
keeps replicas apart. Give both prefixes a lifecycle rule (30 days is plenty):
a heap snapshot is about the size of the heap.

The upload uses the AWS SDK's default credential chain (the pod's role, or
`AWS_*` in the environment) — not the `S3_*` settings of `@base/s3`, which
belong to the application's own data.

```sh
aws s3 ls s3://$BUCKET/crash-reports/api/ --recursive
aws s3 cp s3://$BUCKET/heap-snapshots/api/api-7d9f-xkp2q/heap-…-oom.heapsnapshot .
```

## Reading what was captured

**A heap snapshot** opens in Chrome DevTools → Memory → Load. Sort the
Summary by retained size; the Comparison view of two snapshots taken minutes
apart shows what grows. A snapshot holds every string of the process —
request bodies, tokens, whatever was in memory: treat the bucket like a
database backup.

**A diagnostic report** is JSON:

| Section | What to look at |
| --- | --- |
| `header.trigger`, `header.event` | why it was written |
| `javascriptStack`, `nativeStack` | where the process was |
| `javascriptHeap` | `totalMemory`, `usedMemory`, `memoryLimit`, per space |
| `libuv` | open handles: sockets, timers — a leak of those is here, not in the heap |
| `resourceUsage` | `rss`, `maxRss`, CPU time |
| `environmentVariables` | the process environment — **credentials included** |

`rss` far above `javascriptHeap.totalMemory` means the memory is not
JavaScript's: buffers, native clients (librdkafka), a memory-backed volume. No
heap snapshot will show it.

**A CPU profile** opens in Chrome DevTools → Performance → Load profile.

## What the capture costs

- `v8.writeHeapSnapshot` is synchronous: the event loop stops for the time it
  takes — seconds on a heap of a gigabyte — and the snapshot needs about as
  much memory again to build. Near the container's limit that can be the
  allocation that gets the pod killed. The threshold is deliberately below the
  limit (0.85), and only one capture runs at a time.
- For a heap that is running out for real, Node's own flag is more reliable —
  it runs inside the allocator, before it gives up:
  `--heapsnapshot-near-heap-limit=3` (set it in the container's command; the
  images here do not).
- The V8 heap limit must fit the container, or the kernel kills the pod before
  any of this triggers: the service checks that at start
  (`RUNTIME_HEAP_LIMIT_RATIO`, RUNBOOK "The pod is OOM-killed").

## Settings

| Key | Default | |
| --- | --- | --- |
| `HEAP_SNAPSHOT_S3_BUCKET` | — | where both services upload; unset = local files only |
| `HEAP_SNAPSHOT_S3_PREFIX` | `heap-snapshots` | |
| `CRASH_REPORT_S3_PREFIX` | `crash-reports` | |
| `HEAP_OOM_THRESHOLD` | `0.85` | share of the V8 heap limit that triggers a snapshot |
| `HEAP_OOM_POLL_INTERVAL_MS` | `10000` | how often the heap is checked |

Read once, at process start (env or `config.yaml`, like every other key).

## What the Go sibling has and this does not

golang-basics ships a crash report on the **next start** of the container
(the runtime writes it as the process dies), a goroutine profile next to the
heap profile, and a flight recorder — the last seconds of the execution trace
on a slow request. Node has no equivalent of the last two. Here a crash is
captured by the dying process itself, which works for a JavaScript exception
and not for a hard abort (a native crash, an out-of-memory abort inside V8).
