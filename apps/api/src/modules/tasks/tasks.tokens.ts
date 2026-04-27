/**
 * DI tokens whose values are computed at module bootstrap time from
 * configuration. Kept in a sibling file so they don't pollute the domain layer.
 */

export const TASK_LIST_PAGE_SIZE = Symbol("TASK_LIST_PAGE_SIZE");
