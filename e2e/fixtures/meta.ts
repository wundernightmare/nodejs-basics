import * as allure from "allure-js-commons";

/**
 * TestOps identity for the e2e layer — the same shape as `meta` / `testCase`
 * in @base/testing (vitest) and `testx.Meta` / `testx.Case` in the Go
 * sibling, so the merged Allure report reads the same across layers.
 *
 * SAMPLE VALUES: epic, feature, owner and the NB-5xx ids are placeholders —
 * replace them with your TestOps tree. One id per test; a test without an
 * id is not in the test plan.
 */
export interface Meta {
  epic?: string;
  feature?: string;
  owner?: string;
  tags?: string[];
}

export const E2E: Meta = { epic: "nodejs-basics", owner: "@team-platform", tags: ["e2e"] };

/** Label the current test with suite-level metadata. Call first inside the test body. */
export async function meta(m: Meta): Promise<void> {
  const labels: PromiseLike<void>[] = [];
  if (m.epic) labels.push(allure.epic(m.epic));
  if (m.feature) labels.push(allure.feature(m.feature));
  if (m.owner) labels.push(allure.owner(m.owner));
  if (m.tags?.length) labels.push(allure.tags(...m.tags));
  await Promise.all(labels);
}

/** Bind the current test to its TestOps case (id + story + TMS link). */
export async function testCase(id: string, story: string): Promise<void> {
  await Promise.all([allure.allureId(id), allure.story(story), allure.tms(id, id)]);
}

export const { Severity } = allure;
