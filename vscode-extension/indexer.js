'use strict';

const vscode = require('vscode');
const path = require('path');

class CodebaseIndexer {
    constructor() {
        this.index = new Map();
        this.files = [];
        this.ready = false;
    }

    async build() {
        this.ready = false;
        this.index.clear();
        const include = '**/*.{js,ts,py,go,rs,java,cpp,c,cs}';
        const exclude = '**/{.git,node_modules,dist,build,out,target,.next,.cache,__pycache__}/**';
        const uris = await vscode.workspace.findFiles(include, exclude, 10000);
        this.files = uris.map((u) => u.fsPath);
        for (const fsPath of this.files) {
            const rel = vscode.workspace.asRelativePath(fsPath).toLowerCase();
            const base = path.basename(fsPath).toLowerCase();
            const tokens = new Set(
                `${rel} ${base}`
                    .split(/[^a-z0-9_./-]+/i)
                    .map((t) => t.trim())
                    .filter(Boolean)
            );
            this.index.set(fsPath, tokens);
        }
        this.ready = true;
        return { filesIndexed: this.files.length };
    }

    searchIndex(query, limit = 5) {
        if (!this.ready || !query) return [];
        const qTokens = String(query).toLowerCase().split(/[^a-z0-9_./-]+/i).filter(Boolean);
        if (!qTokens.length) return [];
        const scored = [];
        for (const [fsPath, tokens] of this.index.entries()) {
            let score = 0;
            for (const q of qTokens) {
                for (const t of tokens) {
                    if (t === q) score += 3;
                    else if (t.includes(q)) score += 1;
                }
            }
            if (score > 0) scored.push({ fsPath, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map((r) => ({
            path: r.fsPath,
            relativePath: vscode.workspace.asRelativePath(r.fsPath),
            name: path.basename(r.fsPath),
            score: r.score,
        }));
    }
}

module.exports = { CodebaseIndexer };
