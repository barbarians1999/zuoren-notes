# 0.2.34 输入焦点与正文思源宋体

日期：2026-10-07。

## 用户报告与证据边界

用户报告偶发正文不能落光标、只能选中整段，并经常同时无法操作正文字体选择。用户不能确定自发触发步骤。本轮未稳定复现原始偶发故障，因此不声称找到或排除了所有原因。

检查方法参考 find-bugs，范围限于当前输入问题与字体入口，不是重做全仓架构或安全审计。已有大规模未提交改造保持原样。

确认的代码缺口：Electron 原生窗口与渲染内容焦点分别管理，原先没有处理活动窗口内容失焦或原生文件窗口返回的内容焦点恢复；回收站仍使用阻塞式 window.confirm。两处与症状吻合，但不是确定的自发触发证据。

## 实施

- 新增 `electron/window-focus.cjs`：活动窗口重新激活或收到 mouseDown 且内容失焦时恢复 webContents；原生文件选择、另存为、重新定位窗口以同一包装器执行，完成/取消/拒绝均收尾。嵌套窗口全部结束后才恢复；销毁和后台窗口不抢焦点，无定时器、无轮询、无正文选择操作。
- `electron/main.cjs` 注册以上窗口生命周期并统一六处原生对话调用；授权、文件读写、保存队列不变。
- `DocumentDialogs.tsx` 新增回收站确认框：默认取消、Esc 取消、Tab/Shift+Tab 圈定按钮并恢复可用焦点。`main.tsx` 锁定原文件条目，确认后仍按原工作区提交锁、保存、阅读 flush、回收与 finally 解锁执行；取消不触及资料。已有冲突/未保存提示优先，不叠加确认。
- 正文字体新增 `source-han-serif`，使用现有 Adobe Source Han Serif SC 可变 WOFF2，SIL OFL 1.1 原许可保留。Markdown 编辑与阅读通过现有字体 CSS 变量生效；EPUB 注入同一字体 @font-face。偏好可重启恢复，系统 UI、标题配置与 PDF 原文件字体不改。
- 原仿宋选项明确显示“字体管家仿宋（内置）”。`ZhaoyeFangSong.ttf` 是文件名，`Zhaoye Reading` 是 CSS 别名；实际内部名称是 AaFangSong (Non-Commercial Use) / 字体管家仿宋体（非商业使用），并非独立创造的新字体。该字体的公开分发授权尚未核实，本轮未替换原用户选择。

## 复核范围与安全清单

完整复核本轮新增 `window-focus.cjs`、`window-focus.test.cjs`、`input-focus-smoke.cjs` 及新增确认组件；既有 main、EPUB、设置、字体映射与测试复核当前修改及相关调用部分，不将其报告为全文件/全仓安全审计。既有 EditorView、NoteDocument 与全文保存算法本轮不修改。

- 注入/XSS：文件名通过 React 文本转义；字体 CSS 仅来自内部枚举和内置静态资源，不注入用户字体 URL或执行内容。
- 身份/授权/CSRF：不新增 IPC 通道；原可信主帧检查、路径授权与文件回收边界不变。无 Web 服务/认证变更。
- 竞态/生命周期：对话深度、窗口销毁与后台状态检查；确认绑定原条目，原持久化提交锁与 finally 释放保留。
- 加密/信息泄露：未改加密或记录用户正文，无新增敏感日志。
- 资源/DoS：事件监听一组/窗口，closed 清理，不为每次点击重建编辑器或增加持续扫描。
- 业务逻辑：取消默认不删除；确认后保存失败仍阻止回收；字体变更不形成正文 transaction、不改原 EPUB。
- 未验证范围：用户随机故障的完整触发路径、所有外部 OS 焦点行为、原仿宋分发授权以及全仓未改动安全问题。

## 验证

- 构建通过；单元测试 166/166，含 4 项焦点模块单测。
- 最新源码定向 3/3：input-focus、appearance、electron-smoke。
- 包内定向 12/12（含子测试）：input-focus、appearance、document-lifecycle、note-tabs、readers、window-startup、electron-smoke。
- 焦点回归：实际失活/重新激活，正文中间落光标、输入/撤销、部分文字拖选；六次应用内确认取消/Tab/Esc、原目录保留；实际鼠标打开字体下拉、键盘选择思源宋体；编辑器 DOM 身份保持。EPUB 字体实际加载、原书逐字节不变，已查看编辑与 EPUB 截图。
- 既有 appearance 测试初次在菜单入场的 opacity=0 帧采样失败，修正为等待真实动画完成再检查；未删背景/透明度断言，源码复查和包内组合运行通过。
- 安装包嵌入 app.asar 与测试程序一致；39 个文件与当前构建逐字节一致；EXE/Setup 新图标资源匹配。
- 不跑完整发布链，不自动安装、不修改用户真实设置或资料、不退出用户运行中的程序。

## 交付与清理

Setup：`C:/Users/User/Documents/ChatGPT/笔记软件/releases/0.2.34/左人笔记-Setup-0.2.34.exe`，225996496 bytes。

SHA256：`aaa38dadaf69fe3e12b7b1147f4e323ea4424112ca7e71da08c91971e77de2a9`。

验证后归档旧发布日志，再将已核实的 0.2.33 发布产物、旧 ui 输出和本次临时 installer staging 回收。`outputs/ui-0.2.28` 仍按此前 Windows 回收失败记录暂缓，不重复操作。清理实际结果见工作区 `logs/cleanup`。
