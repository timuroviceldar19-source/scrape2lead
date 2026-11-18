const KNOWN_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "DOMException",
  "BitrixApiError",
  "FinanceParseError",
  "SalesPultCliError",
  "CrmReadError",
  "BitrixBotError",
  "PortalThrottledError",
  "HtmlBudgetError",
  "GoszakupAuthError",
  "ProcurementHttpError",
  "FullScanLimitError",
  "GzSourceUnavailableError",
  "ZakupRecordNotFoundError",
  "ZakupIncompleteDataError",
  "CaptchaError",
  "BudgetExceededError"
]);

const KNOWN_ERROR_CODES = new Set([
  // Node / fetch / undici / TLS codes
  "ABORT_ERR",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOENT",
  "EACCES",
  "EPERM",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  // Bitrix24 REST API codes
  "QUERY_LIMIT_EXCEEDED",
  "OPERATION_TIME_LIMIT",
  "INTERNAL_SERVER_ERROR",
  "ERROR_CORE",
  "ERROR_METHOD_NOT_FOUND",
  "ERROR_ARGUMENT",
  "ACCESS_DENIED",
  "INVALID_CREDENTIALS",
  "INVALID_REQUEST",
  "NO_AUTH_FOUND",
  "EXPIRED_TOKEN",
  "INSUFFICIENT_SCOPE",
  "WRONG_CLIENT",
  "OVERLOAD_LIMIT"
]);

/**
 * Returns only safe diagnostic metadata (allowlisted error class, numeric HTTP status,
 * and allowlisted error code) without error messages, stacks, response bodies, or
 * arbitrary upstream error fields that may contain names, amounts, or private values.
 */
export function formatSafeErrorStatus(err: unknown): string {
  if (err && typeof err === "object") {
    const anyErr = err as { name?: unknown; status?: unknown; code?: unknown; cause?: unknown };
    const parts: string[] = [];
    const name =
      typeof anyErr.name === "string" && KNOWN_ERROR_NAMES.has(anyErr.name)
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
    if (typeof rawCode === "string" && KNOWN_ERROR_CODES.has(rawCode)) {
      parts.push(`code=${rawCode}`);
    }

    return parts.join(", ");
  }
  return "Error";
}
