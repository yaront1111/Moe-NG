/** Constant observer code. No caller value is interpolated into C# or PowerShell. */
export const PROJECT_REVIEW_DRAIN_NATIVE = String.raw`
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
public sealed class MoeDrainFailure : Exception {
 public readonly string Code;
 public MoeDrainFailure(string code) { Code=code; }
}
public sealed class MoeDrainEvidence {
 public uint controllerPid,brokerPid,cliPid,daemonPid;
 public string controllerStartedAt,brokerStartedAt,observedAt;
 public bool jobEmpty=true;
}
public static class MoeReviewDrain {
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long born,out long exit,out long kernel,out long user);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder name,ref uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr copy,uint access,bool inherit,uint options);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr buffer,uint length,out uint used);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint exitCode);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint exitCode);
 [DllImport("kernelbase.dll",SetLastError=true)] static extern bool CompareObjectHandles(IntPtr first,IntPtr second);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint millis);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int kind,IntPtr buffer,int length,out int used);
 [DllImport("ntdll.dll")] static extern int NtQueryObject(IntPtr handle,int kind,IntPtr buffer,int length,out int used);
 [DllImport("shell32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command,out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr handle);
 const string Identity="RUNTIME_REVIEW_DRAIN_IDENTITY_MISMATCH",Unknown="RUNTIME_REVIEW_DRAIN_UNPROVEN";
 static readonly List<IntPtr> held=new List<IntPtr>();
 static IntPtr job=IntPtr.Zero;
 static Task<string> closeRequest;
 static void Need(bool value,string code) { if(!value) throw new MoeDrainFailure(code); }
 static void Win(bool value) { if(!value) throw new MoeDrainFailure(Marshal.GetLastWin32Error()==5?"RUNTIME_REVIEW_DRAIN_ACCESS_DENIED":Unknown); }
 static IntPtr Open(uint pid,uint extra) {
  IntPtr h=OpenProcess(0x101000|extra,false,pid); Win(h!=IntPtr.Zero); held.Add(h);
  Need(GetProcessId(h)==pid,Identity); Need(WaitForSingleObject(h,0)==258,Identity); return h;
 }
 static long Born(IntPtr h) { long born,exit,kernel,user; Win(GetProcessTimes(h,out born,out exit,out kernel,out user)); return born; }
 static uint Parent(IntPtr h) {
  int size=IntPtr.Size*6,used; IntPtr data=Marshal.AllocHGlobal(size);
  try { Need(NtQueryInformationProcess(h,0,data,size,out used)==0,Unknown);
   long parent=Marshal.ReadIntPtr(data,IntPtr.Size*5).ToInt64(); Need(parent>0&&parent<=uint.MaxValue,Identity); return (uint)parent;
  } finally { Marshal.FreeHGlobal(data); }
 }
 static string Image(IntPtr h) { uint size=32768; var name=new StringBuilder((int)size); Win(QueryFullProcessImageName(h,0,name,ref size)); return name.ToString(); }
 static void SingleProject(IntPtr cli,string node,string workspace) {
  int used; IntPtr buffer=Marshal.AllocHGlobal(131072),args=IntPtr.Zero;
  try {
   Need(NtQueryInformationProcess(cli,60,buffer,131072,out used)==0,Unknown);
   int bytes=(ushort)Marshal.ReadInt16(buffer); IntPtr text=Marshal.ReadIntPtr(buffer,IntPtr.Size);
   long offset=text.ToInt64()-buffer.ToInt64();
   Need(bytes>0&&bytes%2==0&&offset>=IntPtr.Size*2&&offset+bytes<=131072,Unknown);
   string command=Marshal.PtrToStringUni(text,bytes/2); int count;
   args=CommandLineToArgvW(command,out count); Win(args!=IntPtr.Zero);
   Need(count>=4&&count<=6,Identity); var argv=new string[count];
   for(int i=0;i<count;i++) argv[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(args,i*IntPtr.Size));
   int script=argv[1]=="--experimental-transform-types"?2:1;
   Need(count==script+3||(count==script+4&&argv[count-1]=="--operator-stdin"),Identity);
   Need(String.Equals(Path.GetFullPath(argv[0]),node,StringComparison.OrdinalIgnoreCase)
    &&Path.IsPathRooted(argv[script])&&argv[script].Replace('/','\\').EndsWith("\\apps\\daemon\\src\\cli\\moe-cli-main.ts",StringComparison.OrdinalIgnoreCase)
    &&(argv[script+1]=="start"||argv[script+1]=="recover-review")&&Path.IsPathRooted(argv[script+2])
    &&String.Equals(Path.GetFullPath(argv[script+2]).TrimEnd('\\'),Path.GetFullPath(workspace).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase),Identity);
  } finally { if(args!=IntPtr.Zero) LocalFree(args); Marshal.FreeHGlobal(buffer); }
 }
 static bool Member(IntPtr process,IntPtr candidate) { bool yes; Win(IsProcessInJob(process,candidate,out yes)); return yes; }
 static uint JobInfo(IntPtr candidate,int kind,int size,int offset) {
  uint used; IntPtr data=Marshal.AllocHGlobal(size);
  try { Win(QueryInformationJobObject(candidate,kind,data,(uint)size,out used)); return (uint)Marshal.ReadInt32(data,offset); }
  finally { Marshal.FreeHGlobal(data); }
 }
 static bool IsJob(IntPtr candidate) {
  uint used; IntPtr data=Marshal.AllocHGlobal(48);
  try { return QueryInformationJobObject(candidate,1,data,48,out used); }
  finally { Marshal.FreeHGlobal(data); }
 }
 public class NativeCalls {
  public virtual IntPtr Acquire(IntPtr broker,IntPtr original) {
   IntPtr drain; Win(DuplicateHandle(broker,original,GetCurrentProcess(),out drain,12,false,0)); return drain;
  }
  public virtual uint Active(IntPtr candidate) { return JobInfo(candidate,1,48,40); }
 }
 static void DrainRights(IntPtr handle) {
  IntPtr data=Marshal.AllocHGlobal(56); int used;
  try { Need(NtQueryObject(handle,0,data,56,out used)==0,Unknown);
   Need(((uint)Marshal.ReadInt32(data,4)&12)==12,"RUNTIME_REVIEW_DRAIN_ACCESS_DENIED");
  } finally { Marshal.FreeHGlobal(data); }
 }
 static IntPtr FindJob(IntPtr broker,IntPtr cli,IntPtr daemon,IntPtr controller,NativeCalls calls) {
  int size=16384,used,status; IntPtr table=IntPtr.Zero,match=IntPtr.Zero,originalMatch=IntPtr.Zero;
  try {
   while(true) {
    if(table!=IntPtr.Zero) Marshal.FreeHGlobal(table);
    table=Marshal.AllocHGlobal(size); status=NtQueryInformationProcess(broker,51,table,size,out used);
    if(status==0) break;
    Need(status==unchecked((int)0xC0000004)||status==unchecked((int)0xC0000023),Unknown);
    size=Math.Max(size*2,used); Need(size<=1048576,Unknown);
   }
   long count=Marshal.ReadIntPtr(table).ToInt64(); int stride=IntPtr.Size*3+16;
   Need(count>=0&&count<=4096&&IntPtr.Size*2+count*stride<=size,Unknown);
   for(int i=0;i<count;i++) {
    IntPtr original=Marshal.ReadIntPtr(table,IntPtr.Size*2+i*stride),copy;
    // QUERY only; no source-close flag, no inheritable or assignment/termination handle.
    if(!DuplicateHandle(broker,original,GetCurrentProcess(),out copy,4,false,0)) continue;
    try {
     if(!IsJob(copy)||!Member(daemon,copy)||!Member(controller,copy)) continue;
     Need(!Member(cli,copy)&&!Member(broker,copy)&&!Member(GetCurrentProcess(),copy),Identity);
     Need(JobInfo(copy,9,IntPtr.Size==8?144:112,16)==0x2000,Identity);
     Need(match==IntPtr.Zero,Identity); match=copy; originalMatch=original; copy=IntPtr.Zero;
    } finally { if(copy!=IntPtr.Zero) CloseHandle(copy); }
   }
   Need(match!=IntPtr.Zero,Identity);
   // Obtain QUERY|TERMINATE BEFORE stopping anything. Reuse of the broker's raw handle
   // cannot switch our authority to another Job: compare the two retained kernel objects.
   IntPtr drain=calls.Acquire(broker,originalMatch);
   try { Need(CompareObjectHandles(match,drain),Identity); DrainRights(drain); IntPtr found=drain; drain=IntPtr.Zero; return found; }
   finally { if(drain!=IntPtr.Zero) CloseHandle(drain); }
  } finally { if(table!=IntPtr.Zero) Marshal.FreeHGlobal(table); if(match!=IntPtr.Zero) CloseHandle(match); }
 }
 static string Stamp(long value) { return DateTime.FromFileTimeUtc(value).ToString("yyyy-MM-ddTHH:mm:ss.fffZ",CultureInfo.InvariantCulture); }
 static bool Closed(IntPtr h) { uint state=WaitForSingleObject(h,0); Need(state==0||state==258,Unknown); return state==0; }
 public static MoeDrainEvidence Drain(uint controllerPid,string notStartedAfter,string workspace) {
  return DrainUsing(controllerPid,notStartedAfter,workspace,new NativeCalls());
 }
 public static MoeDrainEvidence DrainUsing(uint controllerPid,string notStartedAfter,string workspace,NativeCalls calls) {
  Need(IntPtr.Size==8,Unknown);
  long cutoff=DateTimeOffset.Parse(notStartedAfter,CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind).UtcDateTime.ToFileTimeUtc();
  IntPtr controller=Open(controllerPid,0); long controllerBorn=Born(controller);
  Need(controllerBorn<=cutoff,Identity);
  uint daemonPid=Parent(controller); IntPtr daemon=Open(daemonPid,0); long daemonBorn=Born(daemon);
  uint brokerPid=Parent(daemon); IntPtr broker=Open(brokerPid,0x440); long brokerBorn=Born(broker);
  uint cliPid=Parent(broker); IntPtr cli=Open(cliPid,1); long cliBorn=Born(cli);
  Need(new HashSet<uint>(new uint[]{controllerPid,daemonPid,brokerPid,cliPid}).Count==4,Identity);
  Need(cliBorn<=brokerBorn&&brokerBorn<=daemonBorn&&daemonBorn<=controllerBorn,Identity);
  string node=Image(controller);
  Need(String.Equals(Path.GetFileName(node),"node.exe",StringComparison.OrdinalIgnoreCase)
   &&String.Equals(node,Image(daemon),StringComparison.OrdinalIgnoreCase)
   &&String.Equals(node,Image(cli),StringComparison.OrdinalIgnoreCase)
   &&String.Equals(Path.GetFileName(Image(broker)),"moe-windows-job-broker.exe",StringComparison.OrdinalIgnoreCase),Identity);
  SingleProject(cli,node,workspace);
  job=FindJob(broker,cli,daemon,controller,calls);
  // Console's synchronized reader can implement ReadLineAsync synchronously on .NET Framework.
  closeRequest=Task.Run(()=>Console.In.ReadLine());
  Need(!closeRequest.IsCompleted,Unknown);
  // Stop only the pinned single-project CLI and its verified exact Job. Parent loss can
  // exit the broker before it drains; a retained Job handle delays kill-on-close.
  Win(TerminateProcess(cli,1));
  Win(TerminateJobObject(job,1));
  DateTime until=DateTime.UtcNow.AddSeconds(20);
  while(DateTime.UtcNow<until) {
   Need(!closeRequest.IsCompleted,Unknown);
   uint active=calls.Active(job);
   if(active==0&&Closed(cli)&&Closed(broker)&&Closed(daemon)&&Closed(controller))
    return new MoeDrainEvidence {controllerPid=controllerPid,controllerStartedAt=Stamp(controllerBorn),brokerPid=brokerPid,
     brokerStartedAt=Stamp(brokerBorn),cliPid=cliPid,daemonPid=daemonPid,observedAt=DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ",CultureInfo.InvariantCulture)};
   Thread.Sleep(25);
  }
  throw new MoeDrainFailure(Unknown);
 }
 public static bool Hold() { return closeRequest.GetAwaiter().GetResult()=="CLOSE"; }
 public static void Close() {
  // Always relinquish our retained handle: retaining it would delay the broker's crash safety.
  if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; }
  foreach(IntPtr h in held) CloseHandle(h); held.Clear();
 }
}
`;
