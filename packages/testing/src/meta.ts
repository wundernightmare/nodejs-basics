import * as allure from "allure-js-commons";
import { beforeEach } from "vitest";

/**
 * TestOps identity of a suite: where it sits in the Epic / Feature tree, who
 * answers for it, and the tags the report is sliced by (the package and the
 * layer — "database", "integration"). Per-test identity (the case id, the
 * story) is set inside the test with `testCase`, so the report can be
 * filtered by both.
 *
 * SAMPLE VALUES. This repository is a template: the epic, feature, owner and
 * the "NB-<n>" ids used across the suites are placeholders whose *shape* is
 * the point — replace them with your Allure TestOps project's tree, owner
 * handles and case ids. One rule survives the replacement: an id appears in
 * exactly one test, and a test without an id is not in the test plan.
 */
export interface Meta {
  /** Top-level grouping, usually the product or service line ("nodejs-basics"). */
  epic?: string;
  /** The capability under test ("tasks API", "valkey cache"). */
  feature?: string;
  /** Team or person handle as your TestOps knows it ("@team-platform"). */
  owner?: string;
  /** Free-form tags — by convention the package and the layer. */
  tags?: string[];
}

/**
 * Apply suite metadata to every test of the enclosing `describe`. Allure's
 * runtime API labels the *current* test, so this registers a `beforeEach`;
 * call it once at the top of the `describe` body.
 *
 *   describe("valkey cache", () => {
 *     meta({ epic: "nodejs-basics", feature: "cache", owner: "@team-platform", tags: ["cache", "integration"] });
 *     …
 *   });
 */
export function meta(m: Meta): void {
  beforeEach(async () => {
    const labels: PromiseLike<void>[] = [];
    if (m.epic) labels.push(allure.epic(m.epic));
    if (m.feature) labels.push(allure.feature(m.feature));
    if (m.owner) labels.push(allure.owner(m.owner));
    if (m.tags !== undefined && m.tags.length > 0) labels.push(allure.tags(...m.tags));
    await Promise.all(labels);
  });
}

/**
 * Bind the current test to its TestOps case: the id (as the Allure id, which
 * is what test plans and history key on), the story it belongs to, and a TMS
 * link — the reporter's `links.tms.urlTemplate` turns the bare id into a URL.
 * One id per test. Call it first thing inside the test body.
 *
 *   it("creates a task", async () => {
 *     await testCase("NB-101", "create, read, list, archive a task");
 *     …
 *   });
 */
export async function testCase(id: string, story: string): Promise<void> {
  await Promise.all([allure.allureId(id), allure.story(story), allure.tms(id, id)]);
}

/** Mark the current test's severity (Allure's scale: blocker … trivial). */
export async function severity(level: allure.Severity | `${allure.Severity}`): Promise<void> {
  await allure.severity(level);
}

export { Severity } from "allure-js-commons";
