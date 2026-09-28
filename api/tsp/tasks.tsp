import "@typespec/http";
import "@typespec/openapi";

using TypeSpec.Http;

namespace Tasks;

/**
 * Server-assigned task identifier: a 21-character nanoid over the URL-safe
 * alphabet (generated at the application layer by packages/common `generateId`).
 */
@pattern("^[A-Za-z0-9_-]{21}$")
scalar TaskId extends string;

/** Lifecycle state of a task. */
enum TaskStatus {
  ACTIVE,
  ARCHIVED,
}

// Free text the store can hold: PostgreSQL TEXT rejects a NUL byte, so every
// text property states the pattern `^[^\u0000]*$` — a generated
// schema-compliant request is always accepted (the lesson the Go sibling
// learned from Schemathesis). Lengths are code points, as JSON Schema counts
// them (the app counts the same way).

/** A single to-do item. */
model Task {
  id: TaskId;
  /** Human-readable title; 1..200 characters. */
  @minLength(1)
  @pattern("^[^\\u0000]*$")
  @maxLength(200)
  title: string;
  /** Longer description, up to 2000 characters; null when the task has none. */
  @pattern("^[^\\u0000]*$")
  @maxLength(2000)
  description: string | null;
  status: TaskStatus;
  /** Creation time, RFC 3339 UTC. */
  createdAt: utcDateTime;
  /** Time of the last write, RFC 3339 UTC (equals createdAt until the first update). */
  updatedAt: utcDateTime;
  /** Optimistic-lock counter: 0 at creation, +1 on every write; sent back as `expectedVersion`. */
  @minValue(0)
  version: int32;
}

/** One row of GET /tasks — the list projection carries no description/version. */
model TaskListItem {
  id: TaskId;
  @minLength(1)
  @pattern("^[^\\u0000]*$")
  @maxLength(200)
  title: string;
  status: TaskStatus;
  createdAt: utcDateTime;
}

/** Body of GET /tasks: one page, newest first, plus the total row count. */
model TaskListPage {
  items: TaskListItem[];
  /** Number of tasks in the store (all pages). */
  @minValue(0)
  total: int32;
}

/**
 * Body of POST /tasks. Closed, like every object here (tspconfig
 * `seal-object-schemas`): an unknown member is rejected with a 400 problem.
 */
model CreateTask {
  @minLength(1)
  @pattern("^[^\\u0000]*$")
  @maxLength(200)
  title: string;
  @pattern("^[^\\u0000]*$")
  @maxLength(2000)
  description?: string;
}

/**
 * Body of PATCH /tasks/{id}. Only the members present are changed;
 * `description: null` clears it. `expectedVersion` is the version the client
 * last read — a stale value is a 409 problem. Closed object.
 */
model UpdateTask {
  @minLength(1)
  @pattern("^[^\\u0000]*$")
  @maxLength(200)
  title?: string;
  @pattern("^[^\\u0000]*$")
  @maxLength(2000)
  description?: string | null;
  @minValue(0)
  expectedVersion: int32;
}

/** Body of POST /tasks/{id}/archive. Closed object. */
model ArchiveTask {
  /** The version the client last read — a stale value is a 409 problem. */
  @minValue(0)
  expectedVersion: int32;
}

/**
 * RFC 9457 problem details. Extension members are inlined (RFC 9457 §3.2):
 * every error the API emits carries `errorId` and `instance`, and
 * `request_id` whenever the request had a context (always, for a route).
 */
@error
model Problem {
  /** URI reference identifying the problem type; "about:blank" for a generic HTTP error. */
  type: string;
  /** Short, human-readable summary of the problem type (the HTTP reason phrase for about:blank). */
  title: string;
  /** HTTP status of this occurrence — always equals the response status. */
  @minValue(100)
  @maxValue(599)
  status: int32;
  /** Human-readable explanation specific to this occurrence. */
  detail?: string;
  /** URI reference identifying this occurrence — the request path (with query). */
  instance?: string;
  /** Opaque id of this error occurrence, also on the server's log line (error.id). */
  errorId?: string;
  /**
   * The request's correlation id — the same value as the X-Request-Id
   * response header and the http.request.id field of the service's log lines.
   */
  request_id?: string;
}

/** A problem response with the given status and content type. */
model ProblemResponse<Status> {
  @statusCode _: Status;
  @header contentType: "application/problem+json";
  @body body: Problem;
}

/**
 * Client-chosen key that makes POST /tasks safe to retry: a repeat of the
 * same request with the same key replays the first response
 * (X-Idempotent-Replayed: true) instead of creating a second task. A UUID;
 * anything else is a 400 problem. The same key with a different request
 * (or one still in flight) is a 409 problem.
 */
model IdempotencyKey {
  @header("Idempotency-Key")
  @format("uuid")
  idempotencyKey?: string;
}

// Limits every operation shares (apps/api app.ts): a body over
// HTTP_BODY_LIMIT_BYTES is a 413, a request whose budget
// (HTTP_REQUEST_TIMEOUT_MS, or a shorter x-request-timeout-ms) runs out in a
// dependency a 504.

@route("/tasks")
interface TasksOps {
  /**
   * Create a task. Its `task.created` event is written in the same
   * transaction (outbox) and reaches Kafka shortly after.
   * 409: the Idempotency-Key is in flight or was used for a different request.
   */
  @post
  create(...IdempotencyKey, @body body: CreateTask):
    | {
        @statusCode _: 201;
        /** "true" when the response was replayed for a repeated Idempotency-Key. */
        @header("X-Idempotent-Replayed") replayed?: "true";
        @body task: Task;
      }
    | ProblemResponse<400>
    | ProblemResponse<409>
    | ProblemResponse<413>
    | ProblemResponse<504>;

  /**
   * List tasks, newest first, one page at a time. The query is closed like
   * the bodies: an unknown query parameter is a 400 problem.
   */
  @get
  list(
    /** Rows to skip. */
    @query @minValue(0) offset?: int32 = 0,
    /** Page size; the server default (TASK_LIST_PAGE_SIZE, 50) when absent. */
    @query @minValue(1) @maxValue(1000) limit?: int32,
  ): TaskListPage | ProblemResponse<400> | ProblemResponse<504>;

  /** Fetch one task. */
  @get
  get(@path id: TaskId): Task | ProblemResponse<404> | ProblemResponse<504>;

  /** Change title and/or description with optimistic locking. */
  @patch(#{ implicitOptionality: false })
  update(@path id: TaskId, @body body: UpdateTask):
    | Task
    | ProblemResponse<400>
    | ProblemResponse<404>
    | ProblemResponse<409>
    | ProblemResponse<413>
    | ProblemResponse<504>;

  /** Archive a task (terminal: archiving an archived task is a 409 problem). */
  @post
  @route("/{id}/archive")
  archive(@path id: TaskId, @body body: ArchiveTask):
    | Task
    | ProblemResponse<400>
    | ProblemResponse<404>
    | ProblemResponse<409>
    | ProblemResponse<413>
    | ProblemResponse<504>;
}
