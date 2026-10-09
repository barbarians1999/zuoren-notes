# 左人笔记

左人笔记是一款面向本地资料阅读与 Markdown 写作的 Windows 桌面软件，使用 Electron、React、TypeScript 和 CodeMirror 构建。

## 功能

- Markdown 连续编辑与即时预览、撤销和自动保存
- PDF 阅读、全文查找、选字高亮、批注与摘录
- EPUB 双页阅读、目录和全书搜索
- 双栏笔记、标签切换、深浅主题、字体与阅读位置恢复
- 本地文件管理；原始笔记和书籍保留在用户自己的文件夹中

## 开发

需要 Node.js 与 pnpm。安装依赖后可运行：

```powershell
pnpm install
pnpm build
pnpm start
```

运行与本地构建输出：

```powershell
pnpm test
pnpm test:readers
pnpm package:installer
```

项目目前不附带开源许可证；如需再分发源码或构建产物，请先确认第三方字体及依赖的许可条件。
