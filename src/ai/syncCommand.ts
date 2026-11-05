/** Marks the command file as this extension's, so it can be updated. Removing the line makes it yours to keep. */
export const SYNC_COMMAND_MARKER = '<!-- overleaf-workshop-ai:sync:v1 -->';
export const SYNC_COMMAND_PATTERN = /<!-- overleaf-workshop-ai:sync:v(\d+) -->/;
export const SYNC_COMMAND_VERSION = 1;

export const SYNC_COMMAND = `---
description: 双向同步 zh/ 里的中文稿和 Overleaf 项目里的英文 LaTeX，然后编译
---
${SYNC_COMMAND_MARKER}
把中文稿和英文稿同步一遍。用户的补充说明：$ARGUMENTS

工作区里有两部分：\`zh/\` 是只留在本地的中文稿（一个或多个 Markdown 文件，可能带图片）；\`overleaf-项目名/\` 是 Overleaf 项目。项目文件夹里的修改会自动实时同步到 Overleaf，不需要上传，合作者也会立刻看到。

## 1. 先检查

调用 \`status\` 和 \`translation_changes\`。

- \`typoraUnsaved\` 不为空：停下，请用户先在 Typora 里保存这些文件。未保存的内容读不到，之后保存还会覆盖你的修改。
- \`status\` 里有 \`conflicts\`，或者 \`connected\` 为 false：告诉用户，等处理好再继续。
- \`initialized\` 为 false：说明是第一次同步，看第 2 步。
- 两边都没有变化：告诉用户已经同步，直接到第 6 步。

## 2. 第一次同步

先读两边的文件，再判断：

- 两边内容已经对应：直接调用 \`translation_mark_synced\`，把现状作为基线。
- 只有英文：先问用户，确认后把 tex 翻译成中文稿写入 \`zh/\`，按章节拆成多个文件并用序号命名。
- 只有中文：先问用户，确认后翻译到项目的 tex 文件。
- 两边都有但对不上：列出差异，请用户决定以哪边为准，不要自己猜。

## 3. 同步修改

只处理 \`translation_changes\` 里列出的差异。用章节标题定位，再按内容找到另一种语言里对应的段落。

- **中文改了：** 改对应的英文。
- **英文改了（合作者或用户改的）：** 改对应的中文。如果只是英文措辞润色、意思没变，中文不用动，在汇报里说明。
- **同一段两边都改了，而且意思不一致：** 停下，把两边的内容都给用户看，由用户决定。

规则：

- 只改受影响的句子。没有变化的句子一字不动，不要顺手润色，也不要重译。
- 公式、\`\\label\`、\`\\ref\`、\`\\cite\`、表格和图的结构要保持对应，不要改标签和引用的键名。
- 不动导言区和模板部分，除非差异本身涉及。
- 术语优先用 \`zh/glossary.md\` 里的译法（如果有）。遇到新的重要术语时加进去，并在汇报里提一句。
- 用项目文件夹里已有的写法：段落是否一行、缩进和引用风格都照原样。

## 4. 图片

\`images\` 里列出了 \`zh/\` 里变化的图片。

- 新图片如果在英文稿里还没有对应的图：复制到项目文件夹（放在已有图片旁边），在 tex 里加上 figure 环境，图注译成英文。
- 英文稿里已有对应的图：不要替换，只调整图注。图里如果有中文文字，提醒用户英文稿需要英文版的图。

## 5. 记录

确认修改都写完后，调用 \`translation_mark_synced\`，在 \`edited\` 里列出你创建或修改的每个文件，路径要和 \`translation_changes\` 显示的一致。

如果返回了 \`notMarked\`，说明这些文件在同步期间又被别人改了。不要在这一轮处理，告诉用户下次运行时会处理。

## 6. 编译

调用 \`compile\`。

- 如果有错误是你这次的修改造成的：修好后再编译一次。
- 如果是原本就有的错误：不要动，在汇报里列出来。

## 7. 汇报

用中文简短说明：改了哪些文件的哪些部分（方向分别是中译英还是英译中）、新增的术语、编译结果、需要用户决定或留到下次的事情。
`;
