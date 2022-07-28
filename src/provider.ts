'use strict';

import { Uri, EventEmitter, TextDocumentContentProvider, Event } from 'vscode';
import { AsmDocument } from './document';
import { CompilationDatabase, getAsmUri } from "./compdb";

export interface CompilationInfo {
    srcUri: Uri,
    compdb: CompilationDatabase,
    extraArgs: string[]
}

export class AsmProvider implements TextDocumentContentProvider {

    static scheme = 'disassembly';

    private _compinfo = new Map<string, CompilationInfo>;
    private _documents = new Map<string, AsmDocument>();
    private _onDidChange = new EventEmitter<Uri>();

    provideTextDocumentContent(uri: Uri): string | Thenable<string> {
        const document = this.provideAsmDocument(uri);
        return document.value;
    }

    provideAsmDocument(uri: Uri): AsmDocument {
        let document = this._documents.get(uri.path);

        if (!document) {
            const compinfo = this._compinfo.get(uri.path)!;
            document = new AsmDocument(uri, compinfo, this._onDidChange);
            this._documents.set(uri.path, document);
        }

        return document;
    }

    async loadCompilationInfo(srcUri: Uri, asmUri: Uri, extraArgs: string[]) {
        const compdb = await CompilationDatabase.for(srcUri);
        this._compinfo.set(asmUri.path, { srcUri, compdb, extraArgs });
    }

    unload(srcUri: Uri) {
        const asmUri = getAsmUri(srcUri);
        const doc = this._documents.get(asmUri.path);
        doc?.dispose();
        this._documents.delete(asmUri.path);
        this._compinfo.delete(asmUri.path);
    }

    // Expose an event to signal changes of _virtual_ documents
    // to the editor
    get onDidChange(): Event<Uri> {
        return this._onDidChange.event;
    }

    dispose(): void {
        this._documents.clear();
        this._onDidChange.dispose();
    }

}
