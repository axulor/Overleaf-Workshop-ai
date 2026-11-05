# Overleaf Workshop AI

An unofficial fork of [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop) by iamhyc and contributors, under the same AGPL-3.0 license. It is not affiliated with Overleaf or with the original project, and it cannot run alongside the original extension: disable that one first.

It keeps an Overleaf project in a real local folder, so that editing it with any tool feels like editing it online: changes reach collaborators in real time, and compiling happens on Overleaf.

### Syncing a project to a local folder

The original extension opens a project in a virtual folder, which tools that work on real files cannot reach. Here, the project lives in a real folder:

```
my-paper/                    open this folder in VS Code
├─ overleaf-<project name>/  the Overleaf project, kept in step in both directions
├─ zh/, data/, code/, ...    anything else stays local
```

Open your paper's folder, hover over a project in the Overleaf panel and click the cloud icon (`同步到本地`).

- Any change to a file reaches Overleaf about a second later, whichever tool made it. Typing in VS Code does too, without saving.
- Changes are sent as real-time edits of the difference, not by replacing files, so collaborators' comments stay in place.
- Online changes arrive in the folder as they happen, including into a file open with unsaved typing.
- If both sides changed the same place, nothing is overwritten: both versions are kept and you choose one. Different sentences of one paragraph merge by themselves.
- Files deleted locally are only deleted online after you confirm. Files deleted online are moved to `.overleaf/sync/trash/` in the project folder.
- Compile results are copied to `.output/` in the project folder. A compile first sends all pending changes.
- Changes made while VS Code is closed or offline are merged when it reconnects.

### Compiling

- A PDF with LaTeX errors in its log no longer shows as a failed compile. As on Overleaf's own page, the PDF is available and the errors are listed in the Problems panel.
- A manual compile opens the PDF beside the editor.
- A failed compile says why, keeps its log, and each compile is recorded in the `Overleaf Workshop AI` output channel.
- The build cache is no longer cleared automatically. The option to recompile from scratch is in the compile settings menu.
- A manual compile is no longer sent to Overleaf as an auto-compile.
- An error during a compile no longer blocks later compiles until the window is reloaded.
- A project with no main document set uses `main.tex` or its only `.tex` file, and asks if neither applies.
- Next to LaTeX Workshop, a synced workspace turns off its automatic local builds and its compile shortcuts, in `.vscode/settings.json`, so `Ctrl+Alt+B` compiles on Overleaf and no local build fails on every change. A value already set in the workspace is left alone. LaTeX Workshop's own ▶ button stays and still builds locally; the button that compiles on Overleaf has a cloud icon.

To run the tests, which use fake Overleaf responses and need no account: `powershell -NoProfile -ExecutionPolicy Bypass -File test\run.ps1`. To try this build against a real account without touching your own VS Code: `test\dev-window.ps1`.

The rest of this document is from the original project.

---

Open Overleaf (ShareLatex) projects in VSCode, with full collaboration support.

### User Guide

The full user guide is available at [GitHub Wiki](https://github.com/overleaf-workshop/Overleaf-Workshop/wiki).

### Features

> [!NOTE]
> For SSO login or captcha enabled servers like `https://www.overleaf.com`, please use "**Login with Cookies**" method.
> For more details, please refer to [How to Login with Cookies](#how-to-login-with-cookies).

- Login Server, Open Projects and Edit Files

    <img src="https://raw.githubusercontent.com/overleaf-workshop/Overleaf-Workshop/master/docs/assets/demo01-login.gif" height=400px/>

- On-the-fly Compiling and Previewing
  > <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd> to compile, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> preview.

    <img src="https://raw.githubusercontent.com/overleaf-workshop/Overleaf-Workshop/master/docs/assets/demo03-synctex.gif" height=400px/>

- SyncTeX and Reverse SyncTeX
  > <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd> to jump to PDF.
  > Double click on PDF to jump to source code

- Chat with Collaborators

    <img src="https://raw.githubusercontent.com/overleaf-workshop/Overleaf-Workshop/master/docs/assets/demo06-chat.gif" height=400px/>

- Open Project Locally, Compile/Preview with [LaTeX-Workshop](https://github.com/James-Yu/LaTeX-Workshop)

    <img src="https://raw.githubusercontent.com/overleaf-workshop/Overleaf-Workshop/master/docs/assets/demo07-local.gif" height=400px/>

### How to Login with Cookies

<img src="https://raw.githubusercontent.com/overleaf-workshop/Overleaf-Workshop/master/docs/assets/login_with_cookie.png" height=400px/>

In an already logged-in browser (Firefox for example):

1. Open "Developer Tools" (usually by pressing <kbd>F12</kbd>) and switch to the "Network" tab;

   Then, navigate to the Overleaf main page (e.g., `https://www.overleaf.com`) in the address bar.

2. Filter the listed items with `/project` and select the exact match.

3. Check the "Cookie" under "Request Headers" of the selected item and copy its value to login.
    > The format of the Cookie value would be like: `overleaf_session2=...` or `sharelatex.sid=...`

### Compatibility

The following Overleaf (ShareLatex) Community Edition docker images provided on [Docker Hub](https://hub.docker.com/r/sharelatex/sharelatex) have been tested and verified to be compatible with this extension.

- [x] [sharelatex/sharelatex:5.0.4](https://hub.docker.com/layers/sharelatex/sharelatex/5.0.4/images/sha256-429f6c4c02d5028172499aea347269220fb3505cbba2680f5c981057ffa59316?context=explore) (verified by [@Mingbo-Lee](https://github.com/Mingbo-Lee))

- [x] [sharelatex/sharelatex:4.2.4](https://hub.docker.com/layers/sharelatex/sharelatex/4.2.4/images/sha256-ac0fc6dbda5e82b9c979721773aa120ad3c4a63469b791b16c3711e0b937528c?context=explore)

- [x] [sharelatex/sharelatex:4.1](https://hub.docker.com/layers/sharelatex/sharelatex/4.1/images/sha256-3798913f1ada2da8b897f6b021972db7874982b23bef162019a9ac57471bcee8?context=explore) (verified by [@iamhyc](https://github.com/iamhyc))

- [x] [sharelatex/sharelatex:3.5](https://hub.docker.com/layers/sharelatex/sharelatex/3.5/images/sha256-f97fa20e45cdbc688dc051cc4b0e0f4f91ae49fd12bded047d236ca389ad80ac?context=explore) (verified by [@iamhyc](https://github.com/iamhyc))

- [ ] [sharelatex/sharelatex:3.4](https://hub.docker.com/layers/sharelatex/sharelatex/3.4/images/sha256-2a72e9b6343ed66f37ded4e6da8df81ed66e8af77e553b91bd19307f98badc7a?context=explore)

- [ ] [sharelatex/sharelatex:3.3](https://hub.docker.com/layers/sharelatex/sharelatex/3.3/images/sha256-e1ec01563d259bbf290de4eb90dce201147c0aae5a07738c8c2e538f6d39d3a8?context=explore)

- [ ] [sharelatex/sharelatex:3.2](https://hub.docker.com/layers/sharelatex/sharelatex/3.2/images/sha256-5db71af296f7c16910f8e8939e3841dad8c9ac48ea0a807ad47ca690087f44bf?context=explore)

- [ ] [sharelatex/sharelatex:3.1](https://hub.docker.com/layers/sharelatex/sharelatex/3.1/images/sha256-5b9de1e65257cea4682c1654af06408af7f9c0e2122952d6791cdda45705e84e?context=explore)

- [ ] [sharelatex/sharelatex:3.0](https://hub.docker.com/layers/sharelatex/sharelatex/3.0/images/sha256-a36e54c66ef62fdee736ce2229289aa261b44f083a9fd553cf8264500612db27?context=explore)

### Development

Please refer to the development guidance in [CONTRIBUTING.md](./CONTRIBUTING.md)

### References

- [Overleaf Official Logos](https://www.overleaf.com/for/partners/logos)
- [Overleaf Web Route List](./docs/webapi.md)
- [James-Yu/LaTeX-Workshop](https://github.com/James-Yu/LaTeX-Workshop)
- [jlelong/vscode-latex-basics](https://github.com/jlelong/vscode-latex-basics/tags)
