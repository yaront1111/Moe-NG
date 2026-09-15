import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { PROJECT_REVIEW_DRAIN_NATIVE } from "./project-review-drain-native.js";
import { PROJECT_REVIEW_DRAIN_SCRIPT } from "./project-review-drain-script.js";
import { decodeProjectReviewDrainFrame } from "./project-review-drain.js";

// Fault only the Win32 calls, while retaining the actual production identity join, exact private
// broker Job enumeration, real object handles, process-stop cutoff, and result decoder.
const FAULT_CALLS = String.raw`
public sealed class MoeDrainFaultCalls : MoeReviewDrain.NativeCalls {
 readonly string fault; int samples;
 public MoeDrainFaultCalls(string value) { fault=value; }
 [System.Runtime.InteropServices.DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(System.IntPtr source,System.IntPtr handle,System.IntPtr target,out System.IntPtr copy,uint access,bool inherit,uint options);
 [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern System.IntPtr GetCurrentProcess();
 public override System.IntPtr Acquire(System.IntPtr broker,System.IntPtr original) {
  if(fault=="access-denied") throw new MoeDrainFailure("RUNTIME_REVIEW_DRAIN_ACCESS_DENIED");
  if(fault=="query-only") {
   System.IntPtr query;
   if(!DuplicateHandle(broker,original,GetCurrentProcess(),out query,4,false,0)) throw new MoeDrainFailure("RUNTIME_REVIEW_DRAIN_UNPROVEN");
   return query;
  }
  return base.Acquire(broker,original);
 }
 public override uint Active(System.IntPtr job) {
  if(fault=="active-members"&&samples++==0) return 1;
  if(fault=="query-failed"||fault=="active-members") throw new MoeDrainFailure("RUNTIME_REVIEW_DRAIN_UNPROVEN");
  return base.Active(job);
 }
}
`;

export async function drainWithNativeFault(input: { controllerPid: number; notStartedAfter: string; workspace: string }, fault: string) {
  const call = "[MoeReviewDrain]::Drain([uint32]$request.controllerPid,[string]$request.notStartedAfter,[string]$request.workspace)";
  if (!PROJECT_REVIEW_DRAIN_SCRIPT.includes(call)) throw new Error("NATIVE_FAULT_ENTRY_CHANGED");
  const script = PROJECT_REVIEW_DRAIN_SCRIPT.replace(call,
    "[MoeReviewDrain]::DrainUsing([uint32]$request.controllerPid,[string]$request.notStartedAfter,[string]$request.workspace,[MoeDrainFaultCalls]::new([string]$wire.fault))");
  const child = spawn(win32.join(process.env["SystemRoot"]!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: "pipe" });
  let output = ""; let drainSent = false;
  // The observer compiles first and stops nothing until it is told DRAIN (the production protocol).
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (!drainSent && output.split("\n").some((line) => line.trim() === '{"ready":true}')) { drainSent = true; child.stdin.write("DRAIN\n"); }
  });
  child.stderr.on("data", () => {});
  child.stdin.on("error", () => {});
  const closed = new Promise<void>((done) => { child.once("close", () => { done(); }); });
  const timer = setTimeout(() => { child.stdin.end("CLOSE\n"); child.kill(); }, 150_000);
  try {
    child.stdin.write(`${JSON.stringify({ input, fault, nativeSource: `${PROJECT_REVIEW_DRAIN_NATIVE}\n${FAULT_CALLS}` })}\n`);
    await closed;
    const frames = output.split("\n").map((line) => line.trim()).filter((line) => line !== "" && line !== '{"ready":true}');
    return decodeProjectReviewDrainFrame(JSON.parse(frames.at(-1) ?? "null"), input);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
}
