# 按钮字体来源

- 字体：Adobe Source Han Sans / 思源黑体，简体中文可变 WOFF2，原文件未修改、未子集化。
- 官方项目：https://github.com/adobe-fonts/source-han-sans
- 下载：https://raw.githubusercontent.com/adobe-fonts/source-han-sans/release/Variable/WOFF2/OTF/SourceHanSansSC-VF.otf.woff2
- 许可：SIL Open Font License 1.1，原许可随发行程序保留。
- `Zhaoye Buttons` 对应打包产物使用 `scripts/build-ui-font-subset.py` 从原文件子集化生成的 `src/assets/ZhaoyeButtons-Subset.woff2`（含可打印 ASCII、常用符号、源码界面字符及 GB2312 一级简体汉字，保留 `wght` 可变字重轴）。按 SIL OFL 1.1 保留字体名要求，子集字体内部名称已替换为 `Zhaoye Buttons` / `ZhaoyeButtons`，原许可随发行程序保留。本字体用于按钮，侧栏其他文字仍使用等宽字体。
