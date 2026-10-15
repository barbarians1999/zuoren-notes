# 本地交付与 GitHub 发布

本地对话负责开发整合、验证、Windows Setup、`D:/exe` 同步与本地产物回收。GitHub 专门对话消费同一份已验收包；本地入口没有远端操作，不创建标签、不触发 Mac、不自动安装或关闭用户应用。

## 1. 确定范围并提交

先核对工作区、确定版本与发布范围，审查源码、`package.json`、锁文件、CHANGELOG 和回归，再明确暂存并提交。脚本不自动暂存或提交。正式构建要求干净工作区。

入口是 `pnpm release`；`pnpm package:installer` 只是同一入口的别名，不再额外跑一遍 `verify`。低层 `scripts/installer.cjs` 只制作构建，不等于验收。不要叠加执行多个完整入口。

本机先加载 Codex workspace dependencies，使用返回的 bundled Node、pnpm、Git 的绝对路径。将 bundled Node 所在目录前置 PATH，设置 `ZUOREN_RELEASE_GIT` 为 bundled Git。不要调用 WindowsApps 的 Python stub。

```powershell
pnpm release --profile markdown --cleanup
pnpm release --profile ui --cleanup
pnpm release --profile full --cleanup
```

没有 `--cleanup` 时不回收项目旧产物；正式本地验收后始终尝试 D 盘同步。D 盘同步退役旧包也受回执与可恢复性保护。独立记录失败，不让 GitHub 状态阻塞本地回收。

## 2. 唯一测试计划定义

`scripts/verification-plan.cjs` 是档位和测试文件集合的唯一实现来源。回执展开记录实际文件，不靠一个档位名称代替验证范围。

| 档位 | 源码检查 | 实际包内检查 |
| --- | --- | --- |
| `ui` | 窗口／主题、标签、路径重用、全屏、EPUB 工作区与搜索、PDF 工具栏、共享交互 | 同类检查，加平台基本保存／撤销／阅读／恢复 |
| `markdown` | 连续源码编辑、显示映射、交互、剪贴板、换行、组合语料、文档生命周期与阅读待办 | 同一组，加平台基本检查；不走全量阅读器测试 |
| `full`（默认） | editor/readers/workspace 集合并去重 | 同一集合，加平台基本检查 |
| `directed` | 自定义文件，加连续源码编辑与文档生命周期底线 | 自定义文件，加上述底线及平台基本检查 |

所有档位均做类型检查、生产构建和全部单测；包内检查使用明确的 `win-unpacked/ZuorenNotes.exe`，随后验证安装器内 ASAR 与实际测试的程序一致、产物与本次构建一致、图标一致。`ui`、`markdown`、`directed` 不是完整发布回归。保存／恢复／撤销或持久化模型改动须选 full 或写明覆盖风险的 directed 计划，不能只选颜色检查。

自定义计划是包含 `reason`、`source`、`packaged` 数组的 JSON；只允许本仓库 `tests/NAME-smoke.cjs`，保留固定的数据保护底线。历史 `directed-ui` 名称不自动转换为验证通过。

```powershell
pnpm release --profile directed --plan docs/verification-plans/0.3.12.json --cleanup
```

当前 0.3.12 将此前未提交的 0.3.10／0.3.11 窗口、主题、共享交互、迁移路径及 0.3.12 Markdown 修复一并纳入源码提交，使用上述组合计划；不借用旧报告冒充本次验证。

开发时单独运行测试：

```powershell
pnpm test
pnpm test:editor
pnpm test:readers
pnpm test:workspace
node scripts/test-ui.cjs --files tests/markdown-presentation-smoke.cjs
```

所有 Electron 测试从 `tests/electronHarness.cjs` 获取 Playwright；即使直接 `node --test` 运行，也先争用同一个本机桌面互斥。统一 runner 在测试超时开始前等待互斥，文件进程串行；独立 shell 不能同时抢鼠标、剪贴板和原生焦点。互斥由内核 socket 持有，进程崩溃自动释放，不能手动伪造所有权环境变量。

纯样式断言与真实鼠标／键盘断言分开解释。等待实际动画完成、窗口内容尺寸、PDF 文字层版本、EPUB reflow 与字体就绪，不用固定延时替代就绪判断。显式失焦测试关闭 Playwright 焦点模拟，不能为模拟造成的假故障给产品加补丁。

## 3. 回执与阶段状态

`releases/版本/VALIDATION.json` 的 schemaVersion 为 2，至少包括：

- `version`、`kind`（`official` 或 `local-test`）、`sourceCommit`、`source.commit/dirty`、原始构建输入的逐文件 SHA256 与汇总。
- `source.lockFile` 的路径、实际文件 SHA256 和提交中的 Git blob 身份；Node、Electron 版本。
- `verificationCommit`，验证计划、原因、档位、展开的单元／源码／包内文件与计划哈希。
- 各阶段通过数量、输入哈希、日志路径和完成时间；安装器载荷／图标检查。
- 安装包绝对目录、文件名、字节数和 SHA256，实际应用 ASAR 与 EXE 哈希。
- `localAcceptance.status=passed` 与完成时间。没有这些证据的历史回执不直接升级为正式回执。

`BUILD.json` 记录可恢复检查点，源码与包内 UI 逐个测试文件保存通过证据，单项失败不会抹掉其他已通过文件。每次运行日志在 `logs/releases/版本/runs/时间/`，历史回执先归档再更新，不覆盖历史失败证据。`SHA256SUMS.txt` 使用实际本地文件名；GitHub 上传另生成使用公开文件名的校验清单。

`logs/releases/版本/LOCAL-DELIVERY.json` 分别记录验收、同步、清理与未执行的 GitHub 状态。退出码 0 表示所请求阶段完成，2 表示包已验收但同步／退役仍有待处理，1 表示构建或验证未获验收。清理失败不撤销已通过的包验收。

历史 0.3.10／0.3.11 的局限见 [release-history-limitations.md](release-history-limitations.md)。不更改原 sourceCommit 或把旧手工数量改称新档位通过。

## 4. 恢复与复用

同一包不因切换对话、上传失败或 Mac 失败重做：

```powershell
pnpm release --profile markdown --resume --cleanup
pnpm release --profile directed --plan docs/verification-plans/0.3.12.json --resume --cleanup
```

也可用 `--receipt C:/绝对路径/releases/版本/VALIDATION.json --resume` 明确回执。现有构建必须与源码输入、依赖锁、运行时及包文件哈希一致。单测、源码 UI、包内 UI 的输入独立比较；UI 按文件复用，只有失败或身份变化的文件重验，共享 helper／夹具／驱动脚本变化则覆盖受影响的集合。测试变化本身不重制安装包，无关文档或对话变化不会重做包。应用源码、依赖或运行时改变则拒绝复用已有包，先准备新版本，不能覆盖旧目录。

没有 BUILD 检查点的历史包拒绝自动续用。失败安装器的目录不自动覆盖；先保留诊断并检查具体失败阶段。只有目录中尚未产生任何包、仅存在 BUILD 检查点时，源码修复后的 `--resume` 才能归档旧检查点并重新构建，不能把旧测试沿用为新源码通过。不要反复重跑直到偶然通过。

本地未提交测试包须显式：

```powershell
pnpm release --profile markdown --local-test
```

输出在 `releases/local-test-版本-输入身份/`，回执保留 dirty 与快照。它不自动同步、不退役正式包，不能用于 GitHub 发布。正式交付仍须提交后另建，不改标记冒充正式包。

失败诊断包含测试 TAP、页面错误、截图、原生焦点、activeElement、hover、动画、窗口尺寸与阅读器状态，保存在运行日志目录。先据证据分类：产品缺陷修源码；过期断言修预期；焦点／运行条件修 harness。保留原安全断言，说明定向复验范围。

## 5. 同步与可恢复回收

两个低层操作均要求显式 schema-2 回执及 bundled Node，不能根据当前 package.json 较高版本推断可以清理。以下命令不带 `-Apply` 时只预览：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-installer.ps1 -Receipt C:/项目/releases/版本/VALIDATION.json -NodeExecutable C:/已加载/node.exe -Apply
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/recycle-old-releases.ps1 -Receipt C:/项目/releases/版本/VALIDATION.json -NodeExecutable C:/已加载/node.exe -Apply
```

统一入口自动传递这些参数。回收实现只有 `scripts/artifact-recycle.ps1` 一份：检查绝对路径、父目录与符号链接、运行进程、真实回收站占用与安全余量，归档旧日志，以原生无交互回收操作处理，逐文件核对回收载荷。失败停止该目标并登记 pending；不永久删除唯一副本、不修改系统容量、不强制关闭应用。

D 盘可能是可移动磁盘：新包先复制并校验；旧包复制到固定盘、回收并校验可恢复载荷后，才删除 D 盘相同的重复件。其他软件、更高版本或正在运行的包不动。待处理清单位于 `d-exe-sync-时间.json` 和 `logs/cleanup/时间-版本/summary.json`。已成功退役的目标不重复执行。

保护源码、Git、依赖、用户资料、恢复稿、救援备份和 `work/legacy-workspace/`。独立社科书架不在清理范围。回收不等于立即释放磁盘；容量不足保留原件并交接待处理清单。

## 6. GitHub 对话标准交接

本地入口生成 `logs/releases/版本/GITHUB-HANDOFF.json`，交接时携带它、其引用的原始 VALIDATION、安装器和 SHA256 清单，以及对应源码提交。标准内容：

```text
版本 / 预期 tag：
源码提交 / 验证提交：
依赖锁 SHA256 / Git blob：
回执绝对路径 / 回执 SHA256：
安装包绝对路径 / 公开文件名 / 字节数 / SHA256：
验证档位、展开计划、已通过范围和未覆盖范围：
本地验收 / D 盘同步 / 本地清理及 pending 清单：
本轮远端操作：未执行。请发布同一份包，不重建 Windows。
```

GitHub 专门对话显式执行：

```powershell
pnpm release:github --receipt C:/项目/releases/版本/VALIDATION.json
# 仅明确需要两架构 Mac 时添加 --with-mac；失败后可添加 --resume。
```

远端入口不构建、不安装、不处理本地清理；只推送回执对应提交，核对版本／依赖锁和不可变包哈希后上传。Mac 构建仅显式 `--with-mac` 触发。最终成功条件同时要求 Release ID、`tag_name`、解析后的标签提交、非草稿／非 prerelease、latest 的 ID 与标签、每项资产大小及 SHA256 一致；错误 `untagged-*` 必须报错，不能凭 Git tag 或一次上传成功宣称发布完成。

网络错误最多一次等效重试；仍失败就报告外部阻塞，不无限轮询重试。Windows 包与本地回收状态独立保留，失败从对应阶段恢复。
