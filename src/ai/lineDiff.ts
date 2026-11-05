import * as DiffMatchPatch from 'diff-match-patch';

const CONTEXT_LINES = 2;

interface DiffLine {
    kind: ' ' | '-' | '+';
    text: string;
}

/** Compares two texts line by line. Comparing whole lines keeps the diff readable, as a LaTeX paragraph is often one line. */
function diffLines(before: string, after: string): DiffLine[] {
    const dmp = new DiffMatchPatch() as any;
    const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(before, after);
    const diffs = dmp.diff_main(chars1, chars2, false);
    dmp.diff_charsToLines_(diffs, lineArray);

    const lines: DiffLine[] = [];
    for (const [operation, part] of diffs as [number, string][]) {
        const kind = operation === 0 ? ' ' : operation === -1 ? '-' : '+';
        const parts = part.split('\n');
        if (parts[parts.length - 1] === '') { parts.pop(); }
        parts.forEach((text) => lines.push({ kind, text }));
    }
    return lines;
}

/** A unified diff, with line numbers, of two texts. Empty if they are the same. */
export function unifiedDiff(before: string, after: string): string {
    if (before === after) { return ''; }
    const lines = diffLines(before, after);

    const output: string[] = [];
    let oldLine = 1;
    let newLine = 1;
    let index = 0;
    while (index < lines.length) {
        if (lines[index].kind === ' ') {
            oldLine++;
            newLine++;
            index++;
            continue;
        }
        // A hunk runs from this change to the last one that has no long unchanged stretch before it.
        const start = Math.max(0, index - CONTEXT_LINES);
        let end = index;
        let unchanged = 0;
        for (let i = index; i < lines.length && unchanged <= CONTEXT_LINES * 2; i++) {
            if (lines[i].kind === ' ') {
                unchanged++;
            } else {
                unchanged = 0;
                end = i;
            }
        }
        const stop = Math.min(lines.length, end + 1 + CONTEXT_LINES);
        const hunk = lines.slice(start, stop);
        const leading = index - start;
        const oldCount = hunk.filter((line) => line.kind !== '+').length;
        const newCount = hunk.filter((line) => line.kind !== '-').length;
        output.push(`@@ -${oldLine - leading},${oldCount} +${newLine - leading},${newCount} @@`);
        hunk.forEach((line) => output.push(line.kind + line.text));

        for (let i = index; i < stop; i++) {
            if (lines[i].kind !== '+') { oldLine++; }
            if (lines[i].kind !== '-') { newLine++; }
        }
        index = stop;
    }
    return output.join('\n');
}
