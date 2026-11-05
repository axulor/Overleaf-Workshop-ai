import * as cp from 'child_process';

const LIST_WINDOWS_SCRIPT = `
if (-not (Get-Process Typora -ErrorAction SilentlyContinue)) { exit 0 }
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = [System.Windows.Automation.AutomationElement]::RootElement
foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    $window.Current.Name
}
`;

/** The files with unsaved edits, from Typora window titles such as `paper.md• - Typora`. */
export function unsavedFromTitles(titles: string[]): string[] {
    const unsaved: string[] = [];
    for (const title of titles) {
        const match = /^(.+?)\s*•\s*- Typora$/.exec(title.trim());
        if (match) { unsaved.push(match[1]); }
    }
    return unsaved;
}

/**
 * The files Typora holds unsaved edits for. An assistant reads the disk, so it would not see those edits,
 * and Typora saving them later would overwrite whatever changed meanwhile.
 */
export function listUnsavedTyporaFiles(): Promise<string[]> {
    if (process.platform !== 'win32') { return Promise.resolve([]); }
    return new Promise((resolve) => {
        cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_WINDOWS_SCRIPT],
            { windowsHide: true, timeout: 10000, encoding: 'utf8' },
            (error, stdout) => resolve(error ? [] : unsavedFromTitles(stdout.split(/\r?\n/))));
    });
}
