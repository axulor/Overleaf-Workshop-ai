# Overleaf Workshop AI

把 Overleaf 项目同步成一个真实的本地文件夹。在 VS Code 里改文件，就像在网页上改一样：合作者实时看到，编译在 Overleaf 上完成，AI 助手也能直接改。

> **English:** A VS Code extension that keeps an Overleaf project in a real local folder, both ways and in real time. Compiling happens on Overleaf. It is an unofficial fork of [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop), and its interface is mostly in Chinese.

## 开始使用

**1. 安装。** 需要 VS Code 1.80 或更高版本，并先在扩展面板里禁用原来的 Overleaf Workshop。目前没有上架扩展市场，需要自己打包：

```
git clone https://github.com/axulor/Overleaf-Workshop-ai.git
cd Overleaf-Workshop-ai
npm install
cd views/chat-view && npm install && cd ../..
npx @vscode/vsce package --out overleaf-workshop-ai.vsix
code --install-extension overleaf-workshop-ai.vsix
```

**2. 登录。** 在侧边栏的 Overleaf 面板添加服务器 `https://www.overleaf.com`，选择 Login with Cookies，粘贴 Cookie。

Cookie 的获取方法：在已登录的浏览器里按 <kbd>F12</kbd>，切到“网络”标签，打开 Overleaf 主页，选中名为 `project` 的请求，复制请求头里 `Cookie` 的值。它相当于登录凭据，不要发给别人。

**3. 同步。** 在 VS Code 里打开论文所在的文件夹，把鼠标移到面板里的项目上，点云朵图标。状态栏显示 `Overleaf：已同步` 就可以开始了，之后打开这个文件夹会自动恢复同步。

```
my-paper/                 在 VS Code 里打开这一层
├─ overleaf-<项目名>/      和线上双向同步，PDF 和批注在其中的 .output/
└─ zh/, data/, code/ ...  其他文件夹只留在本地
```

## 日常使用

### 改文件

直接改就行，不用保存。修改约一秒后到达 Overleaf，合作者的修改也会实时出现在你的文件里。

- 两边改到同一处时，由你选择保留哪一边，其他修改都会保留。
- 断网或关闭 VS Code 期间的修改，重新连接后自动合并。
- 新建、重命名和移动文件或文件夹，另一边都会跟着变，批注保留。
- 状态栏的 `Overleaf：` 显示当前状态，有冲突或文件未同步时单击处理。

### 编译和 PDF

本地不用装 TeX，免费账号就能用。

| 操作 | 方法 |
|---|---|
| 编译 | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd>，或点标题栏的绿色叶子图标 |
| 查看 PDF | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> |
| 从 tex 跳到 PDF | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd>，或在 tex 里右键，目标位置会闪一下黄色 |
| 从 PDF 跳回 tex | 双击 PDF 上的位置 |

如果装了 LaTeX Workshop，插件会在这个工作区关掉它的自动编译和快捷键，它自己的绿色 ▶ 按钮仍然是本地编译。

### 批注

批注显示在对应的文字旁，并随文字移动。选中文字后右键可以添加，展开批注可以回复、编辑、删除和解决。操作立刻显示，合作者实时可见。

### 和 AI 助手一起用

AI 助手可以直接修改 `overleaf-<项目名>/` 里的文件，也可以读取 `.output/comments.md`（批注）和 `.output/output.log`（编译日志）。如果它写入的文件缺少线上刚到的修改，插件不会发送，而是先问你，以免覆盖合作者的文字。

## 删除和回收站

| 操作 | 结果 |
|---|---|
| 删除项目里的文件或文件夹 | 先弹窗确认，确认后线上也删除；取消则恢复到本地 |
| 线上删除文件 | 本地副本移到 `.overleaf/sync/trash/`，右下角提示 |
| 删除整个本地文件夹 | 线上项目不受影响，同步断开 |
| 项目进回收站或归档 | 同步暂停，恢复项目后自动继续并合并 |
| 项目被彻底删除，或你被移出项目 | 本地文件保留，成为普通文件夹 |

在网页上操作项目时，插件大约一分钟内察觉，切回 VS Code 时也会马上检查。

## 注意事项

- 不要同时用两个编辑器打开同一个文件夹，也不要放在网盘同步目录里，否则文字可能重复。
- `Ctrl+Z` 可能撤销合作者刚写的内容。
- 打字会自动保存，开启了 `editor.formatOnSave` 的话，每次停顿都可能改动文件并同步给合作者，建议在这个工作区关闭。
- 隐藏文件和 LaTeX 中间文件不会同步。含表情符号等 Overleaf 无法保存的字符、或不是 UTF-8 编码的文件也不会同步，插件会提示，改好后自动恢复。
- 用 `\input` 引入的文件，文件名不要带空格，否则从 PDF 跳回时会跳错文件。
- Cookie 过期后，在 Overleaf 面板退出并重新登录，同步会自动继续。
- 这是非官方工具，使用 Overleaf 网页版自己的接口，这些接口可能变化，Overleaf 的使用条款也对脚本化访问有限制，请自行判断。第一次用在重要项目上时，建议先在 Overleaf 的历史记录（History）里加一个标签，出错时可以回退。
- 目前只用同一个账号在真实的 Overleaf 上测试过，合作者账号的部分操作还没有验证。

## 来源

基于 [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop)（iamhyc 及贡献者）开发，使用相同的 AGPL-3.0 许可，与 Overleaf 官方和原项目都没有关系。许可证见 [LICENSE](./LICENSE)，运行测试用 `test\run.ps1`。
