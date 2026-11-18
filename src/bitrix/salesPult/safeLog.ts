/**
 * Returns only safe diagnostic metadata (error class, HTTP status, ASCII error code)
 * without error messages, stacks, response bodies, or payloads that may contain names,
 * amounts, or message contents.
 */
export function formatSafeErrorStatus(err: unknown): string {
  if (err && typeof err === "object") {
    const anyErr = err as { name?: unknown; status?: unknown; code?: unknown; cause?: unknown };
    const parts: string[] = [];
    const name =
      typeof anyErr.name === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(anyErr.name)
        ? anyErr.name
        : "Error";
    parts.push(name);

    if (
      typeof anyErr.status === "number" &&
      Number.isInteger(anyErr.status) &&
      anyErr.status >= 100 &&
      anyErr.status <= 599
    ) {
      parts.push(`HTTP ${anyErr.status}`);
    }

    const rawCode =
      typeof anyErr.code === "string"
        ? anyErr.code
        : anyErr.cause && typeof anyErr.cause === "object"
          ? (anyErr.cause as { code?: unknown }).code
          : undefined;
    if (typeof rawCode === "string" && /^(?=.*[A-Za-z])[A-Za-z0-9_.-]{1,48}$/.test(rawCode)) {
      parts.push(`code=${rawCode}`);
    }

    return parts.join(", ");
  }
  return "Error";
}
