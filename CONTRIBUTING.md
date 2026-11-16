# Contributing

Build, test and repository conventions are in [CLAUDE.md](CLAUDE.md) and the
README. This file holds the rules for comments in code.

## Comments

A comment carries what the reader cannot get from the code in front of them:
the **reason** (the failure prevented, the trade-off taken, a consequence
that is not obvious), an **invariant**, or a **contract** — what a caller may
rely on without opening the body. What the name, the types or the next lines
already say is not repeated: a comment that restates them is one more thing
to keep in step.

For every comment:

1. **One home per fact.** A list, an order, a number taken from a dependency
   is written in one place — next to the code that makes it true — and other
   comments point there (`see registerRequestContext`); a copy drifts. The home
   of a default is its `ENV_REGISTRY` entry: elsewhere name the key, not the
   value. Where a list is unavoidable, name the criterion, not the members:
   "the apps that import `@base/kafka`", not "api and worker". Text in shared
   code holds for every caller and implementation behind it (the Kafka and
   the jobs consumer, both cache tiers); what holds for one lives in that
   one.
2. **A suppression is a claim.** `// oxlint-disable-next-line <rule> -- <why>`,
   `// @ts-expect-error <why>`, `// nosemgrep: <rule> -- <why>` and
   `// Stryker disable next-line <mutator>: <why>` name the rule and give a
   reason that stands on its own (no "same", no "as above") and can be
   checked. When the cause goes, the directive goes.
3. **A claim about a dependency, Node or the OS** carries the version it was
   seen in or the test that pins it.
4. **History lives in the commit.** "The old code…", "was removed", "as
   before" describe something the reader cannot see; say what the code
   guarantees now.
5. **No invented reasons.** If a reason cannot be established from the code,
   its tests or its history, leave the comment out and ask — a plausible
   guess is worse than nothing. This outranks rule 8.

**Configuration and exported API** — an `ENV_REGISTRY` or `METRIC_REGISTRY`
entry, a config schema, an identifier exported from a package's `index.ts`,
a package README — are read by someone who turns a knob or calls a function
without the code open. Say what it does, the unit, what an unset value
means, what breaks at the edges, at whatever length that takes.

**Everything else** is read with the code open, so additionally:

6. **No restating.** Not the name (`// release frees a slot`), not the next
   lines narrated, not a JSDoc `@param` / `@returns` that repeats the type.
   An identifier that is not exported from the package and whose name and
   signature say it all has no comment.
7. **A contract earns its line** when the signature does not show it: what a
   returned `undefined` or `false` means, the order of a result, who owns a
   buffer, which edge is accepted, what must have been awaited first.
   Describe the condition the code tests, not the intent behind it.
8. **A literal wait or size outside configuration** has a name or a clause
   saying why this value.
9. **"Never", "only", "first", "every" are claims.** Write one where the
   reader can check it in the same function; otherwise scope it ("first
   within `setupTelemetry`").
10. **A design note longer than its identifier deserves** goes in a block of
    its own after the imports; the identifier keeps its contract.

Tests follow the same rules: the title passed to `testCase` states the rule
the test proves, and a comment is added only for what the title cannot hold
— never for the steps.
