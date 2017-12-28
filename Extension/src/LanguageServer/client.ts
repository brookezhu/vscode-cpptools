/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import {
    LanguageClient, LanguageClientOptions, ServerOptions, NotificationType, TextDocumentIdentifier,
    RequestType, ErrorHandler, ErrorAction, CloseAction, DidOpenTextDocumentParams
} from 'vscode-languageclient';
import * as util from '../common';
import * as configs from './configurations';
import { CppSettings, OtherSettings } from './settings';
import * as telemetry from '../telemetry';
import { PersistentState } from './persistentState';
import { UI, getUI } from './ui';
import { ClientCollection } from './clientCollection';
import { createProtocolFilter } from './protocolFilter';
import { DataBinding } from './dataBinding';

let ui: UI;

interface NavigationPayload {
    navigation: string;
}

interface TelemetryPayload {
    event: string;
    properties?: { [key: string]: string },
    metrics?: { [key: string]: number }
}

interface OutputNotificationBody {
    category: string;
    output: string;
}

interface ReportStatusNotificationBody {
    status: string;
}

interface QueryDefaultPathsParams {
}

interface FolderSettingsParams {
    currentConfiguration: number;
    configurations: any[];
}

interface FolderSelectedSettingParams {
    currentConfiguration: number;
}

interface SwitchHeaderSourceParams {
    rootPath: string;
    switchHeaderSourceFileName: string;
}

interface FileChangedParams {
    uri: string;
}

interface OutputNotificationBody {
    category: string;
    output: string;
}

// Requests
const NavigationListRequest = new RequestType<TextDocumentIdentifier, string, void, void>('cpptools/requestNavigationList');
const GoToDeclarationRequest = new RequestType<void, void, void, void>('cpptools/goToDeclaration');
const QueryDefaultPathsRequest = new RequestType<QueryDefaultPathsParams, configs.DefaultPaths, void, void>('cpptools/queryDefaultPaths');
const SwitchHeaderSourceRequest = new RequestType<SwitchHeaderSourceParams, string, void, void>('cpptools/didSwitchHeaderSource');

// Notifications to the server
const DidOpenNotification = new NotificationType<DidOpenTextDocumentParams, void>('textDocument/didOpen');
const FileCreatedNotification = new NotificationType<FileChangedParams, void>('cpptools/fileCreated');
const FileDeletedNotification = new NotificationType<FileChangedParams, void>('cpptools/fileDeleted');
const ResetDatabaseNotification = new NotificationType<void, void>('cpptools/resetDatabase');
const PauseParsingNotification = new NotificationType<void, void>('cpptools/pauseParsing');
const ResumeParsingNotification = new NotificationType<void, void>('cpptools/resumeParsing');
const ActiveDocumentChangeNotification = new NotificationType<TextDocumentIdentifier, void>('cpptools/activeDocumentChange');
const TextEditorSelectionChangeNotification = new NotificationType<vscode.Position, void>('cpptools/textEditorSelectionChange');
const ChangeFolderSettingsNotification = new NotificationType<FolderSettingsParams, void>('cpptools/didChangeFolderSettings');
const ChangeCompileCommandsNotification = new NotificationType<FileChangedParams, void>('cpptools/didChangeCompileCommands');
const ChangeSelectedSettingNotification = new NotificationType<FolderSelectedSettingParams, void>('cpptools/didChangeSelectedSetting');
const IntervalTimerNotification = new NotificationType<void, void>('cpptools/onIntervalTimer');

// Notifications from the server
const ReloadWindowNotification = new NotificationType<void, void>('cpptools/reloadWindow');
const LogTelemetryNotification = new NotificationType<TelemetryPayload, void>('cpptools/logTelemetry');
const ReportNavigationNotification = new NotificationType<NavigationPayload, void>('cpptools/reportNavigation');
const ReportTagParseStatusNotification = new NotificationType<ReportStatusNotificationBody, void>('cpptools/reportTagParseStatus');
const ReportStatusNotification = new NotificationType<ReportStatusNotificationBody, void>('cpptools/reportStatus');
const DebugProtocolNotification = new NotificationType<OutputNotificationBody, void>('cpptools/debugProtocol');
const DebugLogNotification = new NotificationType<OutputNotificationBody, void>('cpptools/debugLog');

const maxSettingLengthForTelemetry: number = 50;
let previousCppSettings: { [key: string]: any } = {};

/**
 * track settings changes for telemetry
 */
function collectSettings(filter: (key: string, val: string, settings: vscode.WorkspaceConfiguration) => boolean, resource: vscode.Uri): { [key: string]: string } {
    let settings = vscode.workspace.getConfiguration("C_Cpp", resource);
    let result: { [key: string]: string } = {};

    for (var key in settings) {
        if (settings.inspect(key).defaultValue === undefined)
            continue; // ignore methods and settings that don't exist
        let val = settings.get(key);
        if (val instanceof Object)
            continue; // ignore settings that are objects since tostring on those is not useful (e.g. navigation.length)
        if (filter(key, val, settings)) {
            previousCppSettings[key] = val;
            result[key] = (key == "clang_format_path") ? "..." : String(previousCppSettings[key]);
            if (result[key].length > maxSettingLengthForTelemetry)
                result[key] = result[key].substr(0, maxSettingLengthForTelemetry) + "...";
        }
    }

    return result;
}

function initializeSettingsCache(resource: vscode.Uri) {
    collectSettings(() => true, resource);
}

function getNonDefaultSettings(resource: vscode.Uri): { [key: string]: string } {
    let filter = (key: string, val: string, settings: vscode.WorkspaceConfiguration) => {
        return val !== settings.inspect(key).defaultValue;
    };
    initializeSettingsCache(resource);
    return collectSettings(filter, resource);
}

interface ClientModel {
    isTagParsing: DataBinding<boolean>,
    isUpdatingIntelliSense: DataBinding<boolean>,
    navigationLocation: DataBinding<string>,
    tagParserStatus: DataBinding<string>,
    activeConfigName: DataBinding<string>
}

export interface Client {
    TagParsingChanged: vscode.Event<boolean>,
    IntelliSenseParsingChanged: vscode.Event<boolean>,
    NavigationLocationChanged: vscode.Event<string>,
    TagParserStatusChanged: vscode.Event<string>,
    ActiveConfigChanged: vscode.Event<string>,
    RootPath: string,
    RootUri: vscode.Uri,
    Name: string,
    TrackedDocuments: Set<vscode.TextDocument>,
    onDidChangeSettings(): void,
    takeOwnership(document: vscode.TextDocument): void,
    requestGoToDeclaration(): Thenable<void>,
    requestSwitchHeaderSource(rootPath: string, fileName: string): Thenable<string>,
    requestNavigationList(document: vscode.TextDocument): Thenable<string>,
    activeDocumentChanged(document: vscode.TextDocument): void,
    activate(): void,
    selectionChanged(selection: vscode.Position): void,
    resetDatabase(): void,
    deactivate(): void,
    pauseParsing(): void,
    resumeParsing(): void,
    handleConfigurationSelectCommand(): void,
    handleShowParsingCommands(): void,
    handleConfigurationEditCommand(): void,
    handleAddToIncludePathCommand(path: string): void,
    onInterval(): void,
    dispose(): Thenable<void>
}

export function createClient(allClients: ClientCollection, workspaceFolder?: vscode.WorkspaceFolder): Client {
    return new DefaultClient(allClients, workspaceFolder);
}

export function createNullClient(): Client {
    return new NullClient();
}

class DefaultClient implements Client {
    private languageClient: LanguageClient; // The "client" that launches and communicates with our language "server" process.
    private disposables: vscode.Disposable[] = [];
    private configuration: configs.CppProperties;
    private rootPathFileWatcher: vscode.FileSystemWatcher;
    private workspaceRoot: vscode.WorkspaceFolder | undefined;
    private trackedDocuments = new Set<vscode.TextDocument>();
    private outputChannel: vscode.OutputChannel;
    private debugChannel: vscode.OutputChannel;
    private crashTimes: number[] = [];
    private failureMessageShown = new PersistentState<boolean>("DefaultClient.failureMessageShown", false);
    private isSupported: boolean = true;

    // The "model" that is displayed via the UI (status bar).
    private model: ClientModel = {
        isTagParsing: new DataBinding<boolean>(false),
        isUpdatingIntelliSense: new DataBinding<boolean>(false),
        navigationLocation: new DataBinding<string>(""),
        tagParserStatus: new DataBinding<string>(""),
        activeConfigName: new DataBinding<string>("")
    }

    public get TagParsingChanged(): vscode.Event<boolean> { return this.model.isTagParsing.ValueChanged; };
    public get IntelliSenseParsingChanged(): vscode.Event<boolean> { return this.model.isUpdatingIntelliSense.ValueChanged; };
    public get NavigationLocationChanged(): vscode.Event<string> { return this.model.navigationLocation.ValueChanged; }
    public get TagParserStatusChanged(): vscode.Event<string> { return this.model.tagParserStatus.ValueChanged; }
    public get ActiveConfigChanged(): vscode.Event<string> { return this.model.activeConfigName.ValueChanged; }

    /**
     * don't use this.workspaceRoot directly since it can be undefined
     */
    public get RootPath(): string {
        return (this.workspaceRoot) ? this.workspaceRoot.uri.fsPath : "";
    }
    public get RootUri(): vscode.Uri {
        return (this.workspaceRoot) ? this.workspaceRoot.uri : null;
    }
    public get Name(): string {
        return this.getName(this.workspaceRoot);
    }
    public get TrackedDocuments(): Set<vscode.TextDocument> {
        return this.trackedDocuments;
    }

    private getName(workspaceFolder?: vscode.WorkspaceFolder): string {
        return workspaceFolder ? workspaceFolder.name : "untitled";
    }

    /**
     * All public methods on this class must be guarded by the "onReady" promise. Requests and notifications received before the client is
     * ready are executed after this promise is resolved.
     * @see requestWhenReady<T>(request)
     * @see notifyWhenReady(notify)
     */
    private onReadyPromise: Thenable<void>;

    constructor(allClients: ClientCollection, workspaceFolder?: vscode.WorkspaceFolder) {
        try {
            let languageClient = this.createLanguageClient(allClients, workspaceFolder);
            languageClient.registerProposedFeatures();
            languageClient.start();  // This returns Disposable, but doesn't need to be tracked because we call .stop() explicitly in our dispose()
            util.setProgress(util.getProgressExecutableStarted());
            this.workspaceRoot = workspaceFolder;
            ui = getUI();
            ui.bind(this);

            this.onReadyPromise = languageClient.onReady().then(() => {
                this.configuration = new configs.CppProperties(this.RootPath);
                this.configuration.ConfigurationsChanged((e) => this.onConfigurationsChanged(e));
                this.configuration.SelectionChanged((e) => this.onSelectedConfigurationChanged(e));
                this.configuration.CompileCommandsChanged((e) => this.onCompileCommandsChanged(e));
                this.disposables.push(this.configuration);

                // The configurations will not be sent to the language server until the default include paths and frameworks have been set.
                // The event handlers must be set before this happens.
                languageClient.sendRequest(QueryDefaultPathsRequest, {}).then((paths: configs.DefaultPaths) => {
                    this.configuration.DefaultPaths = paths;
                });

                // Once this is set, we don't defer any more callbacks.
                this.languageClient = languageClient;
                telemetry.logLanguageServerEvent("NonDefaultInitialCppSettings", getNonDefaultSettings(this.RootUri));
                this.failureMessageShown.Value = false;

                // Listen for messages from the language server.
                this.registerNotifications();
                this.registerFileWatcher();
            }, () => {
                this.isSupported = false;   // Running on an OS we don't support yet.
                if (!this.failureMessageShown.Value) {
                    this.failureMessageShown.Value = true;
                    vscode.window.showErrorMessage("Unable to start the C/C++ language server. IntelliSense features will be disabled.");
                }
            });
        } catch {
            this.isSupported = false;   // Running on an OS we don't support yet.
            if (!this.failureMessageShown.Value) {
                this.failureMessageShown.Value = true;
                vscode.window.showErrorMessage("Unable to start the C/C++ language server. IntelliSense features will be disabled.");
            }
        }
    }

    private createLanguageClient(allClients: ClientCollection, workspaceFolder?: vscode.WorkspaceFolder): LanguageClient {
        let serverModule = getLanguageServerFileName();
        let serverName = this.getName(workspaceFolder);

        let serverOptions: ServerOptions = {
            run: { command: serverModule },
            debug: { command: serverModule, args: [ serverName ] }
        }
        let settings = new CppSettings(workspaceFolder ? workspaceFolder.uri : null);
        let other = new OtherSettings(workspaceFolder ? workspaceFolder.uri : null);

        let storagePath = util.extensionContext.storagePath;
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1) {
            storagePath = path.join(storagePath, serverName);
        }

        let clientOptions: LanguageClientOptions = {
            documentSelector: [
                { scheme: 'file', language: 'cpp' },
                { scheme: 'file', language: 'c' }
            ],
            synchronize: {
                // Synchronize the setting section to the server
                configurationSection: ['C_Cpp', 'files', 'search']
            },
            workspaceFolder: workspaceFolder,
            initializationOptions: {
                clang_format_path: settings.clangFormatPath,
                clang_format_style: settings.clangFormatStyle,
                clang_format_fallbackStyle: settings.clangFormatFallbackStyle,
                clang_format_sortIncludes: settings.clangFormatSortIncludes,
                formatting: settings.formatting,
                extension_path: util.extensionContext.extensionPath,
                exclude_files: other.filesExclude,
                exclude_search: other.searchExclude,
                storage_path: storagePath,
                tab_size: other.editorTabSize,
                intelliSenseEngine: settings.intelliSenseEngine,
                intelliSenseEngineFallback: settings.intelliSenseEngineFallback,
                autocomplete: settings.autoComplete,
                errorSquiggles: settings.errorSquiggles,
                loggingLevel: settings.loggingLevel
            },
            middleware: createProtocolFilter(this, allClients),  // Only send messages directed at this client.
            errorHandler: {
                error: () => ErrorAction.Continue,
                closed: () => {
                        this.crashTimes.push(Date.now());
                        if (this.crashTimes.length < 5) {
                            let newClient: DefaultClient = <DefaultClient>allClients.replace(this, true);
                            newClient.crashTimes = this.crashTimes;
                        } else {
                            let elapsed = this.crashTimes[this.crashTimes.length-1] - this.crashTimes[0];
                            if (elapsed <= 3 * 60 * 1000) {
                                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1) {
                                    vscode.window.showErrorMessage(`The language server for '${serverName}' crashed 5 times in the last 3 minutes. It will not be restarted.`);
                                } else {
                                    vscode.window.showErrorMessage(`The language server crashed 5 times in the last 3 minutes. It will not be restarted.`);
                                }
                                allClients.replace(this, false);
                            } else {
                                this.crashTimes.shift();
                                let newClient: DefaultClient = <DefaultClient>allClients.replace(this, true);
                                newClient.crashTimes = this.crashTimes;
                            }
                        }
                        return CloseAction.DoNotRestart;
                    }
            }

            // TODO: should I set the output channel?  Does this sort output between servers?
        }

        // Create the language client
        return new LanguageClient(`cpptools: ${serverName}`, serverOptions, clientOptions);
    }

    public onDidChangeSettings() {
        // This relies on getNonDefaultSettings being called first.
        console.assert(Object.keys(previousCppSettings).length > 0);

        let filter = (key: string, val: string) => {
            return !(key in previousCppSettings) || val !== previousCppSettings[key];
        };
        let changedSettings = collectSettings(filter, this.RootUri);

        if (Object.keys(changedSettings).length > 0)
            telemetry.logLanguageServerEvent("CppSettingsChange", changedSettings, null);
    }

    /**
     * Take ownership of a document that was previously serviced by another client.
     * This process involves sending a textDocument/didOpen message to the server so
     * that it knows about the file, as well as adding it to this client's set of
     * tracked documents.
     */
    public takeOwnership(document: vscode.TextDocument): void {
        let params: DidOpenTextDocumentParams = {
            textDocument: {
                uri: document.uri.toString(),
                languageId: document.languageId,
                version: document.version,
                text: document.getText()
            }
        };
        this.notifyWhenReady(() => this.languageClient.sendNotification(DidOpenNotification, params));
        this.trackedDocuments.add(document);
    }

    /*************************************************************************************
     * wait until the language client is ready for use before attempting to send messages
     *************************************************************************************/

    private requestWhenReady<T>(request: () => Thenable<T>): Thenable<T> {
        if (this.languageClient) {
            return request();
        } else if (this.isSupported && this.onReadyPromise) {
            return this.onReadyPromise.then(() => request());
        } else {
            return Promise.reject<T>("Unsupported client");
        }
    }

    private notifyWhenReady(notify: () => void): void {
        if (this.languageClient) {
            notify();
        } else if (this.isSupported && this.onReadyPromise) {
            this.onReadyPromise.then(() => notify());
        }
    }

    /**
     * listen for notifications from the language server.
     */
    private registerNotifications(): void {
        console.assert(this.languageClient !== undefined, "This method must not be called until this.languageClient is set in \"onReady\"");

        this.languageClient.onNotification(ReloadWindowNotification, () => this.reloadWindow());
        this.languageClient.onNotification(LogTelemetryNotification, (e) => this.logTelemetry(e));
        this.languageClient.onNotification(ReportNavigationNotification, (e) => this.navigate(e));
        this.languageClient.onNotification(ReportStatusNotification, (e) => this.updateStatus(e));
        this.languageClient.onNotification(ReportTagParseStatusNotification, (e) => this.updateTagParseStatus(e));
        this.setupOutputHandlers();
    }

    /**
     * listen for file created/deleted events under the ${workspaceRoot} folder
     */
    private registerFileWatcher(): void {
        console.assert(this.languageClient !== undefined, "This method must not be called until this.languageClient is set in \"onReady\"");

        if (this.workspaceRoot) {
            // WARNING: The default limit on Linux is 8k, so for big directories, this can cause file watching to fail.
            this.rootPathFileWatcher = vscode.workspace.createFileSystemWatcher(
                path.join(this.RootPath, "*"),
                false /*ignoreCreateEvents*/,
                true /*ignoreChangeEvents*/,
                false /*ignoreDeleteEvents*/);

            this.rootPathFileWatcher.onDidCreate((uri) => {
                this.languageClient.sendNotification(FileCreatedNotification, { uri: uri.toString() });
            });

            this.rootPathFileWatcher.onDidDelete((uri) => {
                this.languageClient.sendNotification(FileDeletedNotification, { uri: uri.toString() });
            });

            this.disposables.push(this.rootPathFileWatcher);
        } else {
            this.rootPathFileWatcher = undefined;
        }
    }

    /**
     * listen for logging messages from the language server and print them to the Output window
     */
    private setupOutputHandlers(): void {
        console.assert(this.languageClient !== undefined, "This method must not be called until this.languageClient is set in \"onReady\"");

        this.languageClient.onNotification(DebugProtocolNotification, (output) => {
            var outputEditorExist = vscode.window.visibleTextEditors.some((editor: vscode.TextEditor) => {
                return editor.document.uri.scheme === "output";
            });
            if (!this.debugChannel) {
                this.debugChannel = vscode.window.createOutputChannel(`C/C++ Debug Protocol: ${this.Name}`);
                this.disposables.push(this.debugChannel);
            }
            if (!outputEditorExist) {
                this.debugChannel.show();
            }
            this.debugChannel.appendLine("");
            this.debugChannel.appendLine("************************************************************************************************************************")
            this.debugChannel.append(`${output}`);
        });


        this.languageClient.onNotification(DebugLogNotification, (output) => {
            if (!this.outputChannel) {
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1) {
                    this.outputChannel = vscode.window.createOutputChannel(`C/C++: ${this.Name}`);
                } else {
                    this.outputChannel = util.getOutputChannel();
                }
                this.disposables.push(this.outputChannel);
            }
            this.outputChannel.appendLine(`${output}`);
        });
    }

    /*******************************************************
     * handle notifications coming from the language server
     *******************************************************/

    private reloadWindow(): void {
        let reload = "Reload";
        vscode.window.showInformationMessage("Reload the workspace for the settings change to take effect.", reload).then((value: string) => {
            if (value === reload) {
                vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
        });
    }

    private logTelemetry(notificationBody: TelemetryPayload): void {
        telemetry.logLanguageServerEvent(notificationBody.event, notificationBody.properties, notificationBody.metrics);
    }

    private navigate(payload: NavigationPayload): void {
        // TODO: Move this code to a different place?
        if (payload.navigation.startsWith("<def")) {
            this.addFileAssociations(payload.navigation.substr(4));
            return;
        }
        let currentNavigation = payload.navigation;

        // If it's too big, it doesn't appear.
        // The space available depends on the user's resolution and space taken up by other UI.
        let maxLength = new CppSettings(this.RootUri).navigationLength;
        if (currentNavigation.length > maxLength)
            currentNavigation = currentNavigation.substring(0, maxLength - 3).concat("...");
        this.model.navigationLocation.Value = currentNavigation;
    }

    private addFileAssociations(fileAssociations: string) {
        let settings = new OtherSettings(this.RootUri);
        let assoc = settings.filesAssociations;
        let is_c = fileAssociations.startsWith("c");

        // Skip over rest of header: c>; or >;
        fileAssociations = fileAssociations.substr(is_c ? 3 : 2);
        let files = fileAssociations.split(";");
        let foundNewAssociation = false;
        for (let i = 0; i < files.length - 1; ++i) {
            let file = files[i];
            if (!(file in assoc) && !(("**/" + file) in assoc)) {
                let j = file.lastIndexOf('.');
                if (j != -1) {
                    let ext = file.substr(j);
                    if ((("*" + ext) in assoc) || (("**/*" + ext) in assoc)) // Don't override associations if set for all extensions.
                        continue;
                }
                assoc[file] = is_c ? "c" : "cpp";
                foundNewAssociation = true;
            }
        }
        if (foundNewAssociation)
            settings.filesAssociations = assoc;
    }

    private updateStatus(notificationBody: ReportStatusNotificationBody) {
        let message = notificationBody.status;
        util.setProgress(util.getProgressExecutableSuccess());
        if (message.endsWith("Indexing...")) {
            this.model.isTagParsing.Value = true;
        } else if (message.endsWith("Updating IntelliSense...")) {
            this.model.isUpdatingIntelliSense.Value = true;
        } else if (message.endsWith("IntelliSense Ready")) {
            this.model.isUpdatingIntelliSense.Value = false;
        } else if (message.endsWith("Ready")) { // Tag Parser Ready
            this.model.isTagParsing.Value = false;
            util.setProgress(util.getProgressParseRootSuccess());
        } else if (message.endsWith("No Squiggles")) {
            util.setIntelliSenseProgress(util.getProgressIntelliSenseNoSquiggles());
        } else if (message.endsWith("IntelliSense Fallback")) {
            let showIntelliSenseFallbackMessage = new PersistentState<boolean>("CPP.showIntelliSenseFallbackMessage", true);
            if (showIntelliSenseFallbackMessage.Value) {
                let learnMorePanel = "Learn More";
                let dontShowAgain = "Don't Show Again";
                vscode.window.showInformationMessage("Configure includePath for better IntelliSense results.", learnMorePanel, dontShowAgain).then((value) => {
                    switch (value) {
                        case learnMorePanel:
                            let uri: vscode.Uri = vscode.Uri.parse(`https://go.microsoft.com/fwlink/?linkid=864631`);
                            vscode.commands.executeCommand('vscode.open', uri);
                            vscode.commands.getCommands(true).then((commands: string[]) => {
                                if (commands.indexOf("workbench.action.problems.focus") >= 0)
                                    vscode.commands.executeCommand("workbench.action.problems.focus");
                            });
                            break;
                        case dontShowAgain:
                            showIntelliSenseFallbackMessage.Value = false;
                            break;
                    }
                });
            }
        }
    }

    private updateTagParseStatus(notificationBody: ReportStatusNotificationBody) {
        this.model.tagParserStatus.Value = notificationBody.status;
    }

    /*********************************************
     * requests to the language server
     *********************************************/

    public requestGoToDeclaration(): Thenable<void> {
        return this.requestWhenReady(() => this.languageClient.sendRequest(GoToDeclarationRequest, null));
    }

    public requestSwitchHeaderSource(rootPath: string, fileName: string): Thenable<string> {
        let params: SwitchHeaderSourceParams = {
            rootPath: rootPath,
            switchHeaderSourceFileName: fileName
        };
        return this.requestWhenReady(() => this.languageClient.sendRequest(SwitchHeaderSourceRequest, params));
    }

    public requestNavigationList(document: vscode.TextDocument): Thenable<string> {
        return this.requestWhenReady(() => {
            return this.languageClient.sendRequest(NavigationListRequest, this.languageClient.code2ProtocolConverter.asTextDocumentIdentifier(document));
        });
    }

    /*********************************************
     * notifications to the language server
     *********************************************/

    public activeDocumentChanged(document: vscode.TextDocument) {
        this.notifyWhenReady(() => {
            this.languageClient.sendNotification(ActiveDocumentChangeNotification, this.languageClient.code2ProtocolConverter.asTextDocumentIdentifier(document));
        });
    }

    /**
     * enable UI updates from this client and resume tag parsing on the server.
     */
    public activate() {
        for (var key in this.model) {
            if (this.model.hasOwnProperty(key)) {
                this.model[key].activate();
            }
        }
        this.resumeParsing();
    }

    public selectionChanged(selection: vscode.Position) {
        this.notifyWhenReady(() => this.languageClient.sendNotification(TextEditorSelectionChangeNotification, selection));
    }

    public resetDatabase(): void {
        this.notifyWhenReady(() => this.languageClient.sendNotification(ResetDatabaseNotification));
    }

    /**
     * disable UI updates from this client and pause tag parsing on the server.
     */
    public deactivate(): void {
        for (var key in this.model) {
            if (this.model.hasOwnProperty(key)) {
                this.model[key].deactivate();
            }
        }
        this.pauseParsing();
    }

    public pauseParsing(): void {
        this.notifyWhenReady(() => this.languageClient.sendNotification(PauseParsingNotification));
    }

    public resumeParsing(): void {
        this.notifyWhenReady(() => this.languageClient.sendNotification(ResumeParsingNotification));
    }

    private onConfigurationsChanged(configurations: configs.Configuration[]) {
        let params: FolderSettingsParams = {
            configurations: configurations,
            currentConfiguration: this.configuration.CurrentConfiguration
        };
        this.notifyWhenReady(() => {
            this.languageClient.sendNotification(ChangeFolderSettingsNotification, params);
            this.model.activeConfigName.Value = configurations[params.currentConfiguration].name;
        });
    }

    private onSelectedConfigurationChanged(index: number) {
        let params: FolderSelectedSettingParams = {
            currentConfiguration: index
        };
        this.notifyWhenReady(() => {
            this.languageClient.sendNotification(ChangeSelectedSettingNotification, params);
            this.model.activeConfigName.Value = this.configuration.ConfigurationNames[index];
        });
    }

    private onCompileCommandsChanged(path: string) {
        let params: FileChangedParams = {
            uri: path
        };
        this.notifyWhenReady(() => this.languageClient.sendNotification(ChangeCompileCommandsNotification, params));
    }

    /*********************************************
     * command handlers
     *********************************************/
    public handleConfigurationSelectCommand() {
        this.notifyWhenReady(() => {
            ui.showConfigurations(this.configuration.ConfigurationNames)
                .then((index: number) => {
                    if (index < 0) {
                        return;
                    }
                    this.configuration.select(index);
                });
        });
    }

    public handleShowParsingCommands() {
        this.notifyWhenReady(() => {
            ui.showParsingCommands()
                .then((index: number) => {
                    if (index == 0) {
                        this.pauseParsing();
                    } else if (index == 1) {
                        this.resumeParsing();
                    }
                });
        });
    }

    public handleConfigurationEditCommand() {
        this.notifyWhenReady(() => this.configuration.handleConfigurationEditCommand(vscode.window.showTextDocument));
    }

    public handleAddToIncludePathCommand(path: string) {
        this.notifyWhenReady(() => this.configuration.addToIncludePathCommand(path));
    }

    public onInterval() {
        // These events can be discarded until the language client is ready.
        // Don't queue them up with this.notifyWhenReady calls.
        if (this.languageClient !== undefined && this.configuration !== undefined) {
            this.languageClient.sendNotification(IntervalTimerNotification);
            this.configuration.checkCppProperties();
        }
    }

    public dispose(): Thenable<void> {
        let promise = (this.languageClient) ? this.languageClient.stop() : Promise.resolve();
        return promise.then(() => {
            this.disposables.forEach((d) => d.dispose());
            this.disposables = [];

            for (var key in this.model) {
                if (this.model.hasOwnProperty(key)) {
                    this.model[key].dispose();
                }
            }
        });
    }
}

function getLanguageServerFileName(): string {
    let extensionProcessName = 'Microsoft.VSCode.CPP.Extension';
    let plat = process.platform;
    if (plat == 'linux') {
        extensionProcessName += '.linux';
    } else if (plat == 'darwin') {
        extensionProcessName += '.darwin';
    } else if (plat == 'win32') {
        extensionProcessName += '.exe';
    } else {
        throw "Invalid Platform";
    }
    return path.resolve(util.getExtensionFilePath("bin"), extensionProcessName);
}

class NullClient implements Client {
    private booleanEvent = new vscode.EventEmitter<boolean>();
    private stringEvent = new vscode.EventEmitter<string>();

    public get TagParsingChanged(): vscode.Event<boolean> { return this.booleanEvent.event; }
    public get IntelliSenseParsingChanged(): vscode.Event<boolean> { return this.booleanEvent.event; }
    public get NavigationLocationChanged(): vscode.Event<string> { return this.stringEvent.event; }
    public get TagParserStatusChanged(): vscode.Event<string> { return this.stringEvent.event; }
    public get ActiveConfigChanged(): vscode.Event<string> { return this.stringEvent.event; }
    RootPath: string = "/";
    RootUri: vscode.Uri = vscode.Uri.file("/");
    Name: string = "(empty)";
    TrackedDocuments = new Set<vscode.TextDocument>();
    onDidChangeSettings(): void {}
    takeOwnership(document: vscode.TextDocument): void {}
    requestGoToDeclaration(): Thenable<void> { return Promise.resolve(); }
    requestSwitchHeaderSource(rootPath: string, fileName: string): Thenable<string> { return Promise.resolve(""); }
    requestNavigationList(document: vscode.TextDocument): Thenable<string> { return Promise.resolve(""); }
    activeDocumentChanged(document: vscode.TextDocument): void {}
    activate(): void {}
    selectionChanged(selection: vscode.Position): void {}
    resetDatabase(): void {}
    deactivate(): void {}
    pauseParsing(): void {}
    resumeParsing(): void {}
    handleConfigurationSelectCommand(): void {}
    handleShowParsingCommands(): void {}
    handleConfigurationEditCommand(): void {}
    handleAddToIncludePathCommand(path: string): void {}
    onInterval(): void {}
    dispose(): Thenable<void> {
        this.booleanEvent.dispose();
        this.stringEvent.dispose();
        return Promise.resolve();
    }
}