"use strict";

import { Uri } from "vscode";
import { AsmParser, AsmLine, AsmFilter, BinaryAsmLine } from "./asm";
import { CompileCommands } from "./compile_commands";
import * as fs from "fs";

export class AsmDocument {
	lines: AsmLine[] = [];
	sourceToAsmMapping = new Map<number, number[]>();

	constructor(uri: Uri) {
		CompileCommands.compile(uri);

		this.lines = this.processAssemblyFile(uri);
	}

	private processAssemblyFile(uri: Uri): AsmLine[] {
		const asmContents = fs.readFileSync(uri.path).toString();
		const filter = this.getAsmFilter(uri);

		return new AsmParser().process(asmContents, filter);
	}

	private getAsmFilter(uri: Uri) {
		// Currently binary parsing is not needed, because assembly is always generated.
		const useBinaryParsing = false;
		const filter = new AsmFilter();

		filter.binary = useBinaryParsing;
		return filter;
	}

	get value(): string {
		let result = "";
		this.lines.forEach(line => {
			if (line instanceof BinaryAsmLine) {
				let address = ("0000000" + line.address.toString(16)).substr(
					-8
				);
				result += `<${address}> ${line.text}\n`;
			} else {
				result += line.text + "\n";
			}
		});
		return result;
	}
}
