import { spawn } from "node:child_process";

const configPath = process.argv[2];
if (!configPath) {
  console.error("usage: tsx scripts/kz-direct-scrape.mts <config.json>");
  process.exit(1);
}

const env = { ...process.env };
env.PROXY_SERVER = "";
env.PROXY_API_URL = "";
env.PROXY_USERNAME = "";
env.PROXY_PASSWORD = "";

console.log(`direct scrape (no proxy): ${configPath}`);

const code = await new Promise<number>((resolve, reject) => {
  const child = spawn("npm", ["run", "dev", "--", "--config", configPath], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: true,
    env
  });
  child.on("error", reject);
  child.on("exit", (exitCode) => resolve(exitCode ?? 1));
});

process.exit(code);
