# 文件移动：18 项 managed 故障回归复现

入口：`scripts/test-file-move-managed.py`。Python 3 标准库脚本，显式使用已有本地工具；不下载或安装工具，不改系统设置，不运行生产 worker、Electron 或 Windows API。

## 运行

从仓库根目录执行，路径需替换为本机已有工具的实际位置：

```powershell
python scripts/test-file-move-managed.py `
  --dotnet "C:\tools\dotnet\dotnet.exe" `
  --compiler "C:\tools\roslyn\tasks\netcore\bincore\csc.dll" `
  --references "C:\tools\net48\build\.NETFramework\v4.8" `
  --runtime-version 8.0.33
```

`--dotnet` 指已有 .NET runtime 的可执行文件，`--compiler` 指 Roslyn `csc.dll`，`--references` 指含 `mscorlib.dll` 的 .NET Framework 4.8 引用程序集目录。当前回执使用官方 Roslyn 4.11 和 .NET runtime 8.0.33。脚本默认允许向已安装的新主版本 runtime 滚动，实际 runtime 版本和指针大小记录在运行日志中。没有对应 runtime/编译器/引用时停止，不自动安装。

可用 `--source` 指定待审 C# 副本，用 `--output` 指定文本输出目录。默认读取本 checkout 的 `electron/native/FileMoveWorker.cs`；输出到 `logs/file-move/managed-<源码SHA前12位>/`。

## 它实际验证什么

每次从当前生产源重新提取 `CleanupFailure`、`Dispose`、`Run`、`ResultExitCode`、`IsSuccessful`，以及实际 `Move`/`Probe` 的清理后状态门禁。仅为调用将 Run 的可见性改为 internal；Native、Probe/Move 的原生主体、JSON serializer 和输入输出故障是明确的无害 managed mock。源码提取结构变化、增加未审查 native 调用、Probe 在清理前启用、编译或断言失败都返回非零。

18 项断言覆盖：删除/关闭返回 false 或抛异常后的完整关闭、未知句柄保留、非 owned 句柄不删除、清理幂等、Probe 成功与拒绝退出码、移动派发后的序列化/输出/Flush 故障、派发前解析失败、成功结果、清理门禁，以及 `0/3/4/5/2` 状态退出码。

生成源码为 `ManagedFaultRegression.generated.cs`；回执记录生产源 SHA、生成器 SHA、提取方法 SHA、生成源码 SHA、工具 SHA、18 项名称和实际 runtime。编译产物及 runtimeconfig 只在脚本自建临时目录，结束后删除；永久目录只保存 `.cs`、`.json` 和 `.log`。

**这些测试不验证 NtCreateFile、reparse、POSIX、NTFS 或 Windows 进程行为，也不构成 Windows GUI 验收。回执始终标记 `windows_api_invoked:false`、`windows_native_probe_pass:false`、`release_ready:false`。** Windows 实测另见原生验证清单和 `scripts/test-file-move-native.cjs`，不能用本回归替代。

## 当前交接证据

生产 C# SHA256：`3a16d17ee5452c27b46923fa8ac8e75d468ef6b2260c63bfbddd6b98903925cb`。

- `logs/file-move/managed-3a16d17ee545/ManagedFaultRegression.generated.cs`
- 同目录 `managed-regression-receipt.json`、`managed-regression-compile.log`、`managed-regression-run.log`
- 同目录 `managed-regression-mutation-checks.json`：仅在自建临时副本中削弱 Move 清理门禁、派发后退出码、清理异常捕获、Probe 清理前启用；4 个副本均被拒绝，生产源未改。

复现时须核对回执的源码和生成器 SHA；源码变化后重新运行，不能沿用旧回执。
