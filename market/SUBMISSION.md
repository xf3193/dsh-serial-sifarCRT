# 向 dsh-market / awesome-dsh-plugin 提交收录

本文件是给自己看的操作清单，也可以直接复制 PR 文本。仓库
`https://github.com/xf3193/dsh-serial-sifarCRT` 创建于 **2026-11-05 22:40:57（北京时间）**，
awesome-dsh-plugin 的 CI 要求仓库创建满 **1 天**，即最早在
**2026-11-06 22:40:57（北京时间）** 之后提交；建议 **23:00 之后**开始，留出时区/边界余量。

## 0. 提交前检查（几分钟）

- [ ] GitHub Topic 已包含 **`dsh-plugin`**（本仓库已加），以及推荐的
      `deepseek-harness, dsh, serial, serialport, uart, terminal, windows, securecrt`
- [ ] 仓库是 **Public**
- [ ] `package.json` 里有 **`dsh.bundle.patch`**（本仓库有：`./cordis.patch.yml`）
- [ ] 仓库根目录有 `cordis.patch.yml`
- [ ] 仓库「About」里的描述可以保持 `dsh-serial-sifarCRT`
- [ ] （推荐）在 GitHub 上从 `v1.0.2` 标签创建一次 **Release**：
      仓库 → Releases → Draft a new release → 选择 `v1.0.2` → 发布（内容可复制 README 摘要）。
      这样非 npm 安装者也有稳定的 release tarball 可用；不做也不影响收录。

## 1. Fork 注册表仓库

打开并 Fork：

```
https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/fork
```

保持默认（Copy the `main` branch only 即可），创建到你的账号 `xf3193` 下。

## 2. 在 Fork 中新增一个 YAML 文件

在你的 fork 仓库中打开：

```
https://github.com/xf3193/awesome-dsh-plugin/new/main?filename=data/plugins/xf3193__dsh-serial-sifarCRT.yml
```

文件名必须是 **`data/plugins/xf3193__dsh-serial-sifarCRT.yml`**（`owner` + 两个下划线 + 仓库名）。
把下面内容整段粘贴进去（与仓库里的
[market/awesome-plugin-entry.yml](https://github.com/xf3193/dsh-serial-sifarCRT/blob/main/market/awesome-plugin-entry.yml) 一致）：

```yaml
url: https://github.com/xf3193/dsh-serial-sifarCRT
name: xf3193/dsh-serial-sifarCRT
category: tools
description:
  en: 'Windows serial debug console in the DSH right sidebar: port settings, ANSI color logs, an in-log Linux command line, editable command buttons, multi-port tabs and log export.'
  zh: 'DSH 右侧栏的 Windows 串口调试台：串口设置、ANSI 彩色日志、日志内 Linux 命令行、可编辑命令按钮、多串口标签页与日志导出。'
icon: https://raw.githubusercontent.com/xf3193/dsh-serial-sifarCRT/main/assets/icon-180.png
```

提交信息建议：`Add dsh-serial-sifarCRT`，直接提交到 fork 的 `main` 即可。

> 说明：
> - **只新增这一个文件**，不要手动改 README（两个 README 由脚本生成）。
> - `category` 必须是注册表已有分类之一；`tools` 最贴合串口调试工具。
> - `description.en` 是必填、必须属实、以句号结尾；含 `: ` 时要用引号（上面已加）。
> - `icon` 可选，必须是 GitHub 托管的**位图**；上面用的是仓库里的 180×180 PNG。

## 3. 向上游发 Pull Request

提交后回到你的 fork，GitHub 通常会出现 **Contribute → Open pull request**；
也可以直接打开：

```
https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/compare/main...xf3193:awesome-dsh-plugin:main?expand=1
```

PR 标题：

```
Add dsh-serial-sifarCRT (Windows serial debug console)
```

PR 描述（可直接复制）：

```markdown
Adds one entry for `dsh-serial-sifarCRT`, a Windows serial debug console in the
DSH right sidebar.

- Repository (public): https://github.com/xf3193/dsh-serial-sifarCRT
- Category: `tools` — serial debugging for embedded/hardware work
- Declares `dsh.bundle.patch` (`cordis.patch.yml`) and installs with
  `dsh plugin --profile web add github:xf3193/dsh-serial-sifarCRT`
- What it does: auto-enumerated COM ports, a settings dialog (baud up to
  1500000, parity, flow control), ANSI color rendering for Linux serial logs,
  an in-log command line with history and Ctrl+C, editable command buttons,
  multiple port tabs, log copy/save
- Platform: Windows only (uses the in-box Windows PowerShell + System.IO.Ports;
  no native module and no build step)
- No network access: serial traffic and preferences stay local

Verified from a clean profile: installing from the repository works and the
right-sidebar panel registers after a page refresh.
```

## 4. PR 之后

- 等待 CI / 维护者审核。常见检查项：仓库创建满 1 天、`dsh.bundle` 清单、
  `dsh-plugin` topic、描述与实际代码一致。
- 若 CI 提示问题，按评论修正；一个 PR 只加一个文件，后续更新（改版本）不需要再提 PR。
- 合并后注册表 CI 会刷新 `plugins.json`，通常 **1 天内**出现在：
  - awesome-dsh-plugin.com 的列表
  - dsh-market 的 Discover（market 列表来自 `https://awesome-dsh-plugin.com/plugins.json`）
  - 格式 1 索引：`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`
- 查询方式：在 DSH 的 **Plugins → Discover** 搜索 `sifarCRT`（或 `dsh-serial-sifarCRT`）；
  也可以直接看列表镜像：
  `https://awesome-dsh-plugin.com/p/xf3193/dsh-serial-sifarCRT/`

## 5. 收录之后（可选）

- **发 npm 包**（市场会优先用 npm 源，安装更快、支持版本更新）：
  1. 配好 npm 账号，并在本仓库 Secrets 里添加 `NPM_TOKEN`；
  2. `npm publish --registry=https://registry.npmjs.org/ --access public`；
  3. 之后改版本号 → 发布 → 打 `vX.Y.Z` tag（`.github/workflows/publish.yml` 会在有
     `NPM_TOKEN` 时自动发布；没有该 secret 时自动跳过，不再产生失败记录）。
- 给仓库补 UI 截图（`README.md` 里放图片，市场会用作预览图）。
