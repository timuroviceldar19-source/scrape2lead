import { probeGzPortal } from "../src/kz/gzPortalProbe.js";
try {
  const result = await probeGzPortal();
  console.log(result.line);
  process.exitCode = result.status === "unreachable" ? 75 : 0;
} catch (error) {
  console.error(`portal probe: error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
