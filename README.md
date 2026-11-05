# Overleaf Workshop AI

把 Overleaf 项目同步成一个真实的本地文件夹。在 VS Code 里改文件，就像在网页上改一样。

> **English:** A VS Code extension that keeps an Overleaf project in a real local folder, in both directions and in real time, so any tool can edit it. Compiling happens on Overleaf, and comments can be read and handled locally. It is an unofficial fork of [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop). The interface is currently mostly in Chinese.

## 它能做什么

| 功能 | 效果 |
|---|---|
| **双向实时同步** | 本地的修改约一秒后到达 Overleaf，不用保存；合作者的修改实时到达本地，包括你正开着的文件 |
| **真实文件夹** | 项目就是磁盘上的普通文件夹，AI 助手和任何工具都能直接改，改动会自动同步 |
| **文件和文件夹操作** | 新建、重命名、移动、删除，两边都会跟着变；本地删除要你确认 |
| **在 Overleaf 上编译** | 一个快捷键编译，PDF 显示在 VS Code 里，本地不用装 TeX，免费账号就能用 |
| **批注** | 在 VS Code 里查看、添加、回复、编辑、删除、解决批注，合作者实时可见；AI 也能读 |
| **不怕误操作** | 删除整个本地文件夹不影响线上项目；项目进回收站时同步暂停，恢复后自动合并 |

插件只做同步、编译和批注，不包含 AI 功能。AI 助手在终端里改文件时，对插件来说和任何其他修改一样。

## 快速开始

### 1. 安装

需要 VS Code 1.80 或更高版本。目前没有上架扩展市场，需要自己打包：

```
git clone https://github.com/axulor/Overleaf-Workshop-ai.git
cd Overleaf-Workshop-ai
npm install
cd views/chat-view && npm install && cd ../..
npx @vscode/vsce package --out overleaf-workshop-ai.vsix
code --install-extension overleaf-workshop-ai.vsix
```

它和原来的 Overleaf Workshop 不能同时运行，请先在扩展面板里**禁用原插件**。

### 2. 登录

打开侧边栏的 Overleaf 面板，添加服务器 `https://www.overleaf.com`，选择 Login with Cookies，粘贴 Cookie。

**获取 Cookie：** 在已登录 Overleaf 的浏览器里按 <kbd>F12</kbd>，切到“网络”标签，打开 Overleaf 主页，筛选 `/project` 并选中完全匹配的那一项，复制请求头里 `Cookie` 的值，格式类似 `overleaf_session2=...`。它相当于你的登录凭据，不要发给别人。

### 3. 同步项目

1. 在 VS Code 里打开存放这篇论文的本地文件夹。
2. 把鼠标移到面板里的项目上，点云朵图标（`同步到本地`），确认。
3. 状态栏显示 `Overleaf：已同步` 就可以开始了。

文件夹结构会是这样，之后再打开这个文件夹时会自动恢复同步：

```
my-paper/                    在 VS Code 里打开这一层
├─ overleaf-<项目名>/         Overleaf 项目，和线上双向同步
│  └─ .output/               编译生成的 PDF 和日志，以及批注
├─ .vscode/settings.json     装了 LaTeX Workshop 时才会生成，见“编译”
└─ zh/, data/, code/, ...    其他文件夹只留在本地，不会上传
```

直接打开 `overleaf-<项目名>/` 不会同步，插件会提示你打开上一级。

## 怎么用

### 改文件

- **直接改就行。** 在 VS Code 里打字不用保存，任何工具写入文件也一样。发送的是差异编辑，不是整个替换，所以合作者的批注不会丢。
- **两边改到同一处时不会互相覆盖。** 由你选择保留哪一边，这个选择只决定冲突的地方，其他修改都会保留。同一段的不同句子会自动合并。选择线上版本时，本地版本的副本存在 `.overleaf/sync/conflicts/`。
- **断网或 VS Code 关闭期间的修改**，重新连接后会自动合并。

### 文件和文件夹

| 你在本地做的 | 线上会怎样 |
|---|---|
| 新建文件或文件夹（包括空文件夹） | 自动同步 |
| 重命名文件或文件夹，或移到另一个文件夹 | 同样操作，批注保留 |
| 删除文件，或带文件的文件夹 | **先弹窗确认**：确认后线上也删除，批注一起删；取消则从线上恢复到本地，里面的空文件夹也一起恢复 |
| 删除空文件夹 | 直接删除，不询问 |
| 删除全部文件 | 弹窗警告这会清空线上项目，默认按钮是恢复到本地 |

| 线上发生的 | 本地会怎样 |
|---|---|
| 新建文件或文件夹 | 自动同步 |
| 重命名或移动 | 本地跟着变，开着的标签页也跟着走 |
| 删除文件 | 本地文件移到 `.overleaf/sync/trash/`，右下角提示 |
| 删除文件夹 | 里面的文件移到 `.overleaf/sync/trash/`，右下角提示，文件夹随后消失 |

只改大小写的重命名（`Figs` 改成 `figs`）也一样会同步。同时改名又移动一个文件时，会变成上传新文件加删除旧文件，批注不会保留。

### 删除、回收站和归档

**想停止同步但保留线上项目：删除本地的整个 `overleaf-<项目名>/` 文件夹就行。** 线上不受任何影响，也不会弹窗。

| 操作 | 线上项目 | 本地文件夹 | 同步 |
|---|---|---|---|
| 删除整个本地文件夹 | 不变 | 按你的操作 | 断开；从回收站还原文件夹后自动恢复 |
| 项目移到回收站或归档 | 在回收站或归档里 | 保留 | 暂停，文件夹成为普通文件夹 |
| 从回收站恢复或取消归档 | 恢复 | 保留 | 自动继续，这段时间两边的修改自动合并 |
| 项目被彻底删除，或你被移出项目 | 没了 | 保留 | 结束，文件夹成为普通文件夹 |
| 断网或登录过期 | 不变 | 保留 | 状态栏提示，恢复后继续 |

- 在插件里操作和在网页上操作，效果一样。在插件里操作会立刻生效，并先把还没发出去的修改发送完，发不出去时会先问你；在网页上操作的话，插件大约一分钟内察觉，切回 VS Code 窗口时也会马上检查。
- 回收站和归档是按账号算的。合作者把项目放进他们自己的回收站，不影响你的同步。
- 同步结束后，这个文件夹可以随便处置。同一位置也可以再同步别的项目。

### 编译和 PDF

| 操作 | 快捷键 |
|---|---|
| 在 Overleaf 上编译（也可以点标题栏带圆圈的 ▶） | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd> |
| 查看 PDF | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> |
| 从代码跳到 PDF（在 PDF 上双击可以跳回代码） | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd> |

- 编译前会先把本地修改全部发出去，手动编译后在旁边打开 PDF。
- PDF 和日志保存在 `overleaf-<项目名>/.output/`。
- 和网页一样，日志里有 LaTeX 错误但生成了 PDF 时不算失败：状态栏显示警告，错误列在“问题”面板。
- 失败时会说明原因（比如超时，免费版的时限约为 10 秒），每次编译都记录在 `Overleaf Workshop AI` 输出通道。

**和 LaTeX Workshop 一起用：** 同步的工作区会在 `.vscode/settings.json` 里关掉它的自动编译和编译快捷键，否则它一改就在本地编译，没装 TeX 时会不断弹错。已经设置过的值不会改动。它自己的绿色 ▶ 按钮还在，那个仍然是本地编译。

### 批注

Overleaf 上的批注显示在对应的文字旁和 VS Code 的批注面板里，并随文字移动。操作立刻显示、后台发送，合作者实时可见。如果 Overleaf 拒绝，改动会撤回并提示。

| 操作 | 方法 |
|---|---|
| 添加 | 选中文字后右键选 `添加 Overleaf 批注`，或者点行号旁的 `+` 批注整行 |
| 回复 | 展开批注，在下面的框里写 |
| 编辑、删除 | 批注上的铅笔和垃圾桶，只有自己写的才有。删除批注会连同回复一起删除 |
| 解决 | 批注标题上的 ✓，确认后它不再显示，但记录还在 |
| 重新打开 | 批注面板上方的 🕘 按钮 |

### 和 AI 助手一起用

在 VS Code 里打开论文文件夹后，AI 助手可以：

- 直接修改 `overleaf-<项目名>/` 里的文件，合作者会实时看到，和其他人的编辑一样；
- 读取 `.output/comments.md` 了解批注，其中有文件、行号、原文、作者和内容。这个文件只供读取，改它不会影响 Overleaf；
- 读取 `.output/output.log` 查看编译错误。

如果工具写入的文件缺少线上五分钟内刚到的修改，它可能是根据旧副本写的，这时不会发送，而是提示你选择，这样合作者的文字不会被悄悄覆盖。

## 状态栏

| 显示 | 含义 | 怎么办 |
|---|---|---|
| `Overleaf：已同步` | 两边一致 | 单击查看同步记录 |
| `Overleaf：连接中` | 正在确认项目状态并连接 | 等一下 |
| `Overleaf：同步中` | 正在发送或接收 | 等一下 |
| `Overleaf：离线` | 连不上 Overleaf，修改留在本地 | 恢复后自动合并 |
| `Overleaf：需要重新登录` | Cookie 过期 | 在 Overleaf 面板退出后重新登录，之后自动继续 |
| `Overleaf：已暂停` | 项目在回收站或归档里 | 恢复项目后自动继续 |
| `Overleaf：N 个冲突` | 两边改了同一处 | 单击处理 |
| `Overleaf：N 个文件未同步` | 发送失败或文件被拒绝 | 单击查看原因 |

## 什么不会同步

**留在各自一边的：** 隐藏文件（以 `.` 开头）、LaTeX 中间文件（`*.aux`、`*.log`、`*.bbl`、`*.out`、`*.toc` 等）、`main.pdf` 和 `output.pdf`。可以在 `overleaf-<项目名>/.overleaf/settings.json` 里用 `ignore-patterns` 替换这个列表。`.overleaf`、`.output` 和 `.git` 始终不会同步。只装着这些文件的文件夹（比如编译产物目录）也留在本地，空文件夹则会同步。

**有问题时暂不同步，插件会提示，改好后自动恢复：**

- 含有 Overleaf 无法保存的字符，比如表情符号、部分数学字母（𝐱）和极少数生僻字（𠮷）。Overleaf 收到这种字符会断开连接并丢弃整次修改，所以插件不发送，并提示字符和行号。
- 不是 UTF-8 编码的文本文件。

## 设置

| 设置 | 默认 | 作用 |
|---|---|---|
| `overleaf-workshop.projectManager.showOriginalOpenActions` | 关 | 在项目列表里显示原插件的打开方式：`Open Project in Current Window`、`Open Project in New Window`（虚拟文件夹）和 `Open Project Locally ...`（不会自动同步的旧本地副本） |

## 注意事项

- **一个文件夹只能同步一个项目。** 有多个同步文件夹时只有一个会同步，插件会提示。
- **不要同时用两个编辑器打开同一个文件夹**（比如 VS Code 和 Cursor），也不要放在网盘的同步目录里。两边都会发送同一处修改，文字可能重复。
- **`Ctrl+Z` 可能撤销合作者的修改。** 线上的修改会进入编辑器的撤销记录，连续撤销时可能把别人刚写的也撤掉，撤销结果同样会同步。
- **保存时自动格式化也会生效。** 打字会自动保存，开启了 `editor.formatOnSave` 或 `files.trimTrailingWhitespace` 的话，每次停顿都可能改动文件并同步给合作者，建议在这个工作区关闭。
- **只有大小写不同的文件名**（`Intro.tex` 和 `intro.tex`）在 Windows 上是同一个文件，请避免。
- **这是非官方工具。** 它使用 Overleaf 网页版自己的接口，这些接口可能随时变化，Overleaf 的使用条款也对脚本化访问有限制，请自行判断。这个分支与 Overleaf 官方和原项目都没有关系。
- **出错时可以回退。** Overleaf 自带的历史记录（History）可以恢复任何版本。第一次用在重要项目上时，建议先在历史记录里加一个标签。

**验证范围：** 同步、批注和上面的删除规则都在真实的 Overleaf 上测试过，包括两个连接同时编辑、断线重连、回收站、归档和彻底删除，但用的是同一个账号和测试项目。被移出项目、合作者账号的回收站操作、合作者账号能否编辑或删除自己的批注，还没有在真实环境里验证。

## 开发

```
powershell -NoProfile -ExecutionPolicy Bypass -File test\run.ps1
```

运行全部测试。它们使用假的 Overleaf 响应，不需要账号。

```
powershell -NoProfile -ExecutionPolicy Bypass -File test\dev-window.ps1 -Folder <文件夹>
```

打开一个隔离的 VS Code 窗口，用真实账号试用当前代码，不影响你自己的 VS Code。

## 来源

基于 [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop)（iamhyc 及贡献者）开发，使用相同的 AGPL-3.0 许可。原插件打开的是虚拟文件夹，AI 助手等只能处理真实文件的工具进不去，这是这个分支要解决的问题。聊天、协作者光标、项目历史、SyncTeX 等功能来自原项目，详细说明见[原项目的文档](https://github.com/overleaf-workshop/Overleaf-Workshop/wiki)。许可证见 [LICENSE](./LICENSE)。
