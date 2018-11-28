// Copyright (c) 2016, Matt Godbolt
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import * as Path from "path";
import { workspace } from "vscode";

const tabsRe = /\t/g;
const lineRe = /\r?\n/;

export function splitLines(text: string) {
	const result = text.split(lineRe);
	if (result.length > 0 && result[result.length - 1] === "") {
		return result.slice(0, result.length - 1);
	}
	return result;
}

export function expandTabs(line: string) {
	let extraChars = 0;
	return line.replace(tabsRe, function(match, offset) {
		const total = offset + extraChars;
		const spacesNeeded = (total + 8) & 7;
		extraChars += spacesNeeded - 1;
		return "        ".substr(spacesNeeded);
	});
}

// Resolve path with almost all variable substitution that supported in
// Debugging and Task configuration files
export function resolvePath(path: string): string {
	if (workspace.workspaceFolders === undefined) {
		return path;
	}

	let parsedFilePath = Path.parse(path);
	let parsedWorkspacePath = Path.parse(workspace.rootPath!);

	let variables: any = {
		// the path of the folder opened in VS Code
		workspaceFolder:
			parsedWorkspacePath.dir + "/" + parsedWorkspacePath.name,
		// the name of the folder opened in VS Code without any slashes (/)
		workspaceFolderBasename: parsedWorkspacePath.name,
		// the current opened file
		file: path,
		// the current opened file relative to workspaceFolder
		relativeFile: Path.relative(parsedWorkspacePath.dir, path),
		// the current opened file's basename
		fileBasename: parsedFilePath.base,
		// the current opened file's basename with no file extension
		fileBasenameNoExtension: parsedFilePath.name,
		// the current opened file's dirname
		fileDirname: parsedFilePath.dir,
		// the current opened file's extension
		fileExtname: parsedFilePath.ext
	};

	const variablesRe = /\$\{(.*?)\}/g;
	const resolvedPath = path.replace(
		variablesRe,
		(match: string, name: string) => {
			const value = variables[name];
			if (value !== undefined) {
				return value;
			} else {
				// leave original (unsubstituted) value if there is no such variable
				return match;
			}
		}
	);

	// normalize a path, reducing '..' and '.' parts
	return Path.normalize(resolvedPath);
}
