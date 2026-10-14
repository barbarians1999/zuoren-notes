# 统一发布入口

完成代码审查后，先更新 `package.json` 版本和 `CHANGELOG.md` 并提交。脚本不会自动暂存或提交工作区里的改动，也不会自动安装应用。

普通 UI 小改动：

```sh
pnpm release --profile ui --publish --cleanup
```

涉及保存、恢复、撤销、编辑模型或阅读器行为的改动：

```sh
pnpm release --profile full --publish --cleanup
```

未指定 profile 时默认 `full`。`ui` 包含全部单元测试，源码窗口／共享标签生命周期／路径重用，以及实际包内同类检查和 Markdown/PDF/EPUB 基本操作；**不代表完整发布回归**。完整模式使用项目现有源码与包内回归集合。特殊故障仍需添加对应回归，不能只凭一个统一入口保证没有新 bug。

流程顺序：生产构建 → 相关源码检查 → Windows 安装包 → 实际包检查 → 安装器正文和图标核验 → Windows 上传到草稿 Release → 两种 Mac 原生构建与包内检查 → 三平台校验值核对 → 公开新版本 → 本机旧产物移入回收站。

任何一步失败都停止，不删除旧版本、不自动安装、不强制退出正在使用的应用。GitHub 使用已有登录凭据，不在日志中记录令牌；云端 Mac 包不下载到本地，仍为未 Developer ID 签名／公证的测试版。不修改付费额度。

只在本地构建与验证，不发布：

```sh
pnpm release --profile ui
```

如果本地包已验证成功、仅上传或 Mac 云端阶段失败：

```sh
pnpm release --profile ui --publish --cleanup --resume
```

恢复要求代码提交、版本、profile、安装包、ASAR 和执行文件都与验证记录一致；不重做 Windows 安装包。若 Mac 阶段失败，先查看并处理失败原因，显式恢复会重新运行失败的云端阶段。不循环重试网络错误。没有验证记录的失败构建必须先检查，脚本不擅自覆盖原目录。

发布日志在交付目录 `logs/releases/版本`，每一步都有记录；包内报告与 SHA256 清单同时随 Release 提供。清理仅处理已核实的本机旧安装包、测试输出及打包暂存，历史日志保留；用途不明、用户资料、源码、依赖、恢复和救援目录不动。不会删除 GitHub 的历史 Release。

在本机 Codex 环境，按 `AGENTS.md` 使用加载得到的 bundled Node；可通过 `ZUOREN_RELEASE_GIT` 指定 bundled Git 的绝对路径。

## D 盘安装包同步

统一 `pnpm release` 入口在本地验证完成后（使用 `--publish` 时则等云端发布成功），自动同步最新版安装包到 `D:\exe`。先复制、核对 SHA256，再回收同目录中版本号更低的左人笔记 Setup；不处理其他软件、新于当前版本的包或运行中的安装器，不自动安装。

D 盘当前是可移动磁盘，因此旧包先复制到固定磁盘并核对、移入 Windows 回收站，确认回收内容哈希一致后，才删除 D 盘的旧副本。可在回收站恢复该副本并放回 D 盘。回收容量不足、文件占用或任何校验失败时保留旧文件，不永久删除唯一副本。同步清单、原路径、回收路径及 SHA256 留在 `logs/releases/版本/d-exe-sync-时间.json`。

低层 `scripts/installer.cjs` 只构建，不代表验收完成，不触发同步。采用定向检查手工打包时，先完成并归档同格式 `VALIDATION.json`（包括包内检查、正文和图标校验），再执行以下命令；不带 `-Apply` 仅预览：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-installer.ps1 -Apply
```
