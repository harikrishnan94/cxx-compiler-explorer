'use strict';

import { workspace, Uri, EventEmitter, FileSystemWatcher, window } from 'vscode';
import { AsmParser, AsmLine, AsmFilter } from './asm';
import { CompilationInfo } from './provider';

export class AsmDocument {

    private _uri: Uri;
    private _compinfo: CompilationInfo;
    private _emitter: EventEmitter<Uri>;
    private _watcher: FileSystemWatcher;
    lines: AsmLine[] = [];
    sourceToAsmMapping = new Map<number, number[]>();

    constructor(uri: Uri, compinfo: CompilationInfo, emitter: EventEmitter<Uri>) {
        this._uri = uri;
        this._compinfo = compinfo;

        // The AsmDocument has access to the event emitter from
        // the containg provider. This allows it to signal changes
        this._emitter = emitter;

        // Watch for underlying assembly file and reload it on change
        this._watcher = workspace.createFileSystemWatcher(compinfo.srcUri.path);
        this._watcher.onDidChange(() => this.updateLater());
        this._watcher.onDidCreate(() => this.updateLater());
        this._watcher.onDidDelete(() => this.updateLater(true));

        this.update(false);
    }

    private updateLater(deleted: boolean = false) {
        // Workarond for https://github.com/Microsoft/vscode/issues/72831
        setTimeout(async () => await this.update(deleted), 100);
    }

    private async update(deleted: boolean) {
        if (deleted) {
            this.lines = [new AsmLine(`Failed to load file '${this._uri.path}'`, undefined, [])];
        } else {
            const filter = new AsmFilter();
            filter.binary = false;
            try {
                const asm = await this._compinfo.compdb.compile(this._compinfo.srcUri, this._compinfo.extraArgs);
                this.lines = new AsmParser().process(asm, filter).asm;
            } catch (error) {
                if (error instanceof Error)
                    window.showErrorMessage(`Failed to show assembly: ${error.message}`);
                else
                    window.showErrorMessage(`Failed to show assembly: ${JSON.stringify(error)}`);
            }
        }
        this._emitter.fire(this._uri);
    }

    get value(): string {
        return this.lines.reduce((result, line) => result += line.value, '');
    }

    dispose(): void {
        this._watcher.dispose();
    }
}
