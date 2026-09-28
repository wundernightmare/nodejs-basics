import "@typespec/json-schema";
import "./tasks.tsp";

using TypeSpec.JsonSchema;

/**
 * Events — the Kafka contract between apps/api (producer, through the outbox)
 * and apps/worker (consumer). JSON on the wire, one JSON Schema per event
 * (api/jsonschema, emitted from here), and TypeScript types generated from
 * those schemas into @base/contracts — the same type on both sides, so the
 * shape cannot drift between two hand-written interfaces. The Go sibling
 * generates its structs from the same kind of file.
 *
 * Compatibility rule: a field may be added as optional; a field is never
 * removed and never changes type — old consumers keep reading new events.
 */
@jsonSchema
namespace TasksEvents;

/** Published to the `tasks.events` topic when a task is created; record key = task id. */
model TaskCreatedEvent {
  /** Event type; one topic may carry several. */
  type: "task.created";

  /** The task's id (also the record key). */
  id: Tasks.TaskId;

  /** Title at creation time. */
  title: string;

  /** Creation time, RFC 3339 UTC. */
  createdAt: utcDateTime;
}
