// Windows-only owned worker. No subprocesses, elevated token, global settings,
// path-based overwrite, or deletion of a user file. See native prerequisites.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class Native {
    internal const uint Read = 0x00100081, ReadDelete = 0x00110081, ReadWriteDelete = 0x00110083;
    internal const uint DirRead = 0x001000a0, DirAttributesWrite = 0x001001a0, ProbeDirectoryAccess = 0x001101a0;
    internal const int NotFound = unchecked((int)0xc0000034), PathNotFound = unchecked((int)0xc000003a);
    [StructLayout(LayoutKind.Sequential)] internal struct Unicode { internal ushort Length, MaximumLength; internal IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] internal struct Attributes { internal uint Length; internal IntPtr RootDirectory, ObjectName; internal uint Flags; internal IntPtr SecurityDescriptor, SecurityQuality; }
    [StructLayout(LayoutKind.Sequential)] internal struct IoStatus { internal IntPtr Status; internal UIntPtr Information; }
    [StructLayout(LayoutKind.Sequential)] internal struct Time { internal uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] internal struct Info {
        internal uint Attributes; internal Time Creation, Access, Write;
        internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        internal string Identity { get { return Volume.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + (((ulong)IndexHigh << 32) | IndexLow).ToString(System.Globalization.CultureInfo.InvariantCulture); } }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] internal static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("ntdll.dll")] internal static extern int NtCreateFile(out IntPtr handle, uint access, ref Attributes attributes, out IoStatus status, IntPtr allocation, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
    [DllImport("ntdll.dll")] internal static extern int NtSetInformationFile(IntPtr handle, out IoStatus status, IntPtr information, uint size, int informationClass);
    [DllImport("ntdll.dll")] internal static extern uint RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetFileInformationByHandle(IntPtr handle, out Info info);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetFileInformationByHandle(IntPtr handle, int informationClass, IntPtr information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder name, uint size, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool GetVolumeInformationByHandleW(IntPtr handle, StringBuilder volume, uint size, out uint serial, out uint componentLength, out uint flags, StringBuilder filesystem, uint filesystemSize);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool DeviceIoControl(IntPtr handle, uint code, byte[] input, uint inputSize, IntPtr output, uint outputSize, out uint returned, IntPtr overlapped);
    internal static Info Information(IntPtr handle) { Info info; if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error()); return info; }
    internal static string FinalPath(IntPtr handle) {
        var value = new StringBuilder(32768); uint count = GetFinalPathNameByHandle(handle, value, (uint)value.Capacity, 0);
        if (count == 0 || count >= value.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
        var result = value.ToString(); return result.StartsWith(@"\\?\", StringComparison.Ordinal) ? result.Substring(4) : result;
    }
    internal static void Leaf(string value) {
        if (String.IsNullOrEmpty(value) || value == "." || value == ".." || value.Length > 255 || value.IndexOfAny(new[] {'\\','/',':','\0','<','>','"','|','?','*'}) >= 0 || value.EndsWith(".") || value.EndsWith(" ")) throw new IOException("Invalid single-component file name");
    }
    internal static int OpenRelative(IntPtr parent, string name, bool directory, bool create, uint access, uint share, out IntPtr handle) {
        Leaf(name); var text = Marshal.StringToHGlobalUni(name); IntPtr unicode = IntPtr.Zero;
        try {
            var value = new Unicode { Length = checked((ushort)Encoding.Unicode.GetByteCount(name)), MaximumLength = checked((ushort)(Encoding.Unicode.GetByteCount(name) + 2)), Buffer = text };
            unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Unicode))); Marshal.StructureToPtr(value, unicode, false);
            var attributes = new Attributes { Length = (uint)Marshal.SizeOf(typeof(Attributes)), RootDirectory = parent, ObjectName = unicode, Flags = 0x1040 };
            IoStatus status;
            return NtCreateFile(out handle, access, ref attributes, out status, IntPtr.Zero, create && !directory ? 0x102u : 0u, share,
                create ? 2u : 1u, (directory ? 1u : 0x40u) | 0x20u | 0x200000u, IntPtr.Zero, 0);
        } finally { if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode); Marshal.FreeHGlobal(text); }
    }
    internal static bool Rename(IntPtr source, IntPtr directory, string leaf) { return RenameFlags(source, directory, leaf, 0, false); }
    internal static int RenameError;
    internal static bool RenameUnconfirmed;
    // Flags are used only by the owned-fixture probe; production always uses no-replace.
    internal static bool RenameFlags(IntPtr source, IntPtr directory, string leaf, uint flags, bool extended) {
        Leaf(leaf);
        var targetDirectory = FinalPath(directory).TrimEnd('\\');
        bool sameDirectory = String.Equals(Path.GetDirectoryName(FinalPath(source)).TrimEnd('\\'), targetDirectory, StringComparison.OrdinalIgnoreCase);
        // Same-directory NT renames require a NULL RootDirectory. Ancestors are
        // held and sealed by the caller; this still uses no-replace atomically.
        var name = Encoding.Unicode.GetBytes(sameDirectory ? @"\??\" + targetDirectory + "\\" + leaf : leaf);
        int rootOffset = IntPtr.Size == 8 ? 8 : 4, lengthOffset = rootOffset + IntPtr.Size, nameOffset = lengthOffset + 4;
        int bufferSize = checked((IntPtr.Size == 8 ? 24 : 16) + name.Length);
        var buffer = Marshal.AllocHGlobal(bufferSize);
        try {
            for (int index = 0; index < bufferSize; index++) Marshal.WriteByte(buffer, index, 0);
            Marshal.WriteInt32(buffer, 0, unchecked((int)flags)); Marshal.WriteIntPtr(buffer, rootOffset, sameDirectory ? IntPtr.Zero : directory); Marshal.WriteInt32(buffer, lengthOffset, name.Length); Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
            IoStatus io;
            int status = NtSetInformationFile(source, out io, buffer, (uint)bufferSize, extended ? 65 : 10);
            RenameUnconfirmed = status >= 0 && (status != 0 || io.Status != IntPtr.Zero);
            RenameError = RenameUnconfirmed ? 997 : status >= 0 ? 0 : unchecked((int)RtlNtStatusToDosError(status));
            return status == 0 && io.Status == IntPtr.Zero;
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    internal static bool DeleteOwned(IntPtr handle) {
        var buffer = Marshal.AllocHGlobal(1);
        try { Marshal.WriteByte(buffer, 1); return SetFileInformationByHandle(handle, 4, buffer, 1); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    internal static bool DeleteOwnedPosix(IntPtr handle) {
        var buffer = Marshal.AllocHGlobal(4);
        try { Marshal.WriteInt32(buffer, 3); return SetFileInformationByHandle(handle, 21, buffer, 4); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    internal static int LinkOwnedProbe(IntPtr source, IntPtr directory, string leaf) {
        Leaf(leaf); var name = Encoding.Unicode.GetBytes(leaf); int rootOffset = IntPtr.Size == 8 ? 8 : 4, lengthOffset = rootOffset + IntPtr.Size, nameOffset = lengthOffset + 4;
        int size = Math.Max(24, nameOffset + name.Length + 2); var buffer = Marshal.AllocHGlobal(size);
        try {
            for (int index = 0; index < size; index++) Marshal.WriteByte(buffer, index, 0);
            Marshal.WriteInt32(buffer, 0, 3); // FILE_LINK_REPLACE_IF_EXISTS | FILE_LINK_POSIX_SEMANTICS.
            Marshal.WriteIntPtr(buffer, rootOffset, directory); Marshal.WriteInt32(buffer, lengthOffset, name.Length); Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
            IoStatus status; return NtSetInformationFile(source, out status, buffer, (uint)size, 72); // FileLinkInformationEx, native enum.
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    internal static bool SetJunction(IntPtr handle, string target) {
        var substitute = Encoding.Unicode.GetBytes(@"\??\" + target); var printable = Encoding.Unicode.GetBytes(target);
        var buffer = new byte[16 + substitute.Length + 2 + printable.Length + 2];
        Array.Copy(BitConverter.GetBytes(0xa0000003u), 0, buffer, 0, 4); Array.Copy(BitConverter.GetBytes(checked((ushort)(buffer.Length - 8))), 0, buffer, 4, 2);
        Array.Copy(BitConverter.GetBytes(checked((ushort)substitute.Length)), 0, buffer, 10, 2);
        Array.Copy(BitConverter.GetBytes(checked((ushort)(substitute.Length + 2))), 0, buffer, 12, 2); Array.Copy(BitConverter.GetBytes(checked((ushort)printable.Length)), 0, buffer, 14, 2);
        Array.Copy(substitute, 0, buffer, 16, substitute.Length); Array.Copy(printable, 0, buffer, 18 + substitute.Length, printable.Length);
        uint returned; return DeviceIoControl(handle, 0x900a4, buffer, (uint)buffer.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero);
    }
}

internal sealed class OwnedHandle {
    internal IntPtr Value; internal bool Delete; internal string Name;
}
internal sealed class SealedDirectories : IDisposable {
    internal readonly List<OwnedHandle> Handles = new List<OwnedHandle>();
    private readonly Dictionary<string, OwnedHandle> directories = new Dictionary<string, OwnedHandle>(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<IntPtr, OwnedHandle> protectedDirectories = new Dictionary<IntPtr, OwnedHandle>();
    internal string Root, RootIdentity; internal bool RootVerified, SealingEnabled; internal readonly Stopwatch Clock = Stopwatch.StartNew();
    internal string CleanupWarning = "";
    internal void Deadline() { if (Clock.ElapsedMilliseconds > 30000) throw new TimeoutException("Owned file move exceeded its deadline"); }
    internal static string Full(string value) {
        if (String.IsNullOrEmpty(value) || value.Length > 30000 || value.IndexOf('\0') >= 0) throw new IOException("Invalid path");
        var full = Path.GetFullPath(value); if (full.Length < 3 || full[1] != ':' || full[2] != '\\' || !Char.IsLetter(full[0])) throw new IOException("Only local drive paths are supported");
        return full.Length == 3 ? full : full.TrimEnd('\\');
    }
    internal bool Inside(string value) { return String.Equals(value, Root, StringComparison.OrdinalIgnoreCase) || value.StartsWith(Root.EndsWith("\\") ? Root : Root + "\\", StringComparison.OrdinalIgnoreCase); }
    internal OwnedHandle Keep(IntPtr handle, string name, bool delete) { var owned = new OwnedHandle { Value = handle, Name = name, Delete = delete }; Handles.Add(owned); return owned; }
    internal OwnedHandle Relative(OwnedHandle parent, string name, bool directory, bool create, uint access, uint share, bool owned) {
        Deadline(); IntPtr handle; int status = Native.OpenRelative(parent.Value, name, directory, create, access, share, out handle);
        if (status < 0) throw new IOException("Relative open failed: 0x" + unchecked((uint)status).ToString("x8"));
        var result = Keep(handle, parent.Name.TrimEnd('\\') + "\\" + name, owned);
        var info = Native.Information(handle);
        if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory) throw new IOException("Reparse points and unexpected entry types are refused");
        return result;
    }
    internal OwnedHandle Protect(OwnedHandle directory) {
        OwnedHandle marker; if (protectedDirectories.TryGetValue(directory.Value, out marker)) return marker;
        if ((Native.Information(directory.Value).Attributes & 0x400) != 0) throw new IOException("Directory became a reparse point");
        marker = Relative(directory, ".__zuoren_move_lock_" + Guid.NewGuid().ToString("N"), false, true, Native.ReadDelete, 1, true);
        if ((Native.Information(directory.Value).Attributes & 0x400) != 0) throw new IOException("Directory became a reparse point while sealing");
        protectedDirectories.Add(directory.Value, marker); return marker;
    }
    internal OwnedHandle Directory(string name, bool create) {
        Deadline(); name = Full(name); OwnedHandle cached;
        if (directories.TryGetValue(name, out cached)) { if (RootVerified && SealingEnabled && Inside(name)) Protect(cached); return cached; }
        var drive = name.Substring(0, 3); OwnedHandle current;
        if (!directories.TryGetValue(drive, out current)) {
            var handle = Native.CreateFile(@"\\?\" + drive, Native.DirRead, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            current = Keep(handle, drive, false); if ((Native.Information(handle).Attributes & 0x400) != 0) throw new IOException("Reparse volume root refused"); directories[drive] = current;
        }
        var path = drive;
        foreach (var leaf in name.Substring(3).Split(new[] {'\\'}, StringSplitOptions.RemoveEmptyEntries)) {
            Native.Leaf(leaf); path = path.TrimEnd('\\') + "\\" + leaf;
            if (!directories.TryGetValue(path, out cached)) {
                IntPtr opened; int status = Native.OpenRelative(current.Value, leaf, true, false, Native.DirRead, 3, out opened);
                if (status < 0 && create && RootVerified && SealingEnabled && Inside(path)) cached = Relative(current, leaf, true, true, Native.DirRead, 3, false);
                else { if (status < 0) throw new IOException("Directory open failed: 0x" + unchecked((uint)status).ToString("x8")); cached = Keep(opened, path, false); }
                var info = Native.Information(cached.Value); if ((info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0) throw new IOException("Directory links are refused");
                directories[path] = cached;
            }
            current = cached;
            if (Root != null && String.Equals(path, Root, StringComparison.OrdinalIgnoreCase)) {
                if (RootIdentity != null && Native.Information(current.Value).Identity != RootIdentity) throw new IOException("The granted root identity changed");
                RootVerified = true;
            }
            if (RootVerified && SealingEnabled && Inside(path)) Protect(current);
        }
        if (name.Length == 3 && Root == name) { if (RootIdentity != null && Native.Information(current.Value).Identity != RootIdentity) throw new IOException("The granted drive root changed"); RootVerified = true; if (SealingEnabled) Protect(current); }
        return current;
    }
    internal void ValidateAll() { foreach (var pair in directories) if ((Native.Information(pair.Value.Value).Attributes & 0x400) != 0) throw new IOException("A held ancestor became a reparse point"); }
    internal byte[] Bytes(OwnedHandle file, int maximum) {
        using (var wrapper = new SafeFileHandle(file.Value, false)) using (var stream = new FileStream(wrapper, FileAccess.Read, 65536, false)) using (var output = new MemoryStream()) {
            stream.Position = 0; var buffer = new byte[65536]; int count;
            while ((count = stream.Read(buffer, 0, buffer.Length)) > 0) { Deadline(); if (output.Length + count > maximum) throw new IOException("Metadata too large"); output.Write(buffer, 0, count); }
            return output.ToArray();
        }
    }
    internal string Hash(OwnedHandle file) {
        using (var wrapper = new SafeFileHandle(file.Value, false)) using (var stream = new FileStream(wrapper, FileAccess.Read, 65536, false)) using (var algorithm = SHA256.Create()) {
            stream.Position = 0; var buffer = new byte[65536]; int count;
            while ((count = stream.Read(buffer, 0, buffer.Length)) > 0) { Deadline(); algorithm.TransformBlock(buffer, 0, count, buffer, 0); }
            algorithm.TransformFinalBlock(new byte[0], 0, 0); return BitConverter.ToString(algorithm.Hash).Replace("-", "").ToLowerInvariant();
        }
    }
    internal void Write(OwnedHandle file, byte[] data) {
        Deadline(); using (var wrapper = new SafeFileHandle(file.Value, false)) using (var stream = new FileStream(wrapper, FileAccess.Write, 65536, false)) { stream.Write(data, 0, data.Length); stream.Flush(true); }
    }
    internal void CleanupFailure() { CleanupWarning = "Owned temporary marker or handle cleanup could not be confirmed; further moves are blocked."; }
    internal void CloseOwnedProbe(OwnedHandle handle, bool delete) {
        if (delete && !Native.DeleteOwned(handle.Value)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Owned probe deletion refused");
        if (!Native.CloseHandle(handle.Value)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Owned probe close refused");
        Handles.Remove(handle); handle.Value = IntPtr.Zero;
    }
    public void Dispose() {
        for (int index = Handles.Count - 1; index >= 0; index--) {
            var handle = Handles[index];
            // A fault while deleting one owned marker must still close this and all other handles.
            try { if (handle.Delete && !Native.DeleteOwned(handle.Value)) CleanupFailure(); }
            catch (Exception) { CleanupFailure(); }
            try {
                if (!Native.CloseHandle(handle.Value)) CleanupFailure();
                else { handle.Value = IntPtr.Zero; Handles.RemoveAt(index); }
            } catch (Exception) { CleanupFailure(); }
        }
    }

}

public sealed class RecordInput { public string Source, Relative, RawHash, NextBase64; }
public class ReceiptInput {
    public string OperationId, ReceiptNonce, RequestBinding, ReceiptPath, ReceiptIdentity, ReceiptDirectoryIdentity;
}
public sealed class MoveInput : ReceiptInput {
    public string Root, RootIdentity, Source, Target, ExpectedIdentity, ExpectedHash;
    public RecordInput[] Records;
}
internal sealed class PreparedMetadata {
    internal OwnedHandle Directory, Temporary;
    internal string Leaf;
    internal byte[] Bytes;
}
internal static class ReceiptProtocol {
    internal const int MaximumBytes = 32768;
    internal static void Validate(ReceiptInput input) {
        Guid operation;
        if (input == null || !Guid.TryParseExact(input.OperationId, "D", out operation) || operation.ToString("D") != input.OperationId
            || !Hex(input.ReceiptNonce) || !Hex(input.RequestBinding) || !Identity(input.ReceiptIdentity) || !Identity(input.ReceiptDirectoryIdentity)
            || String.IsNullOrEmpty(input.ReceiptPath) || input.ReceiptPath.Length < 3 || input.ReceiptPath[1] != ':' || input.ReceiptPath[2] != '\\')
            throw new IOException("Invalid receipt identity");
        SealedDirectories.Full(input.ReceiptPath);
    }
    internal static bool Hex(string value) { return value != null && System.Text.RegularExpressions.Regex.IsMatch(value, @"\A[a-f0-9]{64}\z"); }
    internal static bool Identity(string value) { return value != null && System.Text.RegularExpressions.Regex.IsMatch(value, @"\A\d+:\d+\z"); }
    internal static bool AllowedError(string value) {
        return value == "Move was refused before body commit." || value == "Move completion requires manual verification."
            || value == "Native qualification failed before user-file operations."
            || value == "Worker completion could not be confirmed."
            || value == "Owned temporary marker or handle cleanup could not be confirmed; further moves are blocked.";
    }
    internal static Dictionary<string, object> CheckedResult(object value) {
        var result = value as Dictionary<string, object>; object statusValue;
        if (result == null || !result.TryGetValue("status", out statusValue) || !(statusValue is string)) throw new IOException("Invalid terminal result");
        var status = (string)statusValue;
        if (status == "moved") {
            object hash, identity;
            if (result.Count != 3 || !result.TryGetValue("hash", out hash) || !Hex(hash as string)
                || !result.TryGetValue("identity", out identity) || !Identity(identity as string)) throw new IOException("Invalid moved result");
        } else if (status == "failed" || status == "uncertain") {
            object error;
            if (result.Count != 2 || !result.TryGetValue("error", out error) || !AllowedError(error as string)) throw new IOException("Invalid failure classification");
        } else throw new IOException("Not a terminal move result");
        return result;
    }
    internal static object Decode(byte[] bytes, ReceiptInput input) {
        Validate(input);
        if (bytes == null || bytes.Length == 0 || bytes.Length > MaximumBytes) throw new IOException("Unresolved receipt length");
        var json = new JavaScriptSerializer { MaxJsonLength = MaximumBytes, RecursionLimit = 8 };
        var envelope = json.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(bytes)); object schema, operation, nonce, binding, result;
        if (envelope == null || envelope.Count != 5 || !envelope.TryGetValue("schema", out schema) || !(schema is int) || (int)schema != 2
            || !envelope.TryGetValue("operationId", out operation) || !String.Equals(operation as string, input.OperationId, StringComparison.Ordinal)
            || !envelope.TryGetValue("nonce", out nonce) || !String.Equals(nonce as string, input.ReceiptNonce, StringComparison.Ordinal)
            || !envelope.TryGetValue("binding", out binding) || !String.Equals(binding as string, input.RequestBinding, StringComparison.Ordinal)
            || !envelope.TryGetValue("result", out result)) throw new IOException("Receipt binding mismatch");
        CheckedResult(result); return envelope;
    }
    internal static byte[] Encode(ReceiptInput input, object result) {
        Validate(input);
        var json = new JavaScriptSerializer { MaxJsonLength = MaximumBytes, RecursionLimit = 8 };
        var bytes = new UTF8Encoding(false, true).GetBytes(json.Serialize(new { schema = 2, operationId = input.OperationId, nonce = input.ReceiptNonce, binding = input.RequestBinding, result = result }));
        Decode(bytes, input); return bytes;
    }
}
internal sealed class ReceiptLease : IDisposable {
    private readonly SealedDirectories scope;
    private readonly OwnedHandle file;
    private readonly ReceiptInput input;
    internal readonly bool Writable;
    internal bool WriteAttempted, TerminalWritten;
    private bool Claimed, MoveStarted;
    private byte[] claim;
    internal string CleanupWarning = "";
    private ReceiptLease(SealedDirectories scope, OwnedHandle file, ReceiptInput input, bool writable) {
        this.scope = scope; this.file = file; this.input = input; Writable = writable;
    }
    internal static ReceiptLease Acquire(ReceiptInput input, bool writable) {
        ReceiptProtocol.Validate(input); var scope = new SealedDirectories();
        try {
            // Root remains null: opening receipt ancestors is strictly read-only,
            // without Protect/sentinels, directory creation or the native probe.
            var path = SealedDirectories.Full(input.ReceiptPath); var parent = scope.Directory(Path.GetDirectoryName(path), false);
            if (Native.Information(parent.Value).Identity != input.ReceiptDirectoryIdentity) throw new IOException("Receipt directory identity changed");
            var file = scope.Relative(parent, Path.GetFileName(path), false, false, writable ? 0x00100083u : Native.Read, 0, false);
            var info = Native.Information(file.Value); scope.ValidateAll();
            if (Native.Information(parent.Value).Identity != input.ReceiptDirectoryIdentity || info.Identity != input.ReceiptIdentity || info.Links != 1
                || writable && (info.SizeHigh != 0 || info.SizeLow != 0)) throw new IOException("Receipt identity changed or already used");
            var lease = new ReceiptLease(scope, file, input, writable);
            if (writable) lease.Claim();
            return lease;
        } catch { scope.Dispose(); throw; }
    }
    private void Claim() {
        claim = Encoding.ASCII.GetBytes("ZUOREN_MOVE_CLAIM_V2\n" + input.OperationId + "\n" + input.ReceiptNonce + "\n" + input.RequestBinding);
        using (var wrapper = new SafeFileHandle(file.Value, false)) using (var stream = new FileStream(wrapper, FileAccess.Write, 4096, false)) {
            stream.Position = 0; stream.Write(claim, 0, claim.Length); stream.Flush(true);
        }
        Claimed = true;
    }
    private byte[] CurrentBytes() {
        using (var wrapper = new SafeFileHandle(file.Value, false)) using (var stream = new FileStream(wrapper, FileAccess.Read, 4096, false)) {
            if (stream.Length > ReceiptProtocol.MaximumBytes) throw new IOException("Receipt size changed");
            var bytes = new byte[(int)stream.Length]; int count = 0, read; stream.Position = 0;
            while (count < bytes.Length && (read = stream.Read(bytes, count, bytes.Length - count)) != 0) count += read;
            if (count != bytes.Length) throw new IOException("Receipt read incomplete"); return bytes;
        }
    }
    internal bool Authorizes(MoveInput value) {
        if (!Writable || !Claimed || MoveStarted || WriteAttempted || file.Value == IntPtr.Zero || !Object.ReferenceEquals(input, value)) return false;
        MoveStarted = true; return true;
    }
    internal void Persist(object result) {
        if (!Writable || !Claimed || WriteAttempted) throw new IOException("Receipt write is single-use");
        WriteAttempted = true;
        var info = Native.Information(file.Value);
        if (info.Identity != input.ReceiptIdentity || info.SizeHigh != 0 || info.SizeLow != claim.Length) throw new IOException("Receipt claim changed");
        var current = CurrentBytes(); if (current.Length != claim.Length) throw new IOException("Receipt claim changed");
        for (int index = 0; index < claim.Length; index++) if (current[index] != claim[index]) throw new IOException("Receipt claim changed");
        var bytes = ReceiptProtocol.Encode(input, result);
        using (var wrapper = new SafeFileHandle(file.Value, false)) using (var stream = new FileStream(wrapper, FileAccess.Write, 4096, false)) {
            stream.Position = 0; stream.Write(bytes, 0, bytes.Length); stream.SetLength(bytes.Length); stream.Flush(true);
        }
        TerminalWritten = true;
    }
    internal void InvalidateAfterWriteFailure() {
        if (!Writable || TerminalWritten) return;
        try {
            // Only this known Node-owned receipt, still under the same SHARE0
            // lease, may be invalidated. Failure never permits a definite result.
            using (var wrapper = new SafeFileHandle(file.Value, false)) using (var stream = new FileStream(wrapper, FileAccess.Write, 4096, false)) {
                stream.Position = 0; stream.WriteByte(0); stream.Flush(true); stream.SetLength(1); stream.Flush(true);
            }
        } catch (Exception) { /* A later read still requires exclusive identity/binding and current-file verification. */ }
    }
    internal object Read() { return ReceiptProtocol.Decode(scope.Bytes(file, ReceiptProtocol.MaximumBytes), input); }
    public void Dispose() {
        // Keep the exclusive file handle until every other cleanup attempt has
        // ended. No user-root operation may run after this final lease close.
        scope.Handles.Remove(file); scope.Dispose(); CleanupWarning = scope.CleanupWarning;
        try { if (!Native.CloseHandle(file.Value)) CleanupWarning = "Receipt lease close could not be confirmed."; else file.Value = IntPtr.Zero; }
        catch (Exception) { CleanupWarning = "Receipt lease close could not be confirmed."; }
    }
}
internal static class FileMoveWorker {
    private static bool ProbePassed;
    internal static string Sha(byte[] data) { using (var digest = SHA256.Create()) return BitConverter.ToString(digest.ComputeHash(data)).Replace("-", "").ToLowerInvariant(); }
    internal static string Layout() { return "{\"pointerSize\":" + IntPtr.Size + ",\"unicodeSize\":" + Marshal.SizeOf(typeof(Native.Unicode)) + ",\"attributesSize\":" + Marshal.SizeOf(typeof(Native.Attributes)) + ",\"ioStatusSize\":" + Marshal.SizeOf(typeof(Native.IoStatus)) + ",\"fileInfoSize\":" + Marshal.SizeOf(typeof(Native.Info)) + ",\"renameRootOffset\":" + (IntPtr.Size == 8 ? 8 : 4) + ",\"renameLengthOffset\":" + (IntPtr.Size == 8 ? 16 : 8) + ",\"renameNameOffset\":" + (IntPtr.Size == 8 ? 20 : 12) + ",\"dispositionSize\":1}"; }
    internal static object Move(MoveInput input, ReceiptLease lease) {
        var scope = new SealedDirectories(); bool moved = false, commitAttempted = false, commitDenied = false; object result = null;
        try {
            if (!ProbePassed || input == null || lease == null || !lease.Authorizes(input) || input.Records == null || input.Records.Length > 512 ||
                String.IsNullOrEmpty(input.RootIdentity) || !System.Text.RegularExpressions.Regex.IsMatch(input.RootIdentity, @"^\d+:\d+$") ||
                String.IsNullOrEmpty(input.ExpectedIdentity) || !System.Text.RegularExpressions.Regex.IsMatch(input.ExpectedIdentity, @"^\d+:\d+$") ||
                String.IsNullOrEmpty(input.ExpectedHash) || !System.Text.RegularExpressions.Regex.IsMatch(input.ExpectedHash, @"^[a-f0-9]{64}$")) throw new IOException("Invalid move input or native probe has not passed");
            scope.Root = SealedDirectories.Full(input.Root); scope.RootIdentity = input.RootIdentity;
            if (scope.Root.Length == 3) throw new IOException("Open a specific data directory instead of a volume root");
            var source = SealedDirectories.Full(input.Source); var target = SealedDirectories.Full(input.Target);
            if (!scope.Inside(source) || !scope.Inside(target) || String.Equals(source, target, StringComparison.OrdinalIgnoreCase) || Path.GetFileName(source) != Path.GetFileName(target)) throw new IOException("Move must keep the file name and stay within one granted root");
            Native.Leaf(Path.GetFileName(source));
            if (Native.GetDriveTypeW(scope.Root.Substring(0, 3)) != 3) throw new IOException("Only fixed local drives have been enabled");
            var root = scope.Directory(scope.Root, false); var filesystem = new StringBuilder(64); uint serial, componentLength, flags;
            if (!Native.GetVolumeInformationByHandleW(root.Value, null, 0, out serial, out componentLength, out flags, filesystem, 64)) throw new IOException("The filesystem could not be identified");
            bool ntfs = String.Equals(filesystem.ToString(), "NTFS", StringComparison.OrdinalIgnoreCase);
            bool exfat = String.Equals(filesystem.ToString(), "exFAT", StringComparison.OrdinalIgnoreCase);
            if ((!ntfs && !exfat) || (flags & 0x00080000u) != 0 || (exfat && (flags & 0x80u) != 0)) throw new IOException("Only writable fixed local NTFS or non-reparse exFAT roots have been enabled");
            if (!scope.RootVerified) throw new IOException("The granted root identity was not verified");
            scope.SealingEnabled = true; scope.Protect(root);
            var sourceParent = scope.Directory(Path.GetDirectoryName(source), false); var targetParent = scope.Directory(Path.GetDirectoryName(target), false);
            var lockedRecords = new List<Tuple<RecordInput, OwnedHandle, OwnedHandle, byte[]>>(); var recordNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase); int total = 0;
            foreach (var record in input.Records) {
                if (record == null || String.IsNullOrEmpty(record.Relative) || Path.IsPathRooted(record.Relative)) throw new IOException("Invalid metadata path");
                foreach (var leaf in record.Relative.Split('\\')) Native.Leaf(leaf);
                var expectedSource = Path.Combine(Path.GetDirectoryName(source), ".reader", record.Relative);
                if (!String.Equals(SealedDirectories.Full(record.Source), expectedSource, StringComparison.OrdinalIgnoreCase)) throw new IOException("Metadata source escaped its note directory");
                var relative = record.Relative.Replace('/', '\\');
                if (!recordNames.Add(relative)) throw new IOException("Duplicate auxiliary record");
                bool markdown = source.EndsWith(".md", StringComparison.OrdinalIgnoreCase) || source.EndsWith(".markdown", StringComparison.OrdinalIgnoreCase);
                if (markdown ? !(System.Text.RegularExpressions.Regex.IsMatch(relative, @"^recovery\\[a-fA-F0-9-]{36}\.json$") || System.Text.RegularExpressions.Regex.IsMatch(relative, @"^history\\[a-f0-9]{16}-\d+\.md$"))
                    : !String.Equals(relative, input.ExpectedHash + (source.EndsWith(".epub", StringComparison.OrdinalIgnoreCase) ? ".epub.json" : ".json"), StringComparison.OrdinalIgnoreCase)) throw new IOException("Unexpected auxiliary record");
                var oldParent = scope.Directory(Path.GetDirectoryName(expectedSource), false);
                var newParent = scope.Directory(Path.Combine(Path.GetDirectoryName(target), ".reader", Path.GetDirectoryName(relative) ?? ""), true);
                var original = scope.Relative(oldParent, Path.GetFileName(relative), false, false, Native.Read, 1, false);
                var bytes = scope.Bytes(original, 20 * 1024 * 1024); if (Sha(bytes) != record.RawHash) throw new IOException("Metadata changed after planning");
                var next = Convert.FromBase64String(record.NextBase64); total += next.Length; if (total > 40 * 1024 * 1024) throw new IOException("Metadata budget exceeded");
                if (relative.StartsWith("recovery\\", StringComparison.OrdinalIgnoreCase)) {
                    var json = new JavaScriptSerializer { MaxJsonLength = 30 * 1024 * 1024 };
                    var before = json.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(bytes)); var after = json.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(next));
                    if (!before.ContainsKey("sourcePath") || !after.ContainsKey("sourcePath") || !String.Equals((string)before["sourcePath"], source, StringComparison.OrdinalIgnoreCase) || !String.Equals((string)after["sourcePath"], target, StringComparison.OrdinalIgnoreCase)) throw new IOException("Recovery ownership changed");
                    before.Remove("sourcePath"); after.Remove("sourcePath"); if (json.Serialize(before) != json.Serialize(after)) throw new IOException("Moving cannot rewrite a recovery draft");
                } else if (Sha(next) != record.RawHash) throw new IOException("Moving cannot rewrite history or reader annotations");
                lockedRecords.Add(Tuple.Create(record, original, newParent, next));
            }
            scope.ValidateAll();
            var file = scope.Relative(sourceParent, Path.GetFileName(source), false, false, Native.ReadDelete, 1, false);
            if (Native.Information(file.Value).Identity != input.ExpectedIdentity || scope.Hash(file) != input.ExpectedHash) throw new IOException("The selected file changed");
            var prepared = new List<PreparedMetadata>();
            // Inspect every collision before staging anything and keep matching
            // existing destinations locked. No public metadata name is created.
            foreach (var record in lockedRecords) {
                var leaf = Path.GetFileName(record.Item1.Relative); IntPtr existing;
                int status = Native.OpenRelative(record.Item3.Value, leaf, false, false, Native.Read, 1, out existing);
                if (status >= 0) {
                    var held = scope.Keep(existing, leaf, false);
                    if ((Native.Information(existing).Attributes & 0x400) != 0 || scope.Hash(held) != Sha(record.Item4)) throw new IOException("Destination auxiliary record differs");
                    continue;
                }
                if (status != Native.NotFound && status != Native.PathNotFound) throw new IOException("Destination metadata cannot be verified");
                prepared.Add(new PreparedMetadata { Directory = record.Item3, Leaf = leaf, Bytes = record.Item4 });
            }
            foreach (var record in prepared) {
                record.Temporary = scope.Relative(record.Directory, ".__zuoren_move_meta_" + Guid.NewGuid().ToString("N"), false, true, Native.ReadWriteDelete, 1, true);
                scope.Write(record.Temporary, record.Bytes); scope.ValidateAll();
            }
            scope.ValidateAll(); scope.Deadline();
            commitAttempted = true;
            if (!Native.Rename(file.Value, targetParent.Value, Path.GetFileName(target))) { commitDenied = !Native.RenameUnconfirmed; throw new Win32Exception(Native.RenameError, "Atomic no-replace move refused"); }
            moved = true;
            // Body owns its final name before any new public metadata record.
            // Late collisions/publish failures retain body and original records;
            // no body rollback or deletion is attempted.
            foreach (var record in prepared) {
                scope.ValidateAll(); scope.Deadline();
                record.Temporary.Delete = false; // An exceptional publish outcome must not delete a possibly public record.
                if (!Native.Rename(record.Temporary.Value, record.Directory.Value, record.Leaf)) {
                    record.Temporary.Delete = !Native.RenameUnconfirmed; // Only explicit refusal confirms the temporary name is still owned.
                    throw new Win32Exception(Native.RenameError, "Metadata publication refused after body commit");
                }
            }
            result = new { status = "moved", hash = input.ExpectedHash, identity = Native.Information(file.Value).Identity };
        } catch (Exception) { result = new { status = moved || commitAttempted && !commitDenied ? "uncertain" : "failed", error = moved || commitAttempted && !commitDenied ? "Move completion requires manual verification." : "Move was refused before body commit." }; }
        finally { scope.Dispose(); }
        if (scope.CleanupWarning.Length != 0) return new { status = "uncertain", error = scope.CleanupWarning };
        return result;
    }
    private static void RequireMissing(SealedDirectories scope, OwnedHandle parent, string name) {
        IntPtr handle; int status = Native.OpenRelative(parent.Value, name, false, false, Native.Read, 7, out handle);
        if (status >= 0) { scope.Keep(handle, name, false); throw new IOException("An owned probe name unexpectedly remained present"); }
        if (status != Native.NotFound && status != Native.PathNotFound) throw new IOException("Owned probe absence could not be verified");
    }
    private static void RequireNamedIdentity(SealedDirectories scope, OwnedHandle parent, string name, string identity) {
        var current = scope.Relative(parent, name, false, false, Native.Read, 7, false);
        if (Native.Information(current.Value).Identity != identity) throw new IOException("Held sentinel name was replaced");
        scope.CloseOwnedProbe(current, false);
    }
    private static void RequireDeleteSharingRefusal(SealedDirectories scope, OwnedHandle parent, string name, bool directory) {
        IntPtr handle; int status = Native.OpenRelative(parent.Value, name, directory, false, directory ? Native.DirRead | 0x10000u : Native.ReadDelete, 7, out handle);
        if (status >= 0) { scope.Keep(handle, name, false); throw new IOException("A peer acquired DELETE access to a protected probe entry"); }
        if (status != unchecked((int)0xc0000043)) throw new IOException("Protected DELETE open did not fail with sharing violation");
    }
    private static void ProbeSentinel(SealedDirectories scope, OwnedHandle baseDirectory, OwnedHandle directory, OwnedHandle sentinel, List<string> passed) {
        var sentinelLeaf = Path.GetFileName(sentinel.Name); var sentinelIdentity = Native.Information(sentinel.Value).Identity;
        RequireDeleteSharingRefusal(scope, baseDirectory, Path.GetFileName(directory.Name), true);
        // This peer has no DELETE access, as production's deny-delete share prevents acquiring it.
        var directoryPeer = scope.Relative(baseDirectory, Path.GetFileName(directory.Name), true, false, Native.DirRead, 7, false);
        if (Native.Rename(directoryPeer.Value, baseDirectory.Value, "parent-must-not-move") || Native.RenameError != 5) throw new IOException("Peer parent rename was not denied by DELETE access");
        scope.CloseOwnedProbe(directoryPeer, false);
        var parentControl = scope.Relative(baseDirectory, "parent-positive", true, true, Native.ProbeDirectoryAccess, 7, true);
        if (!Native.Rename(parentControl.Value, baseDirectory.Value, "parent-positive-renamed")) throw new Win32Exception(Native.RenameError, "Parent rename positive control failed");
        passed.Add("held-parent-rejects-peer-delete-and-rename");

        RequireDeleteSharingRefusal(scope, directory, sentinelLeaf, false);
        var deleteControl = scope.Relative(baseDirectory, "delete-positive", false, true, Native.ReadDelete, 7, true);
        if (!Native.DeleteOwnedPosix(deleteControl.Value)) throw new Win32Exception(Marshal.GetLastWin32Error(), "POSIX delete positive control unavailable");
        scope.CloseOwnedProbe(deleteControl, false); RequireMissing(scope, baseDirectory, "delete-positive");
        var peer = scope.Relative(directory, sentinelLeaf, false, false, 0x00100080, 7, false);
        if (Native.DeleteOwned(peer.Value) || Marshal.GetLastWin32Error() != 5) throw new IOException("Peer sentinel deletion was not denied");
        if (Native.DeleteOwnedPosix(peer.Value) || Marshal.GetLastWin32Error() != 5) throw new IOException("Peer POSIX sentinel deletion was not denied");
        scope.CloseOwnedProbe(peer, false); RequireNamedIdentity(scope, directory, sentinelLeaf, sentinelIdentity);
        passed.Add("held-sentinel-rejects-peer-delete-including-posix");

        var replacement = scope.Relative(baseDirectory, "rename-attacker", false, true, Native.ReadWriteDelete, 7, true);
        var renameControl = scope.Relative(baseDirectory, "rename-positive", false, true, Native.ReadWriteDelete, 7, true);
        if (!Native.RenameFlags(replacement.Value, baseDirectory.Value, "rename-positive", 3, true)) throw new Win32Exception(Native.RenameError, "POSIX replacement positive control unavailable");
        renameControl.Delete = false; scope.CloseOwnedProbe(renameControl, false);
        RequireNamedIdentity(scope, baseDirectory, "rename-positive", Native.Information(replacement.Value).Identity);
        if (Native.RenameFlags(replacement.Value, directory.Value, sentinelLeaf, 1, false)) throw new IOException("Basic replacement removed the held sentinel name");
        int error = Native.RenameError; if (error != 5 && error != 32) throw new IOException("Basic replacement did not exercise access/share refusal");
        RequireNamedIdentity(scope, directory, sentinelLeaf, sentinelIdentity);
        if (Native.RenameFlags(replacement.Value, directory.Value, sentinelLeaf, 3, true)) throw new IOException("POSIX replacement removed the held sentinel name");
        error = Native.RenameError; if (error != 5 && error != 32) throw new IOException("POSIX replacement did not exercise access/share refusal");
        RequireNamedIdentity(scope, directory, sentinelLeaf, sentinelIdentity);
        passed.Add("held-sentinel-rejects-basic-and-posix-replacement");

        // Link replacement need not acquire a DELETE handle on its existing target.
        // It is a separate required negative control, not inferred from the peer-open checks.
        var linkSource = scope.Relative(baseDirectory, "link-attacker", false, true, Native.ReadWriteDelete, 7, true);
        var linkControl = scope.Relative(baseDirectory, "link-positive", false, true, Native.ReadWriteDelete, 7, true);
        int linked = Native.LinkOwnedProbe(linkSource.Value, baseDirectory.Value, "link-positive");
        if (linked != 0) throw new IOException("POSIX link positive control unavailable: 0x" + unchecked((uint)linked).ToString("x8"));
        linkControl.Delete = false; scope.CloseOwnedProbe(linkControl, false);
        var ownedAlias = scope.Relative(baseDirectory, "link-positive", false, false, Native.ReadDelete, 7, false);
        if (Native.Information(ownedAlias.Value).Identity != Native.Information(linkSource.Value).Identity) throw new IOException("POSIX link positive control did not select the owned file");
        ownedAlias.Delete = true;
        linked = Native.LinkOwnedProbe(linkSource.Value, directory.Value, sentinelLeaf);
        if (linked >= 0) throw new IOException("POSIX link replacement removed the held sentinel name");
        if (linked != unchecked((int)0xc0000043) && linked != unchecked((int)0xc0000022)) throw new IOException("POSIX link replacement did not exercise access/share refusal");
        RequireNamedIdentity(scope, directory, sentinelLeaf, sentinelIdentity);
        passed.Add("held-sentinel-rejects-posix-link-replacement");
    }
    private static OwnedHandle ProbeDirectory(SealedDirectories scope, OwnedHandle parent, string name, List<Tuple<string, string>> cleanup) {
        var created = scope.Relative(parent, name, true, true, Native.ProbeDirectoryAccess, 7, true);
        string identity = Native.Information(created.Value).Identity, full = Native.FinalPath(created.Value);
        cleanup.Add(Tuple.Create(full, identity));
        scope.CloseOwnedProbe(created, false);
        // Match production directory access. Keeping DELETE access on a parent
        // conflicts with the rename operation's internal target-directory open.
        var directory = scope.Relative(parent, name, true, false, Native.DirAttributesWrite, 3, false);
        if (Native.Information(directory.Value).Identity != identity) throw new IOException("Owned probe directory identity changed");
        return directory;
    }
    internal static object Probe() {
        ProbePassed = false; var scope = new SealedDirectories(); var passed = new List<string>(); string failure = null;
        var cleanup = new List<Tuple<string, string>>();
        try {
            if (IntPtr.Size != 8 || Environment.OSVersion.Platform != PlatformID.Win32NT) throw new IOException("Windows x64 is required");
            var temporary = scope.Directory(SealedDirectories.Full(Path.GetTempPath()), false);
            var baseDirectory = ProbeDirectory(scope, temporary, "ZuorenMoveProbe-" + Guid.NewGuid().ToString("N"), cleanup);
            var outside = ProbeDirectory(scope, baseDirectory, "outside", cleanup);
            var mutable = ProbeDirectory(scope, baseDirectory, "mutable", cleanup);
            if (!Native.SetJunction(mutable.Value, Native.FinalPath(outside.Value))) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot exercise junction refusal");
            var leaf = "guard-" + Guid.NewGuid().ToString("N"); IntPtr candidate;
            int created = Native.OpenRelative(mutable.Value, leaf, false, true, Native.ReadDelete, 1, out candidate);
            if (created >= 0) scope.Keep(candidate, leaf, true);
            IntPtr escaped; int found = Native.OpenRelative(outside.Value, leaf, false, false, Native.Read, 1, out escaped);
            if (found >= 0) { scope.Keep(escaped, leaf, false); throw new IOException("Root-relative no-reparse creation escaped through a junction"); }
            if (found != Native.NotFound && found != Native.PathNotFound) throw new IOException("Could not verify the outside probe directory");
            passed.Add("relative-no-reparse-does-not-create-outside");
            var protectedDirectory = ProbeDirectory(scope, baseDirectory, "protected", cleanup); var sentinel = scope.Protect(protectedDirectory);
            if (Native.SetJunction(protectedDirectory.Value, Native.FinalPath(outside.Value))) throw new IOException("A held sentinel did not prevent reparse mutation");
            if (Marshal.GetLastWin32Error() != 145) throw new IOException("Reparse refusal was not the required directory-not-empty result");
            passed.Add("held-sentinel-prevents-directory-reparse");
            ProbeSentinel(scope, baseDirectory, protectedDirectory, sentinel, passed);
            var sourceDirectory = ProbeDirectory(scope, baseDirectory, "source", cleanup);
            var targetDirectory = ProbeDirectory(scope, baseDirectory, "target", cleanup); scope.Protect(sourceDirectory); scope.Protect(targetDirectory);
            var source = scope.Relative(sourceDirectory, "sample.md", false, true, Native.ReadWriteDelete, 1, true); scope.Write(source, Encoding.UTF8.GetBytes("original"));
            var foreign = scope.Relative(targetDirectory, "sample.md", false, true, Native.ReadWriteDelete, 1, true); scope.Write(foreign, Encoding.UTF8.GetBytes("foreign"));
            var foreignIdentity = Native.Information(foreign.Value).Identity;
            if (!Native.CloseHandle(foreign.Value)) throw new IOException("Could not release the probe target before no-replace test"); scope.Handles.Remove(foreign);
            if (Native.Rename(source.Value, targetDirectory.Value, "sample.md")) throw new IOException("No-replace rename replaced an existing file");
            foreign = scope.Relative(targetDirectory, "sample.md", false, false, Native.ReadDelete, 1, false);
            if (Native.Information(foreign.Value).Identity != foreignIdentity) throw new IOException("Probe destination identity changed"); foreign.Delete = true;
            if (scope.Hash(source) != Sha(Encoding.UTF8.GetBytes("original")) || scope.Hash(foreign) != Sha(Encoding.UTF8.GetBytes("foreign"))) throw new IOException("No-replace probe changed bytes");
            if (!Native.DeleteOwned(foreign.Value) || !Native.CloseHandle(foreign.Value)) throw new IOException("Cannot close owned probe target"); scope.Handles.Remove(foreign);
            if (!Native.Rename(source.Value, targetDirectory.Value, "sample.md")) throw new Win32Exception(Native.RenameError, "Relative rename failed");
            if (!String.Equals(Native.FinalPath(source.Value), Native.FinalPath(targetDirectory.Value).TrimEnd('\\') + "\\sample.md", StringComparison.OrdinalIgnoreCase)) throw new IOException("Rename did not select the authorized directory");
            passed.Add("relative-rename-and-no-replace");
            IntPtr writer; int blocked = Native.OpenRelative(targetDirectory.Value, "sample.md", false, false, 0x00100102, 7, out writer);
            if (blocked >= 0) { scope.Keep(writer, "writer", false); throw new IOException("Source lock did not reject another writer"); }
            if (blocked != unchecked((int)0xc0000043)) throw new IOException("Source writer did not fail with sharing violation");
            passed.Add("source-handle-excludes-concurrent-write");
        } catch (Exception error) { var native = error as Win32Exception; failure = error.Message + (native == null ? "" : " (Win32 " + native.NativeErrorCode.ToString() + ")"); }
        finally {
            scope.Dispose();
            for (int index = cleanup.Count - 1; index >= 0; index--) {
                var item = cleanup[index];
                var handle = Native.CreateFile(@"\\?\" + item.Item1, Native.ReadDelete, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                if (handle == new IntPtr(-1)) { scope.CleanupWarning += " Probe directory cleanup could not reopen its owned identity."; continue; }
                try {
                    if (Native.Information(handle).Identity != item.Item2 || !Native.DeleteOwned(handle)) scope.CleanupWarning += " Probe directory cleanup was not confirmed.";
                } catch (Exception) { scope.CleanupWarning += " Probe directory cleanup identity could not be checked."; }
                finally { if (!Native.CloseHandle(handle)) scope.CleanupWarning += " Probe directory cleanup handle did not close."; }
            }
        }
        if (scope.CleanupWarning.Length != 0) failure = failure == null ? scope.CleanupWarning : failure + "; " + scope.CleanupWarning;
        if (failure != null) return new { status = "unsupported", error = failure, cases = passed.ToArray() };
        ProbePassed = true;
        return new { status = "supported", protocol = 2, cases = passed.ToArray(), platform = Environment.OSVersion.VersionString, pointerSize = IntPtr.Size };
    }
    internal static string ResultStatus(object result) {
        var dictionary = result as IDictionary<string, object>; object value;
        if (dictionary != null) return dictionary.TryGetValue("status", out value) ? value as string : null;
        var field = result == null ? null : result.GetType().GetProperty("status");
        return field == null ? null : field.GetValue(result, null) as string;
    }
    internal static int ResultExitCode(object result) {
        switch (ResultStatus(result)) {
            case "supported": case "moved": case "receipt": return 0;
            case "unsupported": return 3;
            case "failed": return 4;
            case "uncertain": return 5;
            case "unresolved": return 6;
            default: return 2;
        }
    }
    internal static bool IsSuccessful(object result) { return ResultExitCode(result) == 0; }
    internal static string ReadInput(TextReader reader) {
        var clock = Stopwatch.StartNew(); var input = new StringBuilder(); var buffer = new char[4096]; int count;
        while ((count = reader.Read(buffer, 0, buffer.Length)) != 0) {
            if (clock.ElapsedMilliseconds > 30000 || input.Length + count > 64 * 1024 * 1024) throw new IOException("Input exceeded its bound");
            input.Append(buffer, 0, count);
        }
        return input.ToString();
    }
    internal static object PersistResult(ReceiptLease lease, object result) {
        try { lease.Persist(result); return result; }
        catch (Exception) { lease.InvalidateAfterWriteFailure(); return new { status = "uncertain", error = "Worker completion could not be confirmed." }; }
    }
    private static int Run(string[] args) {
        bool readReceipt = args.Length == 1 && args[0] == "--read-receipt", probeOnly = args.Length == 1 && args[0] == "--probe";
        bool dispatchedMove = false; ReceiptLease lease = null; int exitCode = 2;
        try {
            Console.InputEncoding = new UTF8Encoding(false, true);
            Console.OutputEncoding = new UTF8Encoding(false); Console.WriteLine("{\"event\":\"ready\",\"protocol\":2}"); Console.Out.Flush();
            var json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024, RecursionLimit = 16 }; object result;
            if (readReceipt) {
                var input = json.Deserialize<ReceiptInput>(ReadInput(Console.In));
                lease = ReceiptLease.Acquire(input, false);
                result = new { status = "receipt", receipt = lease.Read() };
            } else if (probeOnly) result = Probe();
            else {
                var input = json.Deserialize<MoveInput>(ReadInput(Console.In));
                // This is before Probe and before the first user-root sentinel.
                // Nonempty/busy/replaced receipts never permit another Move.
                lease = ReceiptLease.Acquire(input, true); dispatchedMove = true;
                Probe();
                result = ProbePassed ? Move(input, lease) : new { status = "failed", error = "Native qualification failed before user-file operations." };
                result = PersistResult(lease, result);
            }
            exitCode = ResultExitCode(result);
            Console.WriteLine(json.Serialize(result)); Console.Out.Flush();
        } catch (Exception) {
            object result = readReceipt ? (object)new { status = "unresolved" }
                : probeOnly ? (object)new { status = "unsupported", error = "Native qualification could not be confirmed." }
                : new { status = "uncertain", error = "Worker completion could not be confirmed." };
            if (dispatchedMove && lease != null && !lease.WriteAttempted) result = PersistResult(lease, result);
            exitCode = ResultExitCode(result);
            try { Console.WriteLine(new JavaScriptSerializer().Serialize(result)); Console.Out.Flush(); }
            catch (Exception) { /* Missing or multiple final lines remain unresolved at the caller. */ }
        } finally {
            if (lease != null) {
                try { lease.Dispose(); if (lease.CleanupWarning.Length != 0) exitCode = readReceipt ? 6 : 5; }
                catch (Exception) { exitCode = readReceipt ? 6 : 5; }
            }
        }
        return exitCode;
    }
    private static int Main(string[] args) { if (args.Length == 1 && args[0] == "--layout") { Console.WriteLine(Layout()); return 0; } return Run(args); }
}
