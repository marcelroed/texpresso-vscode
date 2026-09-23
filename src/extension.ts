import * as vscode from 'vscode';
import { ChildProcess, spawn, execSync } from 'child_process';
import * as tmp from 'tmp';
import * as fs from 'fs';
import * as path from 'path';
import { windowsToWslSync, wslToWindowsSync } from 'wsl-path';

import Rope from './rope';

tmp.setGracefulCleanup();

class WSLPathConverter {
	private enabled: boolean;

	constructor(useWSL: boolean) {
		this.enabled = useWSL;
	}

	toWindows(wslPath: string): string {
		if (!this.enabled) {
			return wslPath;
		}
		try {
			return wslToWindowsSync(wslPath);
		} catch (error) {
			return wslPath;
		}
	}

	toWSL(windowsPath: string): string {
		if (!this.enabled) {
			return windowsPath;
		}
		try {
			return windowsToWslSync(windowsPath);
		} catch (error) {
			return windowsPath;
		}
	}
}

// Documents such as the old side of a git diff (scheme `git:`) share the fsPath of the
// real file but hold different contents, so only `file:` documents stand for files on disk.
function isFileDocument(doc: vscode.TextDocument): boolean {
	return doc.uri.scheme === 'file';
}

interface TrackedFile {
	index: number;
	relativePath: string;
	absolutePath: string;
	isOpen: boolean;
	document?: vscode.TextDocument;
	rope?: Rope;
}

class FileRegistry {
	private files = new Map<number, TrackedFile>();
	private pathToIndex = new Map<string, number>();
	private pathConverter: WSLPathConverter;

	constructor(private documentDir: string, useWSL: boolean) {
		this.pathConverter = new WSLPathConverter(useWSL);
	}

	addFile(index: number, relativePath: string, sendCommand: (cmd: any[]) => void) {
		const absolutePath = this.resolvePath(relativePath);
		const isOpen = vscode.workspace.textDocuments.some(doc => 
			isFileDocument(doc) && doc.uri.fsPath === absolutePath);
		const document = isOpen ? vscode.workspace.textDocuments.find(doc => 
			isFileDocument(doc) && doc.uri.fsPath === absolutePath) : undefined;

		const file: TrackedFile = {
			index, relativePath, absolutePath, isOpen, document,
			rope: undefined
		};

		this.files.set(index, file);
		this.pathToIndex.set(absolutePath, index);

		if (document && isOpen) {
			const message = ["open", absolutePath, document.getText()];
			sendCommand(message);
		}
	}

	findByIndex(index: number): TrackedFile | undefined {
		return this.files.get(index);
	}

	findByPath(absolutePath: string): TrackedFile | undefined {
		// Try direct lookup first
		let index = this.pathToIndex.get(absolutePath);
		
		// If not found, try with path conversion (handles WSL/Windows path mismatches)
		if (index === undefined) {
			const convertedPath = this.pathConverter.toWindows(absolutePath);
			index = this.pathToIndex.get(convertedPath);
			
			// Also try the reverse conversion
			if (index === undefined) {
				const wslPath = this.pathConverter.toWSL(absolutePath);
				const reconvertedPath = this.pathConverter.toWindows(wslPath);
				index = this.pathToIndex.get(reconvertedPath);
			}
		}
		
		return index !== undefined ? this.files.get(index) : undefined;
	}

	private resolvePath(relativePath: string): string {
		const resolved = relativePath.startsWith('/') ? 
			relativePath : 
			path.resolve(this.documentDir, relativePath);
		
		// Always return Windows paths for VSCode compatibility
		return this.pathConverter.toWindows(resolved);
	}

	updateDocument(absolutePath: string, document: vscode.TextDocument | undefined, isOpen: boolean, sendCommand: (cmd: any[]) => void) {
		const file = this.findByPath(absolutePath);
		if (file) {
			const wasOpen = file.isOpen;
			file.isOpen = isOpen;
			file.document = document;

			if (isOpen && !wasOpen && document) {
				const message = ["open", file.absolutePath, document.getText()];
				sendCommand(message);
			}
		}
	}

	clear() {
		this.files.clear();
		this.pathToIndex.clear();
	}
}

let texpresso: ChildProcess;
let rope: Rope;
let filePath: string;
let documentDir: string;
let registry: FileRegistry;

export function activate(context: vscode.ExtensionContext) {

	if (texpresso) {
		texpresso.kill();
	}

	const outputChannel = vscode.window.createOutputChannel('TeXpresso', { log: true });
	const debugChannel = vscode.window.createOutputChannel('TeXpresso Debug', { log: true });
	let providedOutput = "";
	let outputChanged = true;

	function sendCommand(command: any[]) {
		if (texpresso && texpresso.stdin) {
			const commandJson = JSON.stringify(command);
			texpresso.stdin.write(commandJson + '\n');
			debugChannel.appendLine(`Sent command: ${commandJson}`);
		}
	}

	const useWSL = vscode.workspace.getConfiguration('texpresso').get('useWSL') as boolean;
	const useChangeRangeMode = vscode.workspace.getConfiguration('texpresso').get('useChangeRangeMode') as boolean;

	let activeEditor: vscode.TextEditor | undefined;

	// A full build writing a new .bbl into an include path (e.g. after adding
	// a citation) makes TeXpresso rescan its inputs, so the preview picks it up.
	let includeWatchers: vscode.FileSystemWatcher[] = [];
	let rescanTimer: NodeJS.Timeout | undefined;

	function disposeIncludeWatchers() {
		includeWatchers.forEach(w => w.dispose());
		includeWatchers = [];
		if (rescanTimer) {
			clearTimeout(rescanTimer);
			rescanTimer = undefined;
		}
	}

	function watchIncludePath(dir: string) {
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(dir), '*.bbl'));
		const onChange = (uri: vscode.Uri) => {
			if (rescanTimer) {
				clearTimeout(rescanTimer);
			}
			rescanTimer = setTimeout(() => {
				rescanTimer = undefined;
				outputChannel.appendLine(`${uri.fsPath} changed, rescanning`);
				sendCommand(['rescan']);
			}, 200);
		};
		watcher.onDidChange(onChange);
		watcher.onDidCreate(onChange);
		includeWatchers.push(watcher);
	}

	async function startDocumentFromEditor(editor: vscode.TextEditor | undefined) {
		if (texpresso) {
			texpresso.kill();
		}
		disposeIncludeWatchers();

		if (editor) {
			activeEditor = editor;
			filePath = activeEditor.document.fileName;
			documentDir = path.dirname(filePath);
			registry = new FileRegistry(documentDir, useWSL);
			const text = activeEditor.document.getText();

			// Check if document contains \begin{document} to determine if it's likely a main document
			if (!text.includes('\\begin{document}')) {
				const result = await vscode.window.showWarningMessage(
					'The current document doesn\'t appear to be a main LaTeX document as it doesn\'t contain \\begin{document}. TeXpresso should typically be started from the main document. Do you want to continue anyway?',
					{ modal: true },
					'Continue',
					'Cancel'
				);
				
				if (result !== 'Continue') {
					return; // Exit without starting TeXpresso
				}
			}
			if (!useChangeRangeMode) {
				rope = new Rope(text);
			}
			if (activeEditor.document.isUntitled) {
				const tmpDir = tmp.dirSync();
				filePath = tmpDir.name + '/untitled.tex';
				fs.writeFileSync(filePath, text);
				// on macOS, the temp file goes into a symlinked directory, so we need to resolve the path
				filePath = fs.realpathSync(filePath);
			}

			vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor', true);
			vscode.commands.executeCommand('setContext', 'texpresso.running', true);
			// Start texpresso
			const command = vscode.workspace.getConfiguration('texpresso').get('command') as string;
			// Check if command exists
			try {
				if (!useWSL) {
					fs.accessSync(command, fs.constants.X_OK);
				} else {
					execSync(`wsl -e test -x ${command}`);
				}
			} catch (error) {
				let message = `TeXpresso command '${command}' does not exist or is not executable. Please check the 'texpresso.command' setting.`;
				if (process.platform === 'win32') {
					message = `TeXpresso command '${command}' does not exist or is not executable. Please check the 'texpresso.command' and 'texpresso.wsl' settings.`;
					if (useWSL) {
						message = `TeXpresso command '${command}' is not executable, or the 'wsl' command is not available. Please check the 'texpresso.command' and 'texpresso.wsl' settings.`;
					}
				}
				vscode.window.showErrorMessage(
					message,
					'Open Settings'
				).then(value => {
					if (value === 'Open Settings') {
						vscode.commands.executeCommand('workbench.action.openSettings', 'texpresso.');
					}
				});
				return;
			}

			// react to messages from texpresso
			const args = ['-json'];
			if (useChangeRangeMode) {
				args.push('-lines');
			}
			// Extra lookup directories (-I): e.g. the build directory of a full
			// build, so its .bbl and .aux resolve citations and references.
			const includePaths = (vscode.workspace.getConfiguration('texpresso').get('includePaths') as string[]) || [];
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)?.uri.fsPath ?? documentDir;
			for (const includePath of includePaths) {
				const expanded = includePath.replace(/\$\{workspaceFolder\}/g, workspaceFolder);
				const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(documentDir, expanded);
				args.push('-I', useWSL ? new WSLPathConverter(true).toWSL(resolved) : resolved);
				watchIncludePath(resolved);
			}
			args.push(filePath);
			
			if (!useWSL) {
				texpresso = spawn(command, args);
			} else {
				const pathConverter = new WSLPathConverter(true);
				filePath = pathConverter.toWSL(filePath);
				const wslArgs = ['-e', command, ...args.slice(0, -1), filePath]; // replace original filePath with WSL path
				texpresso = spawn('wsl', wslArgs);
			}
			if (texpresso && texpresso.stdout) {
				outputChannel.append(`Starting TeXpresso with command: ${command} ${args.join(' ')}\n`);
				outputChannel.append(`Options: ${useChangeRangeMode ? 'Using change-range mode' : 'Using byte-based changes'}\n`);
				outputChannel.append(`File: ${filePath}\n`);

				// Converge cross-references: rerun when idle if the .aux changed.
				if (vscode.workspace.getConfiguration('texpresso').get('rerunOnIdle') as boolean) {
					sendCommand(['rerun', true]);
				}

				let buffer = '';
				texpresso.stdout.on('data', data => {
					buffer += data.toString();
					const lines = buffer.split('\n');
					// Keep the last incomplete line in the buffer
					buffer = lines.pop() || '';

					for (const line of lines) {
						if (!line.trim()) continue; // Skip empty lines
						try {
							const message = JSON.parse(line);
							if (message[0] === 'input-file') {
								const [, index, relativePath] = message;
								registry.addFile(index, relativePath, sendCommand);
								debugChannel.appendLine(`Tracked file ${index}: ${relativePath}`);
							}
							else if (message[0] === 'synctex') {
								const [, filePath, line, column] = message;
								const pathConverter = new WSLPathConverter(useWSL);
								let absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(documentDir, filePath);
								absolutePath = pathConverter.toWindows(absolutePath);
								
								vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath)).then(doc => {
									return vscode.window.showTextDocument(doc).then(editor => {
										const pos = new vscode.Position(line - 1, Math.max(0, (column || 1) - 1));
										editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
										editor.selection = new vscode.Selection(pos, pos);
									});
								}, () => {
									if (activeEditor && filePath === activeEditor.document.fileName) {
										const pos = new vscode.Position(line - 1, 0);
										activeEditor.revealRange(new vscode.Range(pos, pos));
									}
								});
							}
							else if (message[0] === 'append-lines') {
								const channel = message[1];
								const lines = message.slice(2); // All remaining elements are lines
								const newContent = lines.join('\n') + '\n';
								
								if (channel === 'out') {
									providedOutput += newContent;
									outputChanged = true;
								} else if (channel === 'log') {
									debugChannel.append(newContent);
								}
							}
							else if (message[0] === 'truncate-lines') {
								const channel = message[1];
								const linesToKeep = message[2];
								
								if (channel === 'out') {
									const lines = providedOutput.split('\n');
									providedOutput = lines.slice(-linesToKeep).join('\n') + (linesToKeep > 0 ? '\n' : '');
									outputChanged = true;
								} else if (channel === 'log') {
									// For debug channel, we'll just clear it on truncate-lines
									// since VS Code doesn't have easy line-based truncation
									debugChannel.clear();
								}
							}
							// Legacy support for old byte-based commands
							else if (message[0] === 'append') {
								const channel = message[1];
								const content = message[3];
								
								if (channel === 'out') {
									providedOutput += content;
									outputChanged = true;
								} else if (channel === 'log') {
									debugChannel.append(content);
								}
							}
							else if (message[0] === 'truncate') {
								const channel = message[1];
								const bytesToKeep = message[2];
								
								if (channel === 'out') {
									providedOutput = providedOutput.slice(-bytesToKeep);
									outputChanged = true;
								} else if (channel === 'log') {
									// For debug channel, we'll just clear it on truncate
									// since VS Code doesn't have easy byte-based truncation
									debugChannel.clear();
								}
							}
							else if (message[0] === 'flush') {
								if (outputChanged) {
									outputChanged = false;
									outputChannel.replace(providedOutput);
								}
							}
							else {
								debugChannel.append(`Received unhandled message: ${JSON.stringify(message)}`);
							}
						} catch (error) {
							debugChannel.appendLine(`Error parsing JSON from line: ${line}`);
							debugChannel.appendLine(`Error: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
				});
			}
			if (texpresso && texpresso.stderr) {
				texpresso.stderr.on('data', data => {
					debugChannel.append(data.toString());
				});
			}
			if (texpresso) {
				texpresso.on('close', code => {
					if (code !== 0) {
						vscode.window.showErrorMessage(`TeXpresso exited with code ${code}`);
					}
					activeEditor = undefined;
					vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor', false);
					vscode.commands.executeCommand('setContext', 'texpresso.running', false);
					outputChannel.clear();
					debugChannel.clear();
				});
			}
			// Send file content to texpresso
			const message = ["open", filePath, activeEditor.document.getText()];
			sendCommand(message);
			// Send color theme to texpresso if setting is enabled
			if (vscode.workspace.getConfiguration('texpresso').get('useEditorTheme') as boolean) {
				adoptTheme();
			}
		}
	}

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.startDocument', async () => {
		await startDocumentFromEditor(vscode.window.activeTextEditor);
	}));

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(doc => {
			if (registry && isFileDocument(doc)) {
				registry.updateDocument(doc.uri.fsPath, doc, true, sendCommand);
			}
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument(doc => {
			if (registry && isFileDocument(doc)) {
				registry.updateDocument(doc.uri.fsPath, undefined, false, sendCommand);
			}
		})
	);

	vscode.workspace.onDidChangeTextDocument(event => {
		const trackedFile = isFileDocument(event.document) ? registry?.findByPath(event.document.uri.fsPath) : undefined;
		
		if (activeEditor && event.document === activeEditor.document) {
			texpresso?.stdin?.cork();
			for (const change of event.contentChanges) {
				if (useChangeRangeMode) {
					const startLine = change.range.start.line;
					const startChar = change.range.start.character;
					const endLine = change.range.end.line;
					const endChar = change.range.end.character;
					const message = ["change-range", filePath, startLine, startChar, endLine, endChar, change.text];
					sendCommand(message);
				} else {
					const start = rope.byteOffset(change.rangeOffset);
					const end = rope.byteOffset(change.rangeOffset + change.rangeLength);
					const message = ["change", filePath, start, end - start, change.text];
					sendCommand(message);
					rope.remove(change.rangeOffset, change.rangeOffset + change.rangeLength);
					rope.insert(change.rangeOffset, change.text);
				}
			}
			texpresso?.stdin?.uncork();
		}
		else if (trackedFile && trackedFile.isOpen) {
			texpresso?.stdin?.cork();
			for (const change of event.contentChanges) {
				if (useChangeRangeMode) {
					const startLine = change.range.start.line;
					const startChar = change.range.start.character;
					const endLine = change.range.end.line;
					const endChar = change.range.end.character;
					const message = ["change-range", trackedFile.absolutePath, startLine, startChar, endLine, endChar, change.text];
					sendCommand(message);
				} else {
					if (!trackedFile.rope) {
						trackedFile.rope = new Rope(event.document.getText());
					}
					const start = trackedFile.rope.byteOffset(change.rangeOffset);
					const end = trackedFile.rope.byteOffset(change.rangeOffset + change.rangeLength);
					const message = ["change", trackedFile.absolutePath, start, end - start, change.text];
					sendCommand(message);
					trackedFile.rope.remove(change.rangeOffset, change.rangeOffset + change.rangeLength);
					trackedFile.rope.insert(change.rangeOffset, change.text);
				}
			}
			texpresso?.stdin?.uncork();
		}
	}, null, context.subscriptions);

	vscode.window.onDidChangeActiveTextEditor(editor => {
		if (activeEditor && editor && editor.document === activeEditor.document) {
			vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor', true);
		} else {
			vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor', false);
		}
	});

	/***********************************
	 ***********************************
	 ****  SyncTeX and Page Choice  ****
	 ***********************************
	 **********************************/

	let previouslySentPosition: string | undefined;
	function doSyncTeXForward(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor) {
		if (!editor) return;
		
		const trackedFile = isFileDocument(editor.document) ? registry?.findByPath(editor.document.uri.fsPath) : undefined;
		// TeXpresso expects 1-based line numbers (as recorded by TeX); VS Code positions are 0-based.
		const active = editor.selection.active;
		const lineNumber = active.line + 1;
		// The column is the number of characters before the cursor. TeX counts
		// Unicode scalar values, VS Code counts UTF-16 code units, so convert.
		const lineText = editor.document.lineAt(active.line).text;
		const column = Array.from(lineText.slice(0, active.character)).length;
		
		if (editor.document === activeEditor?.document) {
			const position = `${lineNumber}:${column}`;
			if (previouslySentPosition !== position) {
				previouslySentPosition = position;
				const message = ["synctex-forward", filePath, lineNumber, column];
				sendCommand(message);
			}
		} else if (trackedFile) {
			const message = ["synctex-forward", trackedFile.absolutePath, lineNumber, column];
			sendCommand(message);
		}
	}

	vscode.window.onDidChangeTextEditorSelection(event => {
		if (vscode.workspace.getConfiguration('texpresso').get('syncTeXForwardOnSelection') as boolean) {
			const isMainDoc = activeEditor && event.textEditor.document === activeEditor.document;
			const isTrackedFile = isFileDocument(event.textEditor.document) && registry?.findByPath(event.textEditor.document.uri.fsPath);
			
			if (isMainDoc || isTrackedFile) {
				doSyncTeXForward(event.textEditor);
			}
		}
	});

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.syncTeXForward', () => {
		doSyncTeXForward();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.syncTeXForwardShortName', (event) => {
		doSyncTeXForward();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.activateSyncTeXForward', () => {
		vscode.workspace.getConfiguration('texpresso').update('syncTeXForwardOnSelection', true, true);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.deactivateSyncTeXForward', () => {
		vscode.workspace.getConfiguration('texpresso').update('syncTeXForwardOnSelection', false, true);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.nextPage', () => {
		if (activeEditor) {
			const message = ["next-page"];
			sendCommand(message);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.previousPage', () => {
		if (activeEditor) {
			const message = ["previous-page"];
			sendCommand(message);
		}
	}));

	/***********************************
	 ***********************************
	 ****    Theme Color Adaption   ****
	 ***********************************
	 **********************************/

	function adoptTheme() {
		if (!texpresso || !activeEditor) {
			return;
		}
		// to get explicit colors of the theme (which are not available in the API), we need to open a webview
		// see https://github.com/microsoft/vscode/issues/32813#issuecomment-798680103
		const webviewPanel = vscode.window.createWebviewPanel(
			'texpresso.colorTheme',
			'Color Theme',
			{ preserveFocus: true, viewColumn: vscode.ViewColumn.Beside },
			{
				enableScripts: true,
			}
		);
		const webview = webviewPanel.webview;
		webview.html = `<!DOCTYPE html><html><script>
			const vscode = acquireVsCodeApi();
			vscode.postMessage(Object.values(document.getElementsByTagName('html')[0].style).map(
			(rv) => {
				return {
				[rv]: document
					.getElementsByTagName('html')[0]
					.style.getPropertyValue(rv),
				}
			}
			));
		</script></html>`;
		webview.onDidReceiveMessage((cssVars) => {
			webviewPanel.dispose();
			const colors = {} as { [key: string]: number[] };
			for (const cssVar of cssVars) {
				const key = Object.keys(cssVar)[0];
				const value = cssVar[key];
				if (key === '--vscode-editor-background' || key === '--vscode-editor-foreground') {
					// value is for example "#cccccc"
					// convert it to rgb as three floats between 0 and 1
					const rgb = value.match(/#(..)(..)(..)/);
					if (rgb) {
						colors[key] = [
							parseInt(rgb[1], 16) / 255,
							parseInt(rgb[2], 16) / 255,
							parseInt(rgb[3], 16) / 255,
						];
					}
				}
			}
			const message = ["theme", colors['--vscode-editor-background'], colors['--vscode-editor-foreground']];
			sendCommand(message);
		});
	}

	vscode.window.onDidChangeActiveColorTheme(() => {
		if (vscode.workspace.getConfiguration('texpresso').get('useEditorTheme') as boolean) {
			adoptTheme();
		}
	});

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.adoptTheme', () => {
		adoptTheme();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.defaultTheme', () => {
		const message = ["theme", [1, 1, 1], [0, 0, 0]];
		sendCommand(message);
	}));

	/***********************************
	 ***********************************
	 *****     Refresh and Stop    *****
	 ***********************************
	 **********************************/

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.refresh', () => {
		if (activeEditor) {
			const text = activeEditor.document.getText();
			if (!useChangeRangeMode) {
				rope = new Rope(text);
			}
			// resend "open" command
			const message = ["open", filePath, text];
			sendCommand(message);
			sendCommand(["rescan"]);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.externalCompileAndRefresh', async () => {
		if (!activeEditor) {
			vscode.window.showErrorMessage('TeXpresso: No active editor');
			return;
		}

		// Save the document first if it has unsaved changes
		if (activeEditor.document.isDirty) {
			await activeEditor.document.save();
		}

		// Get the configured compile command
		const externalCommand = vscode.workspace.getConfiguration('texpresso').get('externalCompileCommand') as string;

		// Show a status bar message
		const statusBar = vscode.window.setStatusBarMessage(`TeXpresso: Running ${externalCommand}...`);

		try {
			// Execute the command
			const { exec } = require('child_process');
			const path = require('path');
			const pathConverter = new WSLPathConverter(useWSL);
			const workDir = path.dirname(filePath);

			outputChannel.appendLine(`\n--- External Compilation ---`);
			outputChannel.appendLine(`Working directory: ${workDir}`);

			// Prepare the command
			let cmd: string;
			let opts: any = {};

			if (!useWSL) {
				cmd = `${externalCommand} "${filePath}"`;
				opts.cwd = workDir;
				outputChannel.appendLine(`Command: ${cmd}`);
			} else {
				const wslWorkDir = pathConverter.toWSL(workDir);
				const wslFilePath = pathConverter.toWSL(filePath);
				cmd = `cd "${wslWorkDir}" && ${externalCommand} "${wslFilePath}"`;
				outputChannel.appendLine(`WSL Command: ${cmd}`);
				cmd = `wsl -e sh -c "${cmd.replace(/"/g, '\\"')}"`;
			}

			outputChannel.show(true);

			// Execute the command
			const childProcess = exec(cmd, opts);

			await new Promise<void>((resolve, reject) => {
				childProcess.stdout.on('data', (data: Buffer) => {
					outputChannel.append(data.toString());
				});

				childProcess.stderr.on('data', (data: Buffer) => {
					outputChannel.append(data.toString());
				});

				childProcess.on('close', (code: number) => {
					if (code === 0) {
						resolve();
					} else {
						const errorMsg = `Exit code ${code}`;
						outputChannel.appendLine(`\nExternal compilation failed: ${errorMsg}`);
						reject(new Error(errorMsg));
					}
				});

				childProcess.on('error', (error: Error) => {
					outputChannel.appendLine(`\nError: ${error.message}`);
					reject(error);
				});
			});

			// Refresh TeXpresso's internal state
			vscode.commands.executeCommand('texpresso.refresh');
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			outputChannel.appendLine(`\nError: ${errorMessage}`);
			vscode.window.showErrorMessage(`TeXpresso: External compilation failed: ${errorMessage}`);
		} finally {
			statusBar.dispose();
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('texpresso.stop', () => {
		if (texpresso) {
			texpresso.kill();
		}
		disposeIncludeWatchers();
		activeEditor = undefined;
		registry?.clear();
		vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor', false);
		vscode.commands.executeCommand('setContext', 'texpresso.running', false);
		outputChannel.clear();
		debugChannel.clear();
	}));
}

// This method is called when your extension is deactivated
export function deactivate() {
	if (texpresso) {
		texpresso.kill();
	}
}
