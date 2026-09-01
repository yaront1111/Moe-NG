/** Loaded into the verified bootstrap process, then supplied to system PowerShell through stdin. */
export const WINDOWS_PROCESS_LEASE_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
$outerText = [Console]::In.ReadToEnd()
$outer = $outerText | ConvertFrom-Json
$names = @($outer.PSObject.Properties.Name | Sort-Object)
if (($names -join [char]0) -ne (@('controlToken','digest','request','source') -join [char]0)) {
  throw 'PACK_WINDOWS_LEASE_FAILED'
}
try {
  Add-Type -ReferencedAssemblies 'System.Web.Extensions.dll' -TypeDefinition ([string]$outer.source)
  $result = [MoePackLease]::Run([string]$outer.request, [string]$outer.digest)
  $size = if ($null -eq $result.sha256) { '-' } else { $result.size.ToString([Globalization.CultureInfo]::InvariantCulture) }
  $sha256 = if ($null -eq $result.sha256) { '-' } else { $result.sha256 }
  $controlReceipt = ([char]30) + 'moe-windows-process-lease/2:' + [string]$outer.controlToken + ':' + $result.status.ToString([Globalization.CultureInfo]::InvariantCulture) + ':' + $size + ':' + $sha256
  [Console]::Out.WriteLine($controlReceipt)
  exit 0
} catch {
  [Console]::Error.WriteLine('PACK_WINDOWS_LEASE_FAILED')
  exit 125
}
`;

export const WINDOWS_PROCESS_LEASE_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public static class MoePackLease {
  const uint GENERIC_READ = 0x80000000;
  const uint FILE_LIST_DIRECTORY = 0x1;
  const uint FILE_READ_ATTRIBUTES = 0x80;
  const uint SHARE_READ = 0x1;
  const uint SHARE_WRITE = 0x2;
  const uint OPEN_EXISTING = 3;
  const uint BACKUP_SEMANTICS = 0x02000000;
  const uint OPEN_REPARSE_POINT = 0x00200000;
  const uint REPARSE_ATTRIBUTE = 0x400;
  const uint DIRECTORY_ATTRIBUTE = 0x10;
  const uint CREATE_SUSPENDED = 0x4;
  const uint STARTF_USESTDHANDLES = 0x100;
  const uint JOB_KILL_ON_CLOSE = 0x2000;
  const uint WAIT_OBJECT_0 = 0;
  const uint WAIT_TIMEOUT = 258;
  const int JOB_EXTENDED_LIMIT = 9;
  const int JOB_BASIC_ACCOUNTING = 1;
  static readonly IntPtr INVALID_HANDLE = new IntPtr(-1);

  public sealed class Request {
    public string schemaVersion { get; set; }
    public string executable { get; set; }
    public string cwd { get; set; }
    public string[] args { get; set; }
    public int timeoutMs { get; set; }
    public Entry[] locks { get; set; }
    public ObservationRequest observation { get; set; }
  }

  public sealed class ObservationRequest {
    public string root { get; set; }
    public string dist { get; set; }
    public string archive { get; set; }
    public string marker { get; set; }
    public string control { get; set; }
    public long maxBytes { get; set; }
  }

  public sealed class Result {
    public uint status { get; set; }
    public long size { get; set; }
    public string sha256 { get; set; }
  }

  public sealed class Entry {
    public string path { get; set; }
    public string kind { get; set; }
    public string dev { get; set; }
    public string ino { get; set; }
    public long size { get; set; }
    public string sha256 { get; set; }
  }

  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)] struct FILE_INFO {
    public uint Attributes; public FILETIME Creation; public FILETIME Access; public FILETIME Write;
    public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links;
    public uint IndexHigh; public uint IndexLow;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public uint cb; public string reserved; public string desktop; public string title;
    public uint x; public uint y; public uint xSize; public uint ySize;
    public uint xChars; public uint yChars; public uint fill; public uint flags;
    public ushort show; public ushort reserved2; public IntPtr reservedPointer;
    public IntPtr stdin; public IntPtr stdout; public IntPtr stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
    public IntPtr process; public IntPtr thread; public uint processId; public uint threadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_ACCOUNTING {
    public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime; public uint TotalPageFaultCount;
    public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(IntPtr handle, out FILE_INFO info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info,
    uint length, out uint returnedLength);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessW(string application, StringBuilder commandLine,
    IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
    IntPtr environment, string currentDirectory, ref STARTUPINFO startup,
    out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int which);

  static void Require(bool answer) { if (!answer) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static ulong FileIndex(FILE_INFO info) { return ((ulong)info.IndexHigh << 32) | info.IndexLow; }
  static long FileSize(FILE_INFO info) { return (long)(((ulong)info.SizeHigh << 32) | info.SizeLow); }
  static string Hex(byte[] bytes) { return String.Concat(bytes.Select(b => b.ToString("x2"))); }

  static string HashHandle(IntPtr handle) {
    using (var safe = new SafeFileHandle(handle, false))
    using (var stream = new FileStream(safe, FileAccess.Read, 65536, false))
    using (var sha = SHA256.Create()) {
      stream.Position = 0;
      return Hex(sha.ComputeHash(stream));
    }
  }

  static IntPtr Lock(Entry entry) {
    bool directory = entry.kind == "directory";
    uint access = directory ? FILE_READ_ATTRIBUTES : GENERIC_READ;
    uint share = directory ? SHARE_READ | SHARE_WRITE : SHARE_READ;
    uint flags = OPEN_REPARSE_POINT | (directory ? BACKUP_SEMANTICS : 0);
    IntPtr handle = CreateFileW(entry.path, access, share, IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
    if (handle == INVALID_HANDLE) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      FILE_INFO info; Require(GetFileInformationByHandle(handle, out info));
      if ((info.Attributes & REPARSE_ATTRIBUTE) != 0 || info.Volume.ToString() != entry.dev
        || FileIndex(info).ToString() != entry.ino) throw new InvalidDataException();
      if (directory) {
        if (entry.size != 0 || entry.sha256 != "") throw new InvalidDataException();
      } else {
        if (info.Links != 1 || FileSize(info) != entry.size
          || HashHandle(handle) != entry.sha256) throw new InvalidDataException();
      }
      return handle;
    } catch { CloseHandle(handle); throw; }
  }

  static bool SamePath(string left, string right) {
    return String.Equals(Path.GetFullPath(left), Path.GetFullPath(right),
      StringComparison.OrdinalIgnoreCase);
  }

  static void RequireSameIdentity(IntPtr left, IntPtr right) {
    FILE_INFO leftInfo, rightInfo;
    Require(GetFileInformationByHandle(left, out leftInfo));
    Require(GetFileInformationByHandle(right, out rightInfo));
    if (leftInfo.Volume != rightInfo.Volume || FileIndex(leftInfo) != FileIndex(rightInfo)) {
      throw new InvalidDataException();
    }
  }

  static IntPtr OpenStrictDirectory(string path, IntPtr expected) {
    IntPtr handle = CreateFileW(path, FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY, SHARE_READ,
      IntPtr.Zero, OPEN_EXISTING, BACKUP_SEMANTICS | OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle == INVALID_HANDLE) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      FILE_INFO info; Require(GetFileInformationByHandle(handle, out info));
      if ((info.Attributes & REPARSE_ATTRIBUTE) != 0
        || (info.Attributes & DIRECTORY_ATTRIBUTE) == 0) throw new InvalidDataException();
      if (expected != IntPtr.Zero) RequireSameIdentity(handle, expected);
      return handle;
    } catch { CloseHandle(handle); throw; }
  }

  static Result ObserveCandidate(ObservationRequest observation,
    Dictionary<string, IntPtr> heldByPath, uint status) {
    if (observation == null || observation.maxBytes < 1 || observation.maxBytes > 536870912
      || String.IsNullOrEmpty(observation.root) || String.IsNullOrEmpty(observation.dist)
      || String.IsNullOrEmpty(observation.archive) || String.IsNullOrEmpty(observation.marker)
      || String.IsNullOrEmpty(observation.control)
      || !Path.IsPathRooted(observation.root) || !Path.IsPathRooted(observation.dist)
      || !Path.IsPathRooted(observation.archive) || !Path.IsPathRooted(observation.marker)
      || !Path.IsPathRooted(observation.control)
      || observation.root.StartsWith("\\\\", StringComparison.Ordinal)
      || !SamePath(observation.dist, Path.Combine(observation.root, "dist"))
      || !SamePath(observation.archive, Path.Combine(observation.dist, "moe-windows.zip"))
      || !SamePath(observation.marker, Path.Combine(observation.root, ".moe-windows-candidate-owner"))
      || !SamePath(Path.GetDirectoryName(observation.control), observation.root)
      || !Path.GetFileName(observation.control).StartsWith(".moe-pack-toolchain-", StringComparison.Ordinal)
      || !heldByPath.ContainsKey(observation.root) || !heldByPath.ContainsKey(observation.marker)
      || !heldByPath.ContainsKey(observation.control)) throw new InvalidDataException();
    IntPtr root = IntPtr.Zero, dist = IntPtr.Zero, archive = IntPtr.Zero;
    try {
      root = OpenStrictDirectory(observation.root, heldByPath[observation.root]);
      dist = OpenStrictDirectory(observation.dist, IntPtr.Zero);
      string[] rootItems = Directory.GetFileSystemEntries(observation.root).Select(Path.GetFileName)
        .OrderBy(x => x, StringComparer.Ordinal).ToArray();
      string[] expectedRoot = new [] {
        Path.GetFileName(observation.control), ".moe-windows-candidate-owner", "dist",
      }.OrderBy(x => x, StringComparer.Ordinal).ToArray();
      string[] distItems = Directory.GetFileSystemEntries(observation.dist).Select(Path.GetFileName)
        .OrderBy(x => x, StringComparer.Ordinal).ToArray();
      if (!rootItems.SequenceEqual(expectedRoot)
        || !distItems.SequenceEqual(new [] { "moe-windows.zip" })) throw new InvalidDataException();
      archive = CreateFileW(observation.archive, GENERIC_READ, SHARE_READ, IntPtr.Zero,
        OPEN_EXISTING, OPEN_REPARSE_POINT, IntPtr.Zero);
      if (archive == INVALID_HANDLE) throw new Win32Exception(Marshal.GetLastWin32Error());
      FILE_INFO info; Require(GetFileInformationByHandle(archive, out info));
      long size = FileSize(info);
      if ((info.Attributes & (REPARSE_ATTRIBUTE | DIRECTORY_ATTRIBUTE)) != 0
        || info.Links != 1 || size < 1 || size > observation.maxBytes) throw new InvalidDataException();
      return new Result { status = status, size = size, sha256 = HashHandle(archive) };
    } finally {
      if (archive != IntPtr.Zero && archive != INVALID_HANDLE) CloseHandle(archive);
      if (dist != IntPtr.Zero && dist != INVALID_HANDLE) CloseHandle(dist);
      if (root != IntPtr.Zero && root != INVALID_HANDLE) CloseHandle(root);
    }
  }

  static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new [] {' ', '\t', '\n', '\v', '"'}) < 0) return value;
    var answer = new StringBuilder(); answer.Append('"'); int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes += 1; continue; }
      if (character == '"') { answer.Append('\\', slashes * 2 + 1); answer.Append('"'); slashes = 0; continue; }
      answer.Append('\\', slashes); slashes = 0; answer.Append(character);
    }
    answer.Append('\\', slashes * 2); answer.Append('"'); return answer.ToString();
  }

  static uint ActiveProcesses(IntPtr job) {
    int size = Marshal.SizeOf(typeof(BASIC_ACCOUNTING)); IntPtr memory = Marshal.AllocHGlobal(size);
    try {
      uint returned; Require(QueryInformationJobObject(job, JOB_BASIC_ACCOUNTING,
        memory, (uint)size, out returned));
      return ((BASIC_ACCOUNTING)Marshal.PtrToStructure(memory, typeof(BASIC_ACCOUNTING))).ActiveProcesses;
    } finally { Marshal.FreeHGlobal(memory); }
  }

  static uint Spawn(Request request) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Win32Exception();
    PROCESS_INFORMATION child = new PROCESS_INFORMATION(); bool childCreated = false;
    try {
      var limits = new EXTENDED_LIMIT(); limits.BasicLimitInformation.LimitFlags = JOB_KILL_ON_CLOSE;
      int size = Marshal.SizeOf(typeof(EXTENDED_LIMIT)); IntPtr memory = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(limits, memory, false);
        Require(SetInformationJobObject(job, JOB_EXTENDED_LIMIT, memory, (uint)size));
      } finally { Marshal.FreeHGlobal(memory); }
      var startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
      startup.flags = STARTF_USESTDHANDLES; startup.stdin = GetStdHandle(-10);
      startup.stdout = GetStdHandle(-11); startup.stderr = GetStdHandle(-12);
      var command = new StringBuilder(Quote(request.executable));
      foreach (string arg in request.args) command.Append(' ').Append(Quote(arg));
      Require(CreateProcessW(request.executable, command, IntPtr.Zero, IntPtr.Zero, true,
        CREATE_SUSPENDED, IntPtr.Zero, request.cwd, ref startup, out child)); childCreated = true;
      Require(AssignProcessToJobObject(job, child.process));
      if (ResumeThread(child.thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint wait = WaitForSingleObject(child.process, (uint)request.timeoutMs);
      if (wait == WAIT_TIMEOUT) { TerminateJobObject(job, 124); throw new TimeoutException(); }
      if (wait != WAIT_OBJECT_0) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint exitCode; Require(GetExitCodeProcess(child.process, out exitCode));
      Require(TerminateJobObject(job, exitCode));
      var deadline = DateTime.UtcNow.AddSeconds(10);
      while (ActiveProcesses(job) != 0) {
        if (DateTime.UtcNow >= deadline) throw new TimeoutException(); Thread.Sleep(10);
      }
      return exitCode;
    } finally {
      if (childCreated) { CloseHandle(child.thread); CloseHandle(child.process); }
      CloseHandle(job);
    }
  }

  public static Result Run(string requestJson, string expectedDigest) {
    var held = new List<IntPtr>();
    var heldByPath = new Dictionary<string, IntPtr>(StringComparer.OrdinalIgnoreCase);
    try {
      using (var sha = SHA256.Create()) {
        if (Hex(sha.ComputeHash(Encoding.UTF8.GetBytes(requestJson))) != expectedDigest) throw new InvalidDataException();
      }
      var serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = 64 * 1024 * 1024;
      var map = serializer.Deserialize<Dictionary<string, object>>(requestJson);
      var expected = new [] {
        "args", "cwd", "executable", "locks", "observation", "schemaVersion", "timeoutMs",
      };
      if (map == null || !map.Keys.OrderBy(x => x).SequenceEqual(expected)) throw new InvalidDataException();
      Request request = serializer.Deserialize<Request>(requestJson);
      if (request == null || request.schemaVersion != "moe-windows-process-lease/2"
        || request.args == null || request.locks == null || request.locks.Length == 0
        || request.locks.Length > 30000 || request.timeoutMs < 1 || request.timeoutMs > 1800000
        || String.IsNullOrEmpty(request.executable) || String.IsNullOrEmpty(request.cwd)) throw new InvalidDataException();
      foreach (Entry entry in request.locks.OrderBy(e => e.kind == "directory" ? 0 : 1)
        .ThenBy(e => e.path.Length).ThenBy(e => e.path, StringComparer.OrdinalIgnoreCase)) {
        if (entry == null || (entry.kind != "directory" && entry.kind != "file")
          || String.IsNullOrEmpty(entry.path) || !Path.IsPathRooted(entry.path)
          || entry.path.StartsWith("\\\\", StringComparison.Ordinal)) throw new InvalidDataException();
        IntPtr handle = Lock(entry); held.Add(handle); heldByPath.Add(entry.path, handle);
      }
      uint status = Spawn(request);
      foreach (Entry entry in request.locks.Where(e => e.kind == "file")) {
        IntPtr handle = heldByPath[entry.path];
        if (HashHandle(handle) != entry.sha256) throw new InvalidDataException();
      }
      if (status == 0 && request.observation != null) {
        return ObserveCandidate(request.observation, heldByPath, status);
      }
      return new Result { status = status, size = 0, sha256 = null };
    } finally {
      for (int index = held.Count - 1; index >= 0; index--) CloseHandle(held[index]);
    }
  }
}
`;
