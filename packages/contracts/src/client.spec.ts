import { describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import { createTasksClient } from "./client.js";

describe("createTasksClient", () => {
  meta({
    epic: "nodejs-basics",
    feature: "contracts",
    owner: "@team-platform",
    tags: ["contracts", "client", "unit"],
  });

  it("builds requests from the contract and types the answers by status", async () => {
    await testCase(
      "NB-741",
      "path params, body and base URL reach the transport; 404 lands in `error`",
    );
    const seen: Request[] = [];
    const api = createTasksClient({
      baseUrl: "http://tasks.test",
      fetch: async (req: Request) => {
        seen.push(req);
        const found = !req.url.endsWith("/nope");
        return new Response(
          JSON.stringify(found ? { id: "t1", title: "hi" } : { status: 404, title: "Not Found" }),
          {
            status: found ? 201 : 404,
            headers: { "content-type": found ? "application/json" : "application/problem+json" },
          },
        );
      },
    });

    const created = await api.POST("/tasks", { body: { title: "hi" } });
    expect(created.data).toMatchObject({ id: "t1" });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("http://tasks.test/tasks");
    expect(await seen[0]?.json()).toEqual({ title: "hi" });

    const missing = await api.GET("/tasks/{id}", { params: { path: { id: "nope" } } });
    expect(missing.data).toBeUndefined();
    expect(missing.error).toMatchObject({ status: 404 });
    expect(seen[1]?.url).toBe("http://tasks.test/tasks/nope");
  });
});
