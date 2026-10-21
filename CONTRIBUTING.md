# 参与贡献

感谢你想改进 KivNote。

## 提 Issue

先搜一下 [已有 issue](https://github.com/kivvs/kivnote/issues)，避免重复。

提 Bug 时请带上：

- KivNote 版本（菜单 `⋯ → 关于记事本`）
- Windows 版本（如 Win11 23H2）
- **能复现的文件**（很重要 —— 大部分问题都和具体文件有关）
- 你做了什么、期望看到什么、实际看到什么

> 涉及个人隐私的文件请不要直接上传，先脱敏或描述文件特征（后缀、大小、来源软件）。

## 开发环境

```bash
git clone https://github.com/kivvs/kivnote.git
cd kivnote
npm install
npm start
```

可选：内置 Office 转换引擎（756 MB，不装也能跑，只是 doc/docx/ppt/pptx 会降级）

```bash
npm run fetch:loffice
```

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm start` | 开发运行 |
| `npm start -- --open=文件路径` | 启动并直接打开某个文件 |
| `npm run shot` | 截图调试（输出到 `%TEMP%\notepad-shot.png`） |
| `npm run dist` | 打包 portable exe + NSIS 安装版 |
| `npm run pack` | 把未打包目录压成绿色版 zip |

调试参数（追加在 `npm start -- ` 后面）：

```
--shot            启动后截图再退出
--open=<路径>     启动即打开（可多次）
--view=hex|bin    指定初始视图
--slow            截图前等 30 秒（等慢速转换）
```

## 代码约定

- **主进程** `main.js`：文件 IO、类型判定、进程间通信。改动要注意 Windows 路径和编码。
- **渲染进程** `renderer/index.html`：整个界面（样式 + 逻辑写在一个文件里）。
- **不要引 UI 框架**，样式全部手写 CSS，保持深色 + 等宽 + 橄榄绿的整体风格。
- 新增第三方库请同步更新 `LICENSE` 里的组件表。
- 改动后跑一遍语法检查（CI 也会跑）。

## 提交 PR

1. 从 `main` 切分支
2. 改动 + 自测（至少手动打开对应类型的文件验证）
3. 更新 `CHANGELOG.md` 的「未发布」部分
4. 提 PR，说明改了什么、为什么、怎么验证的

## 许可提醒

本项目 **禁止商用**（见 [LICENSE](LICENSE)）。提交 PR 即表示你同意你的代码也遵循同一许可。
