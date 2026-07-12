import path from "node:path";
import dotenv from "dotenv";
import { loadAutomationConfig } from "../src/automation/config.js";
import { readManifest } from "../src/automation/core.js";
import { approveAutomationRun, prepareAutomationRun } from "../src/automation/orchestrator.js";
import { createRealAutomationDependencies } from "../src/automation/realDependencies.js";

dotenv.config();
const USAGE = `Usage:
  npm run automation:prepare [-- --config config/automation.json]
  npm run automation:approve -- --run <run-id> [--config config/automation.json]
  npm run automation:status -- --run <run-id> [--config config/automation.json]`;

interface Args { command: string; configPath: string; runId: string | null; help: boolean }
function parseArgs(argv: string[]): Args {
  const command = argv.shift() ?? "help"; const args: Args = { command, configPath: "config/automation.json", runId: null, help: false };
  for (let i=0;i<argv.length;i++) { const arg=argv[i];
    if (arg === "--config") args.configPath = argv[++i] ?? args.configPath;
    else if (arg === "--run") args.runId = argv[++i] ?? null;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  } return args;
}

async function main(): Promise<void> {
  const args=parseArgs(process.argv.slice(2)); if(args.help||args.command==="help"){console.log(USAGE);return;}
  const config=loadAutomationConfig(args.configPath);
  if(args.command==="prepare"){
    requireEnv("BITRIX24_WEBHOOK_URL");
    const manifest=await prepareAutomationRun(config,createRealAutomationDependencies());
    console.log(`automation prepare: run=${manifest.runId} status=${manifest.status}`);
    console.log(`report=${path.resolve(config.runsDir,manifest.runId,"summary.txt")}`);
    if(manifest.status!=="ready") process.exitCode=1; return;
  }
  if(!args.runId) throw new Error("--run <run-id> is required");
  if(args.command==="status"){
    const manifest=readManifest(path.resolve(config.runsDir,args.runId,"manifest.json")); console.log(JSON.stringify(manifest,null,2)); return;
  }
  if(args.command==="approve"){
    requireEnv("BITRIX24_WEBHOOK_URL"); requireAiEnv();
    const manifest=await approveAutomationRun(config,args.runId,createRealAutomationDependencies());
    console.log(`automation approve: run=${manifest.runId} status=${manifest.status}`);
    if(manifest.status!=="applied") process.exitCode=1; return;
  }
  throw new Error(`unknown automation command: ${args.command}`);
}

function requireEnv(name:string):void{if(!process.env[name]?.trim())throw new Error(`${name} is required`);}
function requireAiEnv():void{
  const provider=(process.env.SPEC_ANALYSIS_PROVIDER??"opencode").toLowerCase();
  if(provider==="anthropic") { if(!process.env.ANTHROPIC_API_KEY?.trim()&&!process.env.CLOUD_API_KEY?.trim()) throw new Error("ANTHROPIC_API_KEY or CLOUD_API_KEY is required"); }
  else if(!process.env.OPENCODE_API_KEY?.trim()&&!process.env.CLOUD_API_KEY?.trim()) throw new Error("OPENCODE_API_KEY or CLOUD_API_KEY is required");
}
main().catch((error)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
