import { describe, expect, it } from "vitest";

import { testCase } from "@base/testing";

import { RetryBudget } from "./retry-budget.js";

function spend(budget: RetryBudget): number {
  let granted = 0;
  while (granted < 1_000 && budget.tryRetry()) granted++;
  return granted;
}

describe("RetryBudget", () => {
  it("allows minRetries + ratio × requests per window", async () => {
    await testCase(
      "NB-1123",
      "the retry budget: minRetries + ratio × requests over a sliding window",
    );
    let now = 0;
    const budget = new RetryBudget({ ratio: 0.5, minRetries: 2, windowMs: 1_000 }, () => now);
    for (let i = 0; i < 10; i++) budget.request();
    expect(spend(budget)).toBe(7);
    expect(budget.tryRetry()).toBe(false);
    now = 500;
    expect(budget.tryRetry()).toBe(false);
  });

  it("forgets what slid out of the window", async () => {
    await testCase(
      "NB-1123",
      "the retry budget: minRetries + ratio × requests over a sliding window",
    );
    let now = 0;
    const budget = new RetryBudget({ ratio: 0, minRetries: 2, windowMs: 1_000 }, () => now);
    expect(spend(budget)).toBe(2);
    now = 999;
    expect(budget.tryRetry()).toBe(false);
    now = 1_000;
    expect(spend(budget)).toBe(2);
  });

  it("defaults to 0.2 × requests + 10 per 10 s", async () => {
    await testCase(
      "NB-1123",
      "the retry budget: minRetries + ratio × requests over a sliding window",
    );
    let now = 0;
    const budget = new RetryBudget(undefined, () => now);
    for (let i = 0; i < 100; i++) budget.request();
    expect(spend(budget)).toBe(30);
    now = 9_999;
    expect(budget.tryRetry()).toBe(false);
    now = 10_000;
    expect(spend(budget)).toBe(10);
  });
});
