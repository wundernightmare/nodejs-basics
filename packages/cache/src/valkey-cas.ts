export type CompareAndSetMode = "ifeq" | "lua";

export interface ValkeyCasClient {
  call(...args: Array<string | number>): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

const REPLACE_LUA = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call("SET", KEYS[1], ARGV[2], "PX", ARGV[3])
return 1
`;

/** Atomically replaces key only while it still holds old, with a TTL in milliseconds. */
export async function compareAndSet(
  client: ValkeyCasClient,
  mode: CompareAndSetMode,
  key: string,
  old: string,
  value: string,
  ttlMs: number,
): Promise<boolean> {
  const px = Math.max(1, Math.ceil(ttlMs));
  if (mode === "lua") {
    return (await client.eval(REPLACE_LUA, 1, key, old, value, px)) === 1;
  }
  return (await client.call("SET", key, value, "IFEQ", old, "PX", px)) === "OK";
}
