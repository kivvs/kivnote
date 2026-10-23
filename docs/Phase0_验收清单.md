# KivNote 迁移 Tauri — Phase 0（最小 PoC）状态与验收清单

> 目标回顾：用 Tauri v2（Rust + 系统 WebView2）把现有 `renderer/index.html` 原样塞进 webview，
> 验证两件事 —— (1) 单窗口基线内存能否从 Electron 的 ~345MB 降到 ~80–150MB；(2) PDF.js 在 WebView2 下能否正常工作。
> 本阶段只做最小骨架，不重写业务逻辑。

## 一、已落地的产物

| 文件 | 作用 |
|------|------|
| `src-tauri/Cargo.toml` | 依赖：tauri 2、tauri-plugin-dialog 2、serde、base64 |
| `src-tauri/src/main.rs` | 仅两个命令 `read_file` / `write_file` + 窗口控制接入 |
| `src-tauri/build.rs` | 标准 `tauri_build::build()` |
| `src-tauri/tauri.conf.json` | `frontendDist: ../renderer`、`withGlobalTauri: true`、窗口 1100×750 |
| `src-tauri/capabilities/default.json` | 权限 `core:default` + `dialog:default` |
| `src-tauri/icons/icon.ico` | 复用的应用图标 |
| `renderer/tauri-shim.js` | 把 `window.native`（Electron preload 接口）映射到 Tauri 全局 API |
| `renderer/index.html`（第 9 行） | 注入 `<script src="tauri-shim.js">`（仅 head 一行改动） |

**关键简化**：`tauri.conf.json` 开了 `withGlobalTauri: true`，前端直接读 `window.__TAURI__` 全局对象，
**免去 Vite 打包器和前端 npm 依赖**。编译期 `generate_context!()` 把整个 `renderer/` 打进二进制，
`cargo build` 直接产出可运行 exe，连 dev server 都不用起。

## 二、构建验证（已在脚本环境跑通）

- `cargo build` 成功（**首次因误用 `env -u` 去掉代理失败**，static.crates.io 连不上；修正为走本机代理 `http://127.0.0.1:12020` 后通过）。
- 产物：`src-tauri/target/debug/kivnote-tauri.exe`（debug 版 ~14MB）。
- 前端已嵌入二进制（grep 命中 `KivNote` 字符串 3 次，证明 `renderer/` 被打包）。
- 启动存活 7s 无崩溃、无报错 → WebView2 运行时在位、配置无误。
- 最终重建 **零警告**。

## 三、需要你在本地 Windows 桌面做的验收（沙箱无显示，无法跑 GUI）

1. 进入 `app/src-tauri`，执行 `cargo build`（或直接用已生成的 `target/debug/kivnote-tauri.exe`）。
2. 双击运行 exe，确认窗口正常弹出、UI 渲染（HTML/CSS 应和 Electron 版一致）。
3. 打开**任务管理器**看内存：
   - **验收标准：空窗 ≤ 150MB**（对比 Electron 现状 ~345MB，降 50%+ 即达标）。
4. 拖入一个 **PDF**，验证 PDF.js 文本层 / 缩略图 / 查找是否正常（这是唯一未知项，重点回归）。
5. 拖入 **csv / 纯文本 / 图片**，验证 `read_file` + 渲染管线 OK。
6. 试一下窗口最小化/最大化/关闭按钮（`win.min/max/close` 已接 Tauri API）。

> 若空窗内存接近 150MB 且 PDF.js 正常 → Phase 0 验收通过，可进入 Phase 1。
> 若 PDF.js 在 WebView2 下异常（渲染错位/文本层丢失），需在 Phase 1 前先做 PDF.js 兼容 PoC。

## 四、已知 stub（Phase 0 仅最小命令集，余下返回安全默认值不崩）

| 类别 | 方法 | 状态 |
|------|------|------|
| 文件 | `readAll` / `open` / `openPath` / `save` / `saveAs` | ✅ 已接 Tauri 真实实现 |
| 窗口 | `win.min` / `win.toggleMax` / `win.close` / `win.forceClose` | ✅ 接 Tauri 全局 API |
| 编辑 | `writeBase64` / `writeBytes` / `chunk` / `patchXlsx` / `backup` | ⏸ stub（返回 {}） |
| Office/PDF | `pdfText` / `docParts` / `pptParts` / `pptRender` / `loConvert` / `convert` / `cancelConvert` / `help` | ⏸ stub |
| 杂项 | `cliArg` / `pathForFile` / `newWindow` / `systemOpen` / `reveal` / `saveAsBinary` / `setDirty` / `onCmd` / `onMax` / `writeClipboard` | ⏸ stub 或最小实现 |

## 五、下一步（Phase 1：后端核心重写）

把上表 stub 逐个替换为真实 Rust 实现，对应 `main.js` 的逻辑：
- 文件分类（魔数 sniff + 后缀）、UTF-8/GBK 解码（用 `encoding_rs` 替 `iconv-lite`）
- hex 按偏移随机写（写二进制命令）、xlsx/docx/pptx 就地改值（`zip` crate，**保留压缩炸弹防护**）
- 最近文件、编码保存、缩略图
- 将纯逻辑部分用 Rust `#[cfg(test)]` 重写等价断言，接住原有 12 个单测的语义

> 参考：`docs/技术栈迁移评估.md` 的「后端模块重写映射表」与「Phase 0–6 计划」。
