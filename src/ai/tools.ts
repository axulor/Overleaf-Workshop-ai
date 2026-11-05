/** The tools offered to AI assistants. This module is also loaded outside VS Code, by the MCP server. */
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: object;
}

const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };

export const TOOLS: ToolDefinition[] = [
    {
        name: 'status',
        description: 'Shows whether the Overleaf project is connected and in sync: where its folder is, changes still being sent, conflicts waiting for the user, and files that failed to sync. Edits to files in the project folder reach Overleaf by themselves, so nothing needs to be uploaded.',
        inputSchema: NO_INPUT,
    },
    {
        name: 'compile',
        description: 'Sends all pending changes, compiles the project on Overleaf, and opens the PDF in VS Code. Returns the status, every LaTeX error with its file and line, the number of warnings, and the paths of the PDF and the full log.',
        inputSchema: NO_INPUT,
    },
    {
        name: 'translation_changes',
        description: 'Lists what changed in the Chinese manuscript (zh/) and the English LaTeX files since they were last marked as translated, with a diff for each file, plus changed images and any files with unsaved edits in Typora. Call this before translating. If initialized is false, nothing has been marked yet, and the result lists the files instead of diffs.',
        inputSchema: NO_INPUT,
    },
    {
        name: 'translation_mark_synced',
        description: 'Records that the two languages now correspond, so the next translation_changes only shows newer changes. Call it after translating and before finishing. Files that changed since translation_changes for any other reason, such as a collaborator editing online, are left unmarked and reported, so those changes are not lost.',
        inputSchema: {
            type: 'object',
            properties: {
                edited: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Every file you created or changed since translation_changes, as paths relative to the workspace folder, exactly as translation_changes shows them.',
                },
            },
            required: ['edited'],
            additionalProperties: false,
        },
    },
];

export const BRIDGE_FILE = 'bridge.json';
