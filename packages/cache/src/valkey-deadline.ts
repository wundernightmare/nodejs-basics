/**
 * The request budget (@base/common deadline) for Valkey: a command issued
 * under a deadline is rejected with DeadlineExceededError when the budget is
 * already spent (not sent), or when it runs out before the reply (the reply,
 * if it still comes, is dropped — a Valkey command cannot be cancelled, but
 * the request stops waiting for it). VALKEY_COMMAND_TIMEOUT_MS stays the cap
 * outside a deadline.
 */
import { DeadlineExceededError, remainingMs } from "@base/common";
import type { Redis as Valkey } from "iovalkey";

interface Command {
  promise: Promise<unknown>;
  reject: (err: Error) => void;
}

type SendCommand = (command: Command, stream?: unknown) => unknown;

/** Wraps `client.sendCommand` with the budget; apply after traceValkeyClient. */
export function guardValkeyClient(client: Valkey): Valkey {
  const original = client.sendCommand.bind(client) as unknown as SendCommand;
  const guarded: SendCommand = (command, stream) => {
    const left = remainingMs();
    if (left === undefined) return original(command, stream);
    if (left <= 0) {
      command.reject(new DeadlineExceededError("valkey"));
      return command.promise;
    }
    const timer = setTimeout(() => {
      command.reject(new DeadlineExceededError("valkey"));
    }, left);
    const clear = (): void => {
      clearTimeout(timer);
    };
    command.promise.then(clear, clear);
    return original(command, stream);
  };
  (client as unknown as { sendCommand: SendCommand }).sendCommand = guarded;
  return client;
}
