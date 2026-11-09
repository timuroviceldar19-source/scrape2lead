import { probeGzPortal } from "../src/kz/gzPortalProbe.js";
try {
  const result = await probeGzPortal();
  console.log(result.line);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.error(`portal probe: error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
