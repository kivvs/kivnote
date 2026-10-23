# KivNote 插件化架构设计文档

> 状态：设计稿（未实现）。目标：在**不显著增加运行时内存**的前提下，把重功能模块拆成可选插件，用户按需下载；同时让"不装的功能绝不占内存、装了的功能关标签即释放"。
> 配套概述见 `../KIVNOTE_SUMMARY.md`。

---

## 1. 目标与边界（先对齐预期）

### 能做到的
- **安装/分发体积下降**：基础包只含文本查看 + 插件宿主 + 菜单，PDF/xlsx 等按需下载。
- **不装的功能零占用**：未下载/未启用的插件不进入内存。
- **内存增长可控**：插件随 tab 打开而加载，随 tab 关闭而 `dispose`，长时间多标签不会无限制累积（与现有 `releaseTab()` 思路一致）。
- **可扩展性**：社区/团队可按契约贡献新的查看器。

### 做不到的（必须诚实告知用户）
- **运行时内存地板（~345MB）不会降**。该数字主要是 Electron/Chromium 固定开销（渲染进程 ~185MB 常驻），与装不装插件无关。要降到 100MB 以下只能换 Tauri/WebView2（重写，不在本计划）。
- 因此插件化是对"**安装体积 + 功能可扩展性 + 内存增长曲线**"的优化，不是对"单窗口基线内存"的优化。

### 一个今天就能做、比插件化更划算的点
当前 `main.js:14` **启动即 `require('pdfjs-dist')`**（包 32MB，主进程常驻约 20–40MB），而渲染侧 PDF 查看器早已懒加载——等于 PDF.js 在主进程被白白常驻。这应作为 **Phase 0** 先修：改成"打开 PDF 才 require"，立刻省主进程内存，且不依赖任何插件框架。

---

## 2. 设计原则

1. **单一渲染进程**：插件就**地注入当前渲染进程**，绝不每插件开一个 `BrowserWindow`（每个会 +100~185MB，反而更费）。
2. **核心最小化**：core 只含文本查看（原生、极小）+ 插件宿主 + 菜单/最近文件/设置。
3. **按需 + 可释放**：插件首次对应该类型文件时加载；tab 关闭即 `dispose`（销毁文档对象、清空大块缓存、移除模块引用）。
4. **契约稳定**：宿主暴露一个版本化的 `KivNote` 宿主 API，插件只依赖该 API，不碰内部实现。
5. **可离线**：已下载的插件本地缓存，无网也能用；市场只是"下载源"。

---

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────┐
│  Main Process (main.js)                                   │
│   · 窗口/菜单/最近文件/设置(localStorage)                    │
│   · 插件注册表读取(registry.json) · 下载调度(可选)           │
│   · 文件对话框 → 把路径+类型交给渲染进程                     │
└───────────────┬──────────────────────────────────────────┘
                │ IPC (file:open / plugin:load / ...)
┌───────────────▼──────────────────────────────────────────┐
│  Renderer Process (单一, Chromium ~185MB 固定)             │
│  ┌─────────────┐  ┌────────────────────────────────────┐  │
│  │  Core (内置) │  │  Plugin Host (KivNote 全局 API)     │  │
│  │ · 文本查看   │  │   · loadPlugin(id)                  │  │
│  │ · 菜单/最近  │  │   · 生命周期: load/activate/dispose │  │
│  │ · 设置       │  │   · 挂载渲染目标(container)          │  │
│  └─────────────┘  └────────────┬───────────────────────┘  │
│                                 │ 按需注入                   │
│        ┌──────────┬─────────────┼──────────┬────────────┐  │
│        │ pdf      │ xlsx        │ syntax-* │ hex/img...  │  │
│        │ 插件     │ 插件        │ 语言包    │ 插件        │  │
│        └──────────┴─────────────┴──────────┴────────────┘  │
└──────────────────────────────────────────────────────────┘
                ▲
                │ 用户目录 plugins/  (已下载缓存)
                   market = GitHub Release / registry.json
```

### 目录结构（建议）
```
app/
  main.js
  preload.js
  renderer/
    index.html          # 核心界面 + 文本查看器（内置）
    host.js             # 插件宿主（KivNote 全局 API、加载器）
    style.css
    core/               # 内置查看器（文本等）
  plugins/              # 用户已下载插件（运行时生成，进 .gitignore）
    pdf.kivplugin/
      manifest.json
      main.js           # 插件入口（用宿主 API 注册查看器）
      vendor/           # 该插件私有依赖（pdf.js / pdf-lib）
    xlsx.kivplugin/
    ...
  docs/PLUGIN_ARCHITECTURE.md
```

> 注：当前 `renderer/index.html` 是单文件内联 IIFE；宿主 API 需在该 IIFE 内暴露一个 `window.KivNote`，供插件入口调用。插件入口本身用动态 `<script>` 注入（沿用现有 `loadLib` 思路，改为通用 `loadPlugin`）。

---

## 4. 插件规范（manifest）

`plugins/<id>.kivplugin/manifest.json`：
```json
{
  "id": "pdf",
  "name": "PDF 查看器",
  "version": "1.0.0",
  "engine": "1",                       // 宿主 API 主版本，契约校验用
  "entry": "main.js",                  // 相对插件根
  "appliesTo": ["pdf"],                // 触发加载的扩展名
  "loadMode": "onOpen",                // always | onOpen | onDemand
  "size": 56000000,
  "minApp": "3.3.0",
  "description": "PDF 渲染、文本层、缩略图、查找、旋转/导出页",
  "download": "https://github.com/kivvs/kivnote/releases/download/plugins/pdf-1.0.0.kivplugin.zip"
}
```
- `engine` 与宿主 `KivNote.version` 不匹配时拒绝加载并提示升级。
- `loadMode=onOpen`：首次打开 `appliesTo` 中任一类型时下载并加载；`always`：启动即加载；`onDemand`：仅用户手动启用。

---

## 5. 插件生命周期

```
install → load(entry.js 注入渲染进程)
        → activate(ctx)：用 ctx.registerViewer(ext, factory) 注册查看器
open file → host 找到 appliesTo 匹配的已加载插件 → factory(container, doc) 返回 viewer
viewer.render(doc) / viewer.find(...) / ...
close tab → viewer.dispose()：销毁 pdfDoc/SheetJS workbook/hex 缓存/撤销栈，置空引用
uninstall → 从 plugins/ 删除，清理 registry 记录
```
- 与现有 `releaseTab()`（pdfDoc.destroy、wb=null、raw.bytes=[]、撤销栈清空）对齐；插件化只是把"释放逻辑"交给插件自管。

---

## 6. 宿主 API 契约（`window.KivNote`）

插件只通过以下 API 与宿主交互（版本化，向后兼容）：
```js
KivNote = {
  version: "1",                         // engine 版本
  registerViewer(ext, factory),         // factory(container, doc) -> viewer
  registerMenu(item),                   // 向"插件"子菜单注册项
  onFind(fn), onExport(fn),            // 挂接 Ctrl+F / 导出等宿主行为
  getContainer(),                      // 当前文档渲染挂载点
  ipc: { invoke(channel, payload) },   // 走 preload 的安全 IPC（文件读写等）
  showStatus(text),                    // 状态栏提示
  settings: { get(k), set(k,v) },      // 持久化到 localStorage
}
```
- 插件**禁止**直接 `require` 宿主内部模块或访问 `nodeIntegration`；所有文件/系统操作经 `KivNote.ipc`（preload 已桥接，保持 `contextIsolation`）。
- 安全：插件代码本地已下载，不执行远程任意脚本；`engine` 版本不匹配即拒绝，防止 API 漂移导致崩溃。

---

## 7. 加载与分发

### 7.1 本地优先
- 已下载插件存 `plugins/<id>.kivplugin/`，启动时宿主扫描并登记（不自动激活 `onOpen`/`onDemand` 之外的）。
- 同一类型文件被打开且本地无对应插件 → 提示"需下载 PDF 插件"，点确认后下载。

### 7.2 插件市场（轻量）
- 在仓库维护 `registry.json`（GitHub Release 上）：
  ```json
  { "plugins": [ { "id":"pdf", "version":"1.0.0",
      "download":"https://github.com/kivvs/kivnote/releases/download/plugins/pdf-1.0.0.kivplugin.zip",
      "sha256":"..." } ] }
  ```
- 菜单"插件管理"列出已装/可装，支持一键下载/启用/禁用/卸载（下载后 `sha256` 校验）。
- 进阶再接 `electron-updater` 做版本检查；初期 `registry.json` + `gh release` 已足够。

---

## 8. 核心代码改动点（只列位置，不实现）

| 位置 | 改动 |
|------|------|
| `main.js:14` | 去掉启动期 `require('pdfjs-dist')`，改为打开 PDF 时按需 `require`（Phase 0） |
| `renderer/index.html` 内 IIFE | 暴露 `window.KivNote` 宿主对象 + `loadPlugin(id)` 加载器（取代/泛化现有 `loadLib`） |
| `acceptDoc`(打开分发) | 按扩展名查已加载插件 viewer，无则触发下载/提示 |
| 菜单 | 新增"插件管理"子菜单；`renderRecentMenu` 不动 |
| 设置 | 增加"已启用插件"列表与开关 |
| `.gitignore` | 忽略 `plugins/`、`*.kivplugin` |
| CI | 增加"打包插件 zip"步骤（可选） |

---

## 9. 迁移路线图（分阶段）

- **Phase 0 — 主进程去预加载（独立、先收益，无需插件框架）**
  把 `main.js:14` 的 `require('pdfjs-dist')` 与 `adm-zip` 改为按需。立刻降主进程常驻内存。可与插件化解耦单独上线。
- **Phase 1 — 宿主骨架**
  实现 `KivNote` 全局 API + `loadPlugin` + manifest 扫描 + 插件目录约定；core 保留文本查看。此时尚无外部插件。
- **Phase 2 — 第一个插件：PDF**
  把现有 PDF 查看器（含 `pdf.js`/`pdflib.js` 与 Phase 0 迁出的文本提取逻辑）打包为 `pdf.kivplugin`；验证"打开才下载/加载、关 tab 即释放"。注意：原 `main.js` 里用 pdfjs 做的文本/缩略图提取，应迁到插件侧或渲染进程 worker，避免主进程常驻。
- **Phase 3 — 拆其余重模块**
  xlsx/SheetJS → `xlsx` 插件；语法高亮各语言包 → `syntax-*` 插件（或合并一个）；十六进制、图片处理、编码检测按需。
- **Phase 4 — 插件市场 UI + 校验 + 自动更新**
  "插件管理"面板、registry.json、sha256 校验、`minApp`/`engine` 兼容提示。

---

## 10. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 宿主 API 漂移导致插件崩 | `engine` 版本契约；破坏性变更升主版本，旧插件提示升级 |
| 插件恶意/损坏 | 仅从 registry 指定 URL 下载 + sha256 校验；不执行远程任意代码 |
| 离线无插件 | 本地缓存，`appliesTo` 无对应插件时友好提示而非崩溃 |
| 每插件开进程反而更费内存 | 严禁；统一注入单一渲染进程 |
| 现有 IIFE 作用域隔离 | 宿主 API 显式挂 `window.KivNote`，插件入口为独立脚本，避免变量污染 |
| 下载体积大（PDF ~54MB） | 插件级增量；用户只下要用的；可后续做差量更新 |

---

## 11. 与内存目标的再确认

插件化后预期内存形态：
- **空窗口基线**：仍 ~345MB（Chromium 固定，不变）。
- **只装文本 + 偶尔看 PDF**：打开 PDF 时 +PDF 占用，关 tab 后回落（dispose）。
- **核心收益**：功能越加越多，内存只随"当前打开的 tab 类型"波动，不再为"装了但没用"的功能买单。

若用户的核心诉求是"单窗口也要明显更低"，需另开议题评估 Tauri/WebView2 重写——不在本文档范围。

---

## 12. 验收标准

1. 基础包不含 PDF/xlsx 等大库；首次打开对应文件时按需下载并加载。
2. 关闭该类型 tab 后，对应大对象（pdfDoc/workbook/hex 缓存）被释放（可用"释放后台标签内存"或 DevTools 内存快照验证）。
3. 未下载插件的类型被打开时，给出明确"需下载插件"提示，不崩溃。
4. `engine` 不匹配的插件被拒绝加载并提示。
5. 已下载插件离线可用；`sha256` 校验通过。
6. Phase 0 落地后，主进程常驻内存较当前下降（验证 `main.js` 不再启动期加载 pdfjs）。
