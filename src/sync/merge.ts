import { createHash } from 'crypto';
import * as DiffMatchPatch from 'diff-match-patch';

export type SyncDecision = 'none' | 'pull' | 'push' | 'deleteLocal' | 'deleteRemote' | 'merge' | 'conflict';

/**
 * Decides what to do with one file from three versions: the last version both sides agreed on,
 * the local one and the online one. An absent file is undefined. Any value that identifies the
 * content works, so comparing fingerprints is enough.
 */
export function decide(base?: string, local?: string, remote?: string): SyncDecision {
    if (local === remote) { return 'none'; }
    if (base === undefined) {
        if (local === undefined) { return 'pull'; }
        if (remote === undefined) { return 'push'; }
        return 'conflict'; // both sides have a different file, with nothing to tell which is newer
    }
    if (local === base) { return remote === undefined ? 'deleteLocal' : 'pull'; }
    if (remote === base) { return local === undefined ? 'deleteRemote' : 'push'; }
    if (local === undefined || remote === undefined) { return 'conflict'; } // edited on one side, deleted on the other
    return 'merge';
}

export function fingerprint(content: string | Uint8Array): string {
    return createHash('sha256').update(content).digest('hex');
}

/**
 * The text of a file as Overleaf would hold it: no byte order mark, and \n line endings.
 * Returns undefined if the bytes are not valid UTF-8, because decoding them would corrupt the file.
 */
export function decodeText(bytes: Uint8Array): string | undefined {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n');
    } catch {
        return undefined;
    }
}

export type MergeResult = { ok: true, text: string } | { ok: false, conflicts: number };

interface Edit {
    start: number;
    end: number;
    text: string;
}

/** The changes that turn base into changed, as replacements of ranges of base, in order. */
function editsBetween(base: string, changed: string): Edit[] {
    const dmp = new DiffMatchPatch();
    const diffs = dmp.diff_main(base, changed);
    dmp.diff_cleanupSemantic(diffs);

    const edits: Edit[] = [];
    let position = 0;
    let current: Edit | undefined;
    for (const [operation, text] of diffs) {
        if (operation === 0) {
            if (current) { edits.push(current); current = undefined; }
            position += text.length;
            continue;
        }
        current = current ?? { start: position, end: position, text: '' };
        if (operation === -1) {
            position += text.length;
            current.end = position;
        } else {
            current.text += text;
        }
    }
    if (current) { edits.push(current); }
    return edits;
}

/**
 * Combines two sets of changes to the same text. Changes merge only if they neither overlap nor touch,
 * so a clean merge never has to guess: a paragraph in which both sides edited different sentences merges,
 * and anything closer than that is reported as a conflict.
 */
export function mergeText(base: string, local: string, remote: string): MergeResult {
    if (local === remote) { return { ok: true, text: local }; }

    const ours = editsBetween(base, local);
    const theirs = editsBetween(base, remote);
    const merged: Edit[] = [];
    let conflicts = 0;
    let i = 0;
    let j = 0;
    while (i < ours.length || j < theirs.length) {
        const a: Edit | undefined = ours[i];
        const b: Edit | undefined = theirs[j];
        if (a && b && a.start <= b.end && b.start <= a.end) {
            if (a.start === b.start && a.end === b.end && a.text === b.text) {
                merged.push(a);
            } else {
                conflicts++;
            }
            i++;
            j++;
        } else if (a && (!b || a.end < b.start)) {
            merged.push(a);
            i++;
        } else {
            merged.push(b);
            j++;
        }
    }
    if (conflicts > 0) { return { ok: false, conflicts }; }

    let text = '';
    let position = 0;
    for (const edit of merged) {
        text += base.slice(position, edit.start) + edit.text;
        position = edit.end;
    }
    return { ok: true, text: text + base.slice(position) };
}
