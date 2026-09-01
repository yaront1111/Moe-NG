export const WINDOWS_PUBLICATION_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
$outer = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
$names = @($outer.PSObject.Properties.Name | Sort-Object)
if (($names -join [char]0) -ne (@('digest','request','source') -join [char]0)) {
  throw 'PACK_WINDOWS_PUBLICATION_FAILED'
}
Add-Type -ReferencedAssemblies 'System.Web.Extensions.dll' -TypeDefinition ([string]$outer.source)
[MoePackPublication]::Run([string]$outer.request, [string]$outer.digest)
`;

export const WINDOWS_PUBLICATION_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public static class MoePackPublication {
  const uint GENERIC_READ = 0x80000000;
  const uint GENERIC_WRITE = 0x40000000;
  const uint DELETE = 0x00010000;
  const uint FILE_LIST_DIRECTORY = 0x1;
  const uint FILE_TRAVERSE = 0x20;
  const uint FILE_READ_ATTRIBUTES = 0x80;
  const uint SHARE_READ = 0x1;
  const uint SHARE_WRITE = 0x2;
  const uint SHARE_DELETE = 0x4;
  const uint OPEN_EXISTING = 3;
  const uint CREATE_NEW = 1;
  const uint BACKUP_SEMANTICS = 0x02000000;
  const uint OPEN_REPARSE_POINT = 0x00200000;
  const uint REPARSE_ATTRIBUTE = 0x400;
  const int FILE_DISPOSITION_INFO_CLASS = 4;
  const int FILE_RENAME_INFO_CLASS = 3;
  static readonly IntPtr INVALID_HANDLE = new IntPtr(-1);

  public sealed class Request {
    public string schemaVersion { get; set; }
    public string candidateRoot { get; set; }
    public string candidateDist { get; set; }
    public string candidateArchive { get; set; }
    public string marker { get; set; }
    public string token { get; set; }
    public string outputRoot { get; set; }
    public string outputDist { get; set; }
    public string temporaryName { get; set; }
    public string finalName { get; set; }
    public string sha256 { get; set; }
    public long size { get; set; }
    public Entry[] directories { get; set; }
    public Entry candidateRootIdentity { get; set; }
    public Entry candidateDistIdentity { get; set; }
    public Entry outputRootIdentity { get; set; }
    public Entry outputDistIdentity { get; set; }
    public Entry archiveIdentity { get; set; }
    public Entry markerIdentity { get; set; }
  }
  public sealed class Entry {
    public string path { get; set; } public string kind { get; set; }
    public string dev { get; set; } public string ino { get; set; }
    public long size { get; set; } public string sha256 { get; set; }
  }
  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)] struct FILE_INFO {
    public uint Attributes; public FILETIME Creation; public FILETIME Access; public FILETIME Write;
    public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links;
    public uint IndexHigh; public uint IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct DISPOSITION_INFO {
    [MarshalAs(UnmanagedType.U1)] public bool DeleteFile;
  }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(IntPtr handle, out FILE_INFO info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(IntPtr handle, int infoClass,
    IntPtr information, uint size);

  static void Require(bool answer) { if (!answer) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static ulong FileIndex(FILE_INFO info) { return ((ulong)info.IndexHigh << 32) | info.IndexLow; }
  static long FileSize(FILE_INFO info) { return (long)(((ulong)info.SizeHigh << 32) | info.SizeLow); }
  static string Hex(byte[] bytes) { return String.Concat(bytes.Select(b => b.ToString("x2"))); }
  static bool SamePath(string left, string right) {
    return String.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);
  }

  static void CheckIdentity(IntPtr handle, Entry entry, bool directory) {
    FILE_INFO info; Require(GetFileInformationByHandle(handle, out info));
    if ((info.Attributes & REPARSE_ATTRIBUTE) != 0 || info.Volume.ToString() != entry.dev
      || FileIndex(info).ToString() != entry.ino || (directory && entry.kind != "directory")
      || (!directory && entry.kind != "file")) throw new InvalidDataException();
    if (!directory && (info.Links != 1 || FileSize(info) != entry.size)) throw new InvalidDataException();
  }

  static IntPtr OpenDirectory(Entry entry, bool deleteAccess, bool writeShare) {
    uint access = FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_TRAVERSE
      | (deleteAccess ? DELETE : 0);
    uint share = SHARE_READ | (writeShare ? SHARE_WRITE : 0);
    IntPtr handle = CreateFileW(entry.path, access, share, IntPtr.Zero,
      OPEN_EXISTING, BACKUP_SEMANTICS | OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle == INVALID_HANDLE) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { CheckIdentity(handle, entry, true); return handle; }
    catch { CloseHandle(handle); throw; }
  }

  static IntPtr OpenFile(Entry entry, bool deleteAccess) {
    uint access = GENERIC_READ | (deleteAccess ? DELETE : 0);
    IntPtr handle = CreateFileW(entry.path, access, SHARE_READ, IntPtr.Zero,
      OPEN_EXISTING, OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle == INVALID_HANDLE) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { CheckIdentity(handle, entry, false); return handle; }
    catch { CloseHandle(handle); throw; }
  }

  static string Hash(IntPtr handle) {
    using (var safe = new SafeFileHandle(handle, false))
    using (var stream = new FileStream(safe, FileAccess.Read, 65536, false))
    using (var sha = SHA256.Create()) { stream.Position = 0; return Hex(sha.ComputeHash(stream)); }
  }

  static string ReadText(IntPtr handle, int limit) {
    using (var safe = new SafeFileHandle(handle, false))
    using (var stream = new FileStream(safe, FileAccess.Read, 4096, false)) {
      if (stream.Length <= 0 || stream.Length > limit) throw new InvalidDataException();
      byte[] bytes = new byte[stream.Length]; stream.Position = 0;
      int offset = 0; while (offset < bytes.Length) {
        int count = stream.Read(bytes, offset, bytes.Length - offset); if (count == 0) throw new EndOfStreamException();
        offset += count;
      }
      return new UTF8Encoding(false, true).GetString(bytes);
    }
  }

  static void DeleteOnClose(IntPtr handle) {
    var info = new DISPOSITION_INFO(); info.DeleteFile = true;
    int size = Marshal.SizeOf(typeof(DISPOSITION_INFO)); IntPtr memory = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, memory, false);
      Require(SetFileInformationByHandle(handle, FILE_DISPOSITION_INFO_CLASS, memory, (uint)size));
    } finally { Marshal.FreeHGlobal(memory); }
  }

  static void RenameNoReplace(IntPtr file, IntPtr root, string leaf) {
    byte[] name = Encoding.Unicode.GetBytes(leaf);
    int rootOffset = IntPtr.Size == 8 ? 8 : 4;
    int lengthOffset = rootOffset + IntPtr.Size;
    int nameOffset = lengthOffset + 4;
    int bufferSize = nameOffset + name.Length;
    IntPtr memory = Marshal.AllocHGlobal(bufferSize);
    try {
      for (int index = 0; index < bufferSize; index++) Marshal.WriteByte(memory, index, 0);
      Marshal.WriteByte(memory, 0, 0);
      Marshal.WriteIntPtr(memory, rootOffset, root);
      Marshal.WriteInt32(memory, lengthOffset, name.Length);
      Marshal.Copy(name, 0, IntPtr.Add(memory, nameOffset), name.Length);
      Require(SetFileInformationByHandle(file, FILE_RENAME_INFO_CLASS,
        memory, (uint)bufferSize));
    } finally { Marshal.FreeHGlobal(memory); }
  }

  static IntPtr CreateTemporary(string path) {
    IntPtr handle = CreateFileW(path, GENERIC_READ | GENERIC_WRITE | DELETE, SHARE_READ,
      IntPtr.Zero, CREATE_NEW, OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle == INVALID_HANDLE) throw new Win32Exception(Marshal.GetLastWin32Error());
    return handle;
  }

  static void Copy(IntPtr source, IntPtr destination, long expectedSize, string expectedHash) {
    using (var sourceSafe = new SafeFileHandle(source, false))
    using (var destinationSafe = new SafeFileHandle(destination, false))
    using (var input = new FileStream(sourceSafe, FileAccess.Read, 65536, false))
    using (var output = new FileStream(destinationSafe, FileAccess.ReadWrite, 65536, false)) {
      input.Position = 0; output.Position = 0; input.CopyTo(output, 65536); output.Flush(true);
      if (output.Length != expectedSize) throw new InvalidDataException();
    }
    if (Hash(source) != expectedHash || Hash(destination) != expectedHash) throw new InvalidDataException();
    Require(FlushFileBuffers(destination));
  }

  static void VerifyPublished(string path, IntPtr expected, long size, string sha256) {
    IntPtr observed = CreateFileW(path, GENERIC_READ, SHARE_READ | SHARE_WRITE | SHARE_DELETE, IntPtr.Zero,
      OPEN_EXISTING, OPEN_REPARSE_POINT, IntPtr.Zero);
    if (observed == INVALID_HANDLE) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      FILE_INFO left, right;
      Require(GetFileInformationByHandle(expected, out left));
      Require(GetFileInformationByHandle(observed, out right));
      if ((right.Attributes & REPARSE_ATTRIBUTE) != 0 || right.Links != 1
        || left.Volume != right.Volume || FileIndex(left) != FileIndex(right)
        || FileSize(right) != size || Hash(observed) != sha256) throw new InvalidDataException();
    } finally { CloseHandle(observed); }
  }

  public static void Run(string requestJson, string expectedDigest) {
    var heldDirectories = new List<IntPtr>();
    IntPtr candidateRoot = IntPtr.Zero, candidateDist = IntPtr.Zero, archive = IntPtr.Zero;
    IntPtr marker = IntPtr.Zero, outputRoot = IntPtr.Zero, outputDist = IntPtr.Zero;
    IntPtr temporary = IntPtr.Zero; bool committed = false;
    string stage = "decode";
    try {
      using (var sha = SHA256.Create()) {
        if (Hex(sha.ComputeHash(Encoding.UTF8.GetBytes(requestJson))) != expectedDigest) throw new InvalidDataException();
      }
      var serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = 64 * 1024 * 1024;
      Request request = serializer.Deserialize<Request>(requestJson);
      if (request == null || request.schemaVersion != "moe-windows-publication/1"
        || request.directories == null || request.directories.Length > 256
        || request.size <= 0 || request.size > 536870912
        || request.sha256 == null || request.sha256.Length != 64
        || request.finalName != "moe-windows.zip"
        || request.temporaryName == null || !request.temporaryName.StartsWith(".moe-windows-")) {
        throw new InvalidDataException();
      }
      stage = "ancestor-open";
      foreach (Entry entry in request.directories.OrderBy(e => e.path.Length))
        heldDirectories.Add(OpenDirectory(entry, false, true));
      stage = "output-open";
      outputRoot = OpenDirectory(request.outputRootIdentity, false, true);
      // Refuse pre-existing writers while this empty namespace has no child to
      // prevent an in-place reparse conversion.
      outputDist = OpenDirectory(request.outputDistIdentity, false, false);
      string temporaryPath = Path.Combine(request.outputDist, request.temporaryName);
      stage = "temporary-create";
      temporary = CreateTemporary(temporaryPath);
      // The held no-delete-sharing temporary now keeps outputDist nonempty and
      // unrenamable, so write sharing may be relaxed for the final rename.
      CloseHandle(outputDist); outputDist = IntPtr.Zero;
      outputDist = OpenDirectory(request.outputDistIdentity, false, true);
      stage = "candidate-open";
      candidateRoot = OpenDirectory(request.candidateRootIdentity, true, true);
      candidateDist = OpenDirectory(request.candidateDistIdentity, true, true);
      archive = OpenFile(request.archiveIdentity, true);
      marker = OpenFile(request.markerIdentity, true);
      if (Hash(archive) != request.sha256 || ReadText(marker, 1024) != request.token) throw new InvalidDataException();
      string[] rootItems = Directory.GetFileSystemEntries(request.candidateRoot).Select(Path.GetFileName)
        .OrderBy(x => x, StringComparer.Ordinal).ToArray();
      string[] distItems = Directory.GetFileSystemEntries(request.candidateDist).Select(Path.GetFileName)
        .OrderBy(x => x, StringComparer.Ordinal).ToArray();
      if (!rootItems.SequenceEqual(new [] { ".moe-windows-candidate-owner", "dist" })
        || !distItems.SequenceEqual(new [] { "moe-windows.zip" })) throw new InvalidDataException();
      stage = "copy";
      Copy(archive, temporary, request.size, request.sha256);

      stage = "archive-delete";
      DeleteOnClose(archive); CloseHandle(archive); archive = IntPtr.Zero;
      stage = "marker-delete";
      DeleteOnClose(marker); CloseHandle(marker); marker = IntPtr.Zero;
      stage = "dist-delete";
      DeleteOnClose(candidateDist); CloseHandle(candidateDist); candidateDist = IntPtr.Zero;
      stage = "root-delete";
      DeleteOnClose(candidateRoot); CloseHandle(candidateRoot); candidateRoot = IntPtr.Zero;

      stage = "rename";
      string finalPath = Path.Combine(request.outputDist, request.finalName);
      RenameNoReplace(temporary, IntPtr.Zero, finalPath);
      VerifyPublished(finalPath, temporary, request.size, request.sha256);
      committed = true;
      Require(CloseHandle(temporary)); temporary = IntPtr.Zero;
      return;
    } catch (Exception error) {
      throw new Exception(stage, error);
    } finally {
      if (!committed && temporary != IntPtr.Zero) {
        try { DeleteOnClose(temporary); } catch { }
      }
      if (temporary != IntPtr.Zero) CloseHandle(temporary);
      if (archive != IntPtr.Zero) CloseHandle(archive);
      if (marker != IntPtr.Zero) CloseHandle(marker);
      if (candidateDist != IntPtr.Zero) CloseHandle(candidateDist);
      if (candidateRoot != IntPtr.Zero) CloseHandle(candidateRoot);
      if (outputDist != IntPtr.Zero) CloseHandle(outputDist);
      if (outputRoot != IntPtr.Zero) CloseHandle(outputRoot);
      for (int index = heldDirectories.Count - 1; index >= 0; index--) CloseHandle(heldDirectories[index]);
    }
  }
}
`;
