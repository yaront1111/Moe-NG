import { describeThrown } from "@moe/contracts";

/**
 * THE ONE SENTENCE AN OPERATOR NEEDS WHEN A BIND FAILS.
 *
 * Every bind refusal in this daemon collapsed to a single token —
 * `LISTENER_BIND_FAILED CONTROL_ROOM_LISTENER`, `MCP_HTTP_HOST_BIND_FAILED` — with the errno
 * discarded by an unbound `} catch {`. A port held by another daemon, a privileged port, and a
 * host that no longer resolves each demand a different action and were indistinguishable.
 *
 * The output is a REFUSAL DETAIL, not a log line: it is printed to the operator and travels in a
 * refusal record, so it is one line, carries no stack, and names only address facts. The stack
 * and the cause chain belong in the diagnostic record beside it.
 *
 * Shaped after Node's own bind message (`listen EADDRINUSE 127.0.0.1:8080`) because that is the
 * string operators already recognise and already search for.
 */

/** The port the CALLER asked for, which is what they can act on — not the one the error echoes. */
function addressOf(host: string, port: number | undefined): string {
  // `0` means "any free port", so the number is meaningless to a reader; say what it meant.
  return `${host}:${port === undefined || port === 0 ? "ephemeral" : String(port)}`;
}

function syscallOf(value: unknown): string {
  if (value === null || typeof value !== "object") return "listen";
  try {
    const syscall = (value as { syscall?: unknown }).syscall;
    return typeof syscall === "string" && syscall !== "" ? syscall : "listen";
  } catch {
    // A hostile accessor answers nothing; the default names the only syscall this path makes.
    return "listen";
  }
}

export function describeBindFailure(
  error: unknown, host: string, port: number | undefined,
): string {
  const facts = describeThrown(error);
  const address = addressOf(host, port);
  const syscall = syscallOf(error);
  if (facts.code !== null) return `${syscall} ${facts.code} ${address}`;
  // No errno: the throw came from argument validation or from a layer above the socket, so the
  // constructor name and message are the only discriminator there is. Flattened to one line.
  const message = facts.message.replaceAll(/[\p{Cc}\p{Cf}]/gu, " ").trim();
  return `${syscall} failed ${address} (${facts.name}: ${message})`;
}
