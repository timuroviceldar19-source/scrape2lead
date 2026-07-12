const RECORDS_PER_PAGE = 50;

export function buildGoszakupHtmlPageUrl(
  baseUrl: string,
  pageNum = 0,
  recordsPerPage = RECORDS_PER_PAGE
): string {
  const separator = baseUrl.includes("?") ? "&" : "?";
  const params = `count_record=${recordsPerPage}`;
  if (pageNum <= 0) return `${baseUrl}${separator}${params}`;
  return `${baseUrl}${separator}${params}&page=${pageNum}`;
}
