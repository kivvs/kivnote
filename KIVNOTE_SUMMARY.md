# KivNote 项目完整概述（截至 2026-10-23 v3.4.0）

> 本文档用于跨对话框续接。下次新开对话时，先读本文件即可快速恢复上下文。

---

## 1. 项目是什么

**KivNote** —— 一个基于 **Electron 33 + 原生 JS** 的**跨格式文件查看 / 编辑器**。
一句话定位：拖进任意文件就尽量能看、能改、能导出。

- GitHub：`https://github.com/kivvs/kivnote`
- 本地路径：`C:/Users/Lenovo/WorkBuddy/2026-10-21-14-15-36/app`
- 当前版本：**v3.4.0**（已打 tag、已发 Release）

### 支持的格式
| 类别 | 格式 |
|------|------|
| 表格/数据 | xlsx、csv、tsv |
| 文档 | PDF（查看+文本层+缩略图+查找+旋转/导出页） |
| 文本/代码 | txt、md、js/ts/py/json/sh/sql/java/c/go/php 等（行号+语法高亮+编码切换） |
| 演示 | ppt/pptx（查看） |
| 图片 | png/jpg/...（缩放切换） |
| 二进制 | 十六进制查看 |

---

## 2. 技术栈与关键文件

| 文件 | 作用 |
|------|------|
| `main.js` | 主进程：窗口、菜单、IPC（`file:save` 等）、最近文件、编码保存 |
| `preload.js` | 上下文桥接 |
| `renderer/index.html` | 主界面（已抽离 CSS） |
| `renderer/style.css` | 抽出后的样式（约 26KB，主文件从 156→128KB） |
| `renderer/pdf.js` `pdf.worker.js` | PDF.js |
| `renderer/pdflib.js` | pdf-lib 按需加载（旋转/导出页） |
| `renderer/sheetjs.js` | SheetJS 保格式写入 |
| `renderer/help.md` | 内置帮助，版本号在此同步 |
| `scripts/fetch-loffice.py` `make-zip.py` `check-syntax.js` | 构建/校验脚本 |
| `tests/run-tests.js` | 12 个单元测试，从源码提取真实函数测 |
| `CHANGELOG.md` `使用说明.md` `README.md` `README.dev.md` `CONTRIBUTING.md` | 文档 |

> ⚠️ **JS 未拆分**：曾计划把大 JS 拆模块，因 IIFE 作用域风险主动放弃，仍是单文件内联。

---

## 3. 版本演进与已交付功能

### v3.0.0 → v3.1.0 → v3.2.0 → v3.2.1 → v3.3.0（每个都有 Release）

**v3.3.0（本次主要成果）新增 6 项 + 修复 2 项 + 工程化：**
1. **表格虚拟滚动**：只渲染可视行，2 万行 DOM 从 2000 节点降到 40 以内；行数上限 2000→50000。坑：文本标签在 `applyTab` 直接填充不走 `renderNormal`，需显式调 `refreshCodeDecor(t)`。
2. **行号 + 语法高亮**：覆盖 10 种语言；编辑 400ms 防抖；>300KB 自动关高亮。设置默认改为 `!== false`（老用户 localStorage 缺字段会导致功能关闭）。
3. **PDF 缩略图导航**：多页顶部缩略图、当前页高亮、点击跳页；单页自动隐藏。需在 `t.pdfDoc = doc` 后调 `buildThumbs(t)`。
4. **单元测试**：`tests/run-tests.js` 12 用例，从源码提取真实函数；`npm test` 接入；CI 加测试步骤。
5. **编码切换**：装 `iconv-lite`，状态栏编码标识点击切 UTF-8/GBK，`main.js` 的 `file:save` IPC 接收 `saveEnc`。
6. **CSS 拆分**：`index.html` 内联 `<style>` 提取为 `style.css`（26KB），主文件 156→128KB。

**修复的隐藏炸弹（v3.3.0 里补回）：**
- `exportPdfPages` / `rotatePdfPage`：只有调用没实现（提交前丢失），重写并加 `parsePageRange` / `bytesToB64` / `withPdfLib`（注：实际代码中**不存在** `needPdfLib`，PDF 库的按需加载由 `withPdfLib` 承担）。
- PDF 查找：`pdfFindInPage` 定义未接入 `runFind` 分发链（3.1.0 宣称能搜但未生效），已补 `runFindPdf`。
- xlsx 保格式：`attrs.replace` 正则被多转义一层导致静默失效；XML 属性缺空格 `<c t="inlineStr"r="B2">` 会损坏文件，加 XML 合法性校验。

**v3.2.1 内存专项：**
- 限制渲染进程 V8 堆上限 512MB；菜单新增「释放后台标签内存」（清 PDF 文档/表格/十六进制缓存/撤销栈）。

**更早版本：** PDF 文本层、安装版、xlsx 保格式、转换进度、PDF 全文查找、最近打开文件、图片缩放、.gitattributes 统一换行符、开源工程化文档。

---

## 4. 关键工程决策与踩坑（下次必看）

### 发布流程
- **`gh release create` 一次传多文件（954MB）会卡 35 分钟 0 字节** → 必须**逐个 `gh release upload`**（每个约 2 分钟）。
- **版本号同步点**：`package.json` + `renderer/index.html`（"版本 X.X.X" 和 `>vX.X.X<`）+ `使用说明.md` + `CHANGELOG.md` + 内置 `help.md`。任一处漏改都会不一致。
- tag 已打：v3.0.0 / v3.1.0 / v3.2.0 / v3.2.1 / v3.3.0 / v3.4.0 全部存在。

### 网络/代理（本机环境特有）
- **gh CLI** 必须用 `env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY gh`（本机常驻全局代理会让 `github.com/login/device` 走代理 Bad Gateway）。路径：`"C:/Program Files/GitHub CLI/gh.exe"`。
- **推送**：SSH 偶尔被沙箱拦截，已 `gh auth setup-git` 走 HTTPS 凭证助手；remote 现为 `git@github.com:kivvs/kivnote.git`（gh 会代为处理）。
- 本机 8080 被 Burp 常驻占用（见用户记忆），起服务避开 8080。

### 打包
- `electron-builder` 必须设镜像：
  - `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
  - `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- 命令：`node ./node_modules/electron-builder/out/cli/cli.js --win`
- 产物在 `release/` 与 `dist*` 目录（见下方"待清理"）。

### 测试运行
- `env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe . --shot --no-sandbox --in-process-gpu`，配合 `--open=文件`、`--slow`、`--layer-test / --vscroll-test / --hl-test` 等自定义参数。

### 运行时
- **Python**：`C:/Users/Lenovo/.workbuddy/binaries/python/versions/3.13.12/python.exe`
- **Node**：`C:/Users/Lenovo/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`

---

## 5. 内存优化专题结论（用户最关心的问题）

- **基线实测**：空窗口约 **345MB**（渲染 ~185 + 主 ~107 + 实用 ~53）；2 万行 CSV 约 425MB。
- **关键结论**：渲染进程 185MB 是 **Chromium 固定开销**，和功能代码关系不大（空 HTML 页也是这个量级）。懒加载只省 ~21MB。
- **已做且有效的优化**：按需加载大组件、关标签即释放、翻页清缓存、V8 堆上限 512MB、手动「释放后台标签内存」入口。真实收益是"长时间多标签不再无限制累积"。
- **无法突破的天花板**：单窗口 300MB 降不下来 —— 只有换 **Tauri / WebView2** 重写渲染层才行，**不在本项目计划内**。

---

## 6. 当前仓库状态（待清理项）

`git status` 显示：
- **已删除但未提交的截图**：`c_hl.png` `c_hl2.png` `c_hl3.png` `c_hl4.png` `d_css.png`（曾被误提交，现已删除）。建议 `git rm` 正式移除或恢复。
- **散落目录/文件**：`build/`、`dist/` `dist2`…`dist14`、`release/`、`loffice/`、`_m.py`、`_out.log`、`m_thumb*.png`、`t_doc*.png`、`v_ppt*.png` 等构建产物与临时截图。这些**不应入库**，应确认 `.gitignore` 覆盖（目前 `dist/`、`release/` 大概率已忽略，但根目录散落文件需整理）。
- 建议：构建产物统一放 `release/`，临时截图别留在根目录；清理后跑一次 `git status` 确认干净。

---

## 7. 建议的下一步（按优先级）

1. **清理仓库**：移除误提交的截图、整理根目录散落文件，确认 `.gitignore`。
2. **JS 模块化**（如仍想做）：需谨慎处理 IIFE 作用域，可改用 ES Module + 构建步骤，但风险高、收益有限（主要是可维护性）。
3. **功能增强候选**：批量转换、更多语言高亮、表格公式、深色主题切换。
4. **性能**：虚拟滚动已覆盖表格；可视区渲染可扩展到超长文本视图。
5. **发布**：下个版本按"逐个 upload"流程发，别再一次性传多文件。

---

## 8. 速查命令

```bash
# 跑测试
npm test

# 本地起应用（带截图/测试参数）
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe . --no-sandbox --in-process-gpu --open=testfiles/xxx.csv

# 打包（需镜像）
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
node ./node_modules/electron-builder/out/cli/cli.js --win

# 发布（gh 去代理；文件逐个 upload）
env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY gh release upload vX.X.X "<file>" --clobber
```

---
*最后更新：2026-10-23，对应代码状态 commit e22623a（3.4.0）。*
