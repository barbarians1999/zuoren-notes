# 左人笔记

<img src="electron/assets/app-constructivist.png" width="112" align="right" alt="左人笔记图标" />

面向本地资料阅读与 Markdown 写作的 Electron 桌面笔记软件，提供 Windows 安装版和 macOS 测试版。以 Markdown 为核心，也可以在同一工作区阅读 PDF、EPUB，并把摘录整理进笔记。

**[下载安装包（0.3.3）](https://github.com/barbarians1999/zuoren-notes/releases/tag/v0.3.3)** · [查看全部版本](https://github.com/barbarians1999/zuoren-notes/releases)

- [Windows · x64 安装版](https://github.com/barbarians1999/zuoren-notes/releases/download/v0.3.3/ZuorenNotes-Setup-0.3.3.exe)
- [macOS · Apple 芯片（arm64）测试版](https://github.com/barbarians1999/zuoren-notes/releases/download/v0.3.3/ZuorenNotes-0.3.3-macOS-arm64.dmg)
- [macOS · Intel（x64）测试版](https://github.com/barbarians1999/zuoren-notes/releases/download/v0.3.3/ZuorenNotes-0.3.3-macOS-x64.dmg)

Mac 版分别在对应架构的 macOS 环境构建，通过单元测试与定向包内检查；尚未完成完整 Mac 发布回归。仅有 ad-hoc 完整性签名，**未提供 Apple Developer ID 签名或公证**，首次打开可能被系统拦截。请仅从可信来源下载，在系统设置的“隐私与安全性”中核对后允许打开。[验证范围与构建说明](docs/macos-build.md) · [Mac SHA256 校验清单](https://github.com/barbarians1999/zuoren-notes/releases/download/v0.3.3/macOS-SHA256SUMS-0.3.3.txt)

下方为左人笔记 0.3.3 的实际运行截图，笔记与书籍内容使用演示样本。

## 功能预览

### Markdown 写作

![Markdown Live Preview 实际运行截图](docs/previews/markdown.png)

提供接近 Obsidian 的 Live Preview 编辑方式：在 Markdown 源文本中直接写作，标题、列表、引用、表格等格式在编辑时即时呈现，并支持撤销与自动保存。

### PDF 阅读与摘录

![PDF 深色阅读实际运行截图](docs/previews/pdf.png)

支持页码跳转、缩放、全文查找、文字选择、高亮、批注和摘录；深色模式下可切换深色阅读效果。摘录可进入当前笔记，方便边读边整理。

### EPUB 阅读

![EPUB 阅读实际运行截图](docs/previews/epub.png)

支持目录导航、双页阅读、滚轮或方向键翻页、全书搜索，以及把选段摘录到笔记。

## 主要特点

- **本地文件优先**：笔记和书籍保存在你自己的文件夹中，不要求使用云服务。
- **写作与阅读连贯**：Markdown、PDF、EPUB 和笔记分栏协作，阅读摘录可回到笔记中继续编辑。
- **保护编辑内容**：自动保存、撤销、恢复稿和外部文件冲突保护，尽量避免意外丢失修改。
- **专注阅读**：支持阅读位置恢复、PDF 标注与 EPUB 目录和搜索。
- **桌面应用**：提供 Windows 安装版与 macOS 测试版，并支持从文件或文件夹打开资料；Linux 尚未构建或验证。

## 字体说明

汉仪书仿 55W 字体文件不上传到本仓库，也不包含在安装包中。请通过合法渠道自行下载并安装到本机，之后即可在软件设置中选择；如果本机没有安装该字体，对应选项将无法正常显示该字体效果。

## 获取与开发

从 [GitHub Releases](https://github.com/barbarians1999/zuoren-notes/releases/latest) 下载对应系统和芯片的安装包。Mac 打开 DMG 后，将应用拖入“应用程序”文件夹；Windows 与 Mac 安装包不能互换。

开发环境需要 Node.js 与 pnpm：

```powershell
pnpm install
pnpm build
pnpm start
```

常用验证与打包命令：

```powershell
pnpm test
pnpm test:readers
pnpm package:installer
```

Mac 打包需在原生 Mac 上运行 `pnpm package:mac`，或手动触发仓库的 **Build and publish macOS packages** 工作流；不要在 Windows 上运行 Mac 打包命令。Electron 可复用主要业务代码，但系统路径、原生菜单、字体和文件关联仍需逐平台适配和验证。

项目目前未附带开源许可证；如需再分发源码或构建产物，请先确认第三方字体及依赖的许可条件。
