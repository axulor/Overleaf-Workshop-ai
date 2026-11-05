# Overleaf Workshop AI

把 Overleaf 上的在线项目同步成一个真实的本地文件夹。在 VS Code 里改文件，就像在网页上改一样：修改实时到达合作者，编译在 Overleaf 上进行，批注也能在本地查看和处理。

> **English:** A VS Code extension that keeps an Overleaf project in a real local folder, in both directions and in real time, so any tool can edit it. Compiling happens on Overleaf, and comments can be read and handled locally. It is an unofficial fork of [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop). The interface is currently mostly in Chinese.

这是 [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop)（iamhyc 及贡献者）的非官方分支，使用相同的 AGPL-3.0 许可，与 Overleaf 官方和原项目都没有关系。

它和原插件的主要区别：原插件打开的是虚拟文件夹，AI 助手等只能处理真实文件的工具进不去；这里的项目就是一个普通文件夹，任何工具改了文件，修改都会同步到 Overleaf。

```
my-paper/                    在 VS Code 里打开这个文件夹
├─ overleaf-<项目名>/         Overleaf 项目，和线上双向同步
│  └─ .output/               编译生成的 PDF 和日志，以及批注
├─ .vscode/settings.json     装了 LaTeX Workshop 时才会生成，见“编译”
└─ zh/, data/, code/, ...    其他文件夹只留在本地，不会上传
```

## 安装

需要 VS Code 1.80 或更高版本。目前没有上架扩展市场，需要自己打包：

```
git clone https://github.com/axulor/Overleaf-Workshop-ai.git
cd Overleaf-Workshop-ai
npm install
cd views/chat-view && npm install && cd ../..
npx @vscode/vsce package --out overleaf-workshop-ai.vsix
code --install-extension overleaf-workshop-ai.vsix
```

它和原插件不能同时运行，请先在扩展面板里**禁用原来的 Overleaf Workshop**。

## 开始使用

1. **登录。** 打开侧边栏的 Overleaf 面板，添加服务器 `https://www.overleaf.com`，选择 Login with Cookies，粘贴 Cookie（获取方法见下）。
2. **打开论文文件夹。** 在 VS Code 里打开你存放这篇论文的本地文件夹，也就是 `overleaf-<项目名>/` 的上一级。直接打开 `overleaf-<项目名>/` 不会同步，插件会提示你。
3. **同步。** 把鼠标移到面板里的项目上，点云朵图标（`同步到本地`），确认后会生成 `overleaf-<项目名>/`。状态栏显示 `Overleaf：已同步` 就可以开始了。

之后再打开这个文件夹时，会自动恢复同步。

**获取 Cookie：** 在已登录 Overleaf 的浏览器里按 <kbd>F12</kbd> 打开开发者工具，切到“网络”标签，打开 Overleaf 主页，筛选 `/project` 并选中完全匹配的那一项，复制请求头里 `Cookie` 的值。它的格式类似 `overleaf_session2=...`。Cookie 相当于你的登录凭据，不要发给别人。

## 同步

- 任何工具对文件的修改，大约一秒后到达 Overleaf。在 VS Code 里打字也一样，不用保存。
- 发送的是实时的差异编辑，不是整个替换文件，所以合作者的批注不会丢。
- 线上的修改实时到达本地，包括你正开着、还没保存的文件。
- 两边改了同一处时不会互相覆盖：由你选择保留哪一边，而且这个选择只决定冲突的地方，其他修改都会保留。选择线上版本时，本地版本的副本存在 `.overleaf/sync/conflicts/`。同一段的不同句子会自动合并。
- 本地删除文件时，要你确认后才会删除线上的，文档上的批注也会一起删除。线上删除的文件，本地副本会移到 `.overleaf/sync/trash/`。
- 本地重命名文件，或者把文件移到另一个文件夹（不改名），线上也会同样操作，批注会保留。同时改名和移动时，会变成上传新文件加删除旧文件，批注不会保留。
- VS Code 关闭或断网期间的修改，重新连接后会自动合并。断线后会重新加入项目，状态栏在这期间显示离线。
- 如果某个工具（不是在 VS Code 里打字）写入的文件缺少线上五分钟内到达的最后一次修改，它可能是根据旧副本写的，这时不会发送，而是提示你选择。这样合作者的文字不会被悄悄覆盖。工具有意删除别人刚写的内容时，也会这样问一次。如果工具只是恰好在修改到达的瞬间写入，两边的内容会自动合并，不会打扰你。

状态栏的 `Overleaf：` 显示当前状态，有冲突时单击可以处理，显示“未同步”时单击可以查看原因。

**有两种文件不会同步，插件会提示你，修改后就恢复同步：**

- 含有 Overleaf 无法保存的字符，比如表情符号、部分数学字母（𝐱）和极少数生僻字（𠮷）。Overleaf 收到这种字符会断开连接并丢弃整次修改，所以插件不会发送，并提示字符和行号。
- 不是 UTF-8 编码的文本文件。

以下文件不会同步，它们留在各自一边：隐藏文件（以 `.` 开头）、LaTeX 中间文件（`*.aux`、`*.log`、`*.bbl`、`*.out`、`*.toc` 等）、`main.pdf` 和 `output.pdf`。需要调整时，可以在 `overleaf-<项目名>/.overleaf/settings.json` 里设置 `ignore-patterns`，它会替换这个默认列表。`.overleaf`、`.output` 和 `.git` 文件夹始终不会同步。

## 编译

| 操作 | 快捷键 |
|---|---|
| 在 Overleaf 上编译（也可以点标题栏带圆圈的 ▶） | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd> |
| 查看 PDF | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> |
| 从代码跳到 PDF（在 PDF 上双击可以跳回代码） | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd> |

- 编译前会先把本地修改全部发出去，手动编译后会在旁边打开 PDF。
- PDF 和日志保存在 `overleaf-<项目名>/.output/`。
- 和 Overleaf 网页一样，日志里有 LaTeX 错误但生成了 PDF 时，不算编译失败：状态栏显示警告，错误列在“问题”面板。
- 编译失败时会说明原因（比如超时，免费版的时限约为 10 秒），每次编译都记录在 `Overleaf Workshop AI` 输出通道。

**和 LaTeX Workshop 一起用：** 同步下来的是真实的 `.tex` 文件，LaTeX Workshop 会把它们当成自己的，一改就在本地编译，没装 TeX 时会不断弹错。所以同步的工作区会在 `.vscode/settings.json` 里关掉它的自动编译和编译快捷键，已经设置过的值不会改动。它自己的绿色 ▶ 按钮还在，那个仍然是本地编译。

## 批注

Overleaf 上的批注会显示在对应的文字和 VS Code 的批注面板里，并随文字移动。在本地也可以处理，合作者会实时看到：

| 操作 | 方法 |
|---|---|
| 添加批注 | 选中文字后右键选 `添加 Overleaf 批注`，或者点行号旁的 `+` 批注整行 |
| 回复 | 展开批注，在下面的框里写 |
| 编辑、删除 | 批注上的铅笔和垃圾桶，只有自己写的才有。删除批注会连同它的回复一起删除 |
| 解决 | 批注标题上的 ✓。解决后它不再显示在正文和面板里，但记录还在 |
| 重新打开 | 批注面板上方的 🕘 按钮 |

这些操作都是立刻显示、后台发送。如果 Overleaf 拒绝，改动会撤回，并提示原因和重试。

所有批注也写在 `overleaf-<项目名>/.output/comments.md` 里，包括文件、行号、原文、作者和内容，方便任何工具读取。改动这个文件不会影响 Overleaf。

## 和 AI 助手一起用

插件本身不包含 AI 功能，只负责让项目成为真实文件夹。在 VS Code 里打开论文文件夹后，AI 助手可以：

- 直接修改 `overleaf-<项目名>/` 里的文件，修改会自动同步，合作者也会实时看到，和其他人的编辑一样；
- 读取 `.output/comments.md` 了解批注；
- 读取 `.output/output.log` 查看编译错误。

## 设置

| 设置 | 默认 | 作用 |
|---|---|---|
| `overleaf-workshop.projectManager.showOriginalOpenActions` | 关 | 在项目列表里显示原插件的打开方式：`Open Project in Current Window`、`Open Project in New Window`（虚拟文件夹）和 `Open Project Locally ...`（不会自动同步的旧本地副本） |

## 注意事项

- **一个文件夹只能同步一个项目。** 同一个文件夹里有多个同步文件夹时，只有一个会同步，插件会提示。
- **同一个文件夹不要同时用两个编辑器打开**（比如 VS Code 和 Cursor），也不要放在网盘的同步目录里。两边都会发送同一处修改，文字可能重复。
- **`Ctrl+Z` 可能撤销合作者的修改。** 线上的修改会进入编辑器的撤销记录，所以连续撤销时可能把别人刚写的内容也撤掉，撤销的结果同样会同步。和合作者同时编辑一个文件时，撤销前请留意。
- **保存时自动格式化的设置也会生效。** 打字会自动保存，所以开启了 `editor.formatOnSave` 或 `files.trimTrailingWhitespace` 的话，每次停顿都可能改动文件并同步给合作者，建议在这个工作区关闭。
- **只有大小写不同的文件名**（`Intro.tex` 和 `intro.tex`）在 Windows 上是同一个文件，请避免。
- **Cookie 会过期。** 过期后需要在 Overleaf 面板重新登录。
- **这是非官方工具。** 它使用 Overleaf 网页版自己的接口，这些接口可能随时变化，Overleaf 的使用条款也对脚本化访问有限制，请自行判断。
- **出错时可以回退。** Overleaf 自带的历史记录（History）可以恢复任何版本，第一次用在重要项目上时，建议先在历史记录里加一个标签。
- **多人协作的验证还有限。** 同步和批注都在真实的 Overleaf 上测试过，包括两个连接同时编辑和断线重连，但用的是同一个账号，目前也只用过测试项目。合作者账号能否编辑、删除自己的批注还没有验证，如果 Overleaf 拒绝，界面会撤回并提示。

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

基于 [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop) 开发。聊天、协作者光标、项目历史、SyncTeX 等功能来自原项目，详细说明见[原项目的文档](https://github.com/overleaf-workshop/Overleaf-Workshop/wiki)。许可证见 [LICENSE](./LICENSE)。
