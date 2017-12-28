/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * See LICENSE.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

 import * as os from 'os';

export enum DebuggerType {
    cppvsdbg,
    cppdbg
}

export interface IConfigurationSnippet {
    label: string;
    description: string;
    bodyText: string;

    // Internal
    isInitialConfiguration?: boolean;
    debuggerType: DebuggerType;
}

export function indentJsonString(json: string, numTabs: number = 1): string {
    return json.split('\n').map(line => '\t'.repeat(numTabs) + line).join('\n').trim();
}

function formatString(format: string, args: string[]) {
    for( var arg in args) {
        format = format.replace("{" + arg + "}", args[arg]);
    }
    return format;
}

// Initial configurations do not require escaping ${keyword}. If it is being used
// as a configuration snippet, then ${keyword} will need to be escaped or VsCode will
// try to evaluate it.
function EnsureTokensEscapedInLaunchJsonMacro(keyword: string, isInitialConfiguration: boolean): string {
    if (isInitialConfiguration) {
        return "${" + keyword + "}";
    }
    else {
        return "\\$\{" + keyword + "\}";
    }
}

function CreateLaunchString(name: string, type: string, executable: string, isInitialConfiguration: boolean): string {
        return `"name": "${name}",
"type": "${type}",
"request": "launch",
"program": "${"enter program name, for example " + EnsureTokensEscapedInLaunchJsonMacro("workspaceFolder", isInitialConfiguration) + "/" + executable}",
"args": [],
"stopAtEntry": false,
"cwd": \"${EnsureTokensEscapedInLaunchJsonMacro("workspaceFolder", isInitialConfiguration)}\",
"environment": [],
"externalConsole": true
`
    }

function CreateAttachString(name: string, type: string, executable: string): string {
    return formatString(`
"name": "${name}",
"type": "${type}",
"request": "attach",{0}
"processId": \"\\$\{command:pickProcess\}\"
`, [type === "cppdbg" ? `${os.EOL}"program": "${"enter program name, for example \\$\{workspaceFolder\}/" + executable}",` : ""]);
    }

function CreateRemoteAttachString(name: string, type: string, executable: string): string {
        return `
"name": "${name}",
"type": "${type}",
"request": "attach",
"program": "${"enter program name, for example \\$\{workspaceFolder\}/" + executable}",
"processId": \"\\$\{command:pickRemoteProcess\}\"
`;
    }

 function CreatePipeTransportString(pipeProgram: string, debuggerProgram: string): string {
        return `
"pipeTransport": {
\t"debuggerPath": "/usr/bin/${debuggerProgram}",
\t"pipeProgram": "${pipeProgram}",
\t"pipeArgs": [],
\t"pipeCwd": ""
}`;
    }

export interface IConfiguration {
    GetLaunchConfiguration(isInitialConfiguration: boolean): IConfigurationSnippet;
    GetAttachConfiguration(): IConfigurationSnippet;
}

abstract class Configuration implements IConfiguration {
    public snippetPrefix = "C/C++: "

    public executable: string;
    public pipeProgram: string;
    public MIMode: string;
    public additionalProperties: string;

    public miDebugger = "cppdbg";
    public windowsDebugger = "cppvsdbg";

    constructor(MIMode: string, executable: string, pipeProgram: string, additionalProperties: string = "") {
        this.MIMode = MIMode;
        this.executable = executable;
        this.pipeProgram = pipeProgram;
        this.additionalProperties = additionalProperties;
    }

    abstract GetLaunchConfiguration(isInitialConfiguration: boolean): IConfigurationSnippet;
    abstract GetAttachConfiguration(): IConfigurationSnippet;
}

export class MIConfigurations extends Configuration {

    public GetLaunchConfiguration(isInitialConfiguration: boolean): IConfigurationSnippet {
        let name: string = `(${this.MIMode}) Launch`;

        let body: string = formatString(`{
\t${indentJsonString(CreateLaunchString(name, this.miDebugger, this.executable, isInitialConfiguration))},
\t"MIMode": "${this.MIMode}"{0}{1}
}`, [this.miDebugger === "cppdbg" && os.platform() === "win32" ? `,${os.EOL}\t"miDebuggerPath": "/path/to/gdb"` : "", 
this.additionalProperties ? `,${os.EOL}\t${indentJsonString(this.additionalProperties)}` : ""]);

        return {
            "label": this.snippetPrefix + name,
            "description": `Launch with ${this.MIMode}.`,
            "bodyText": body.trim(),
            "isInitialConfiguration": true,
            "debuggerType": DebuggerType.cppdbg
        }
    }

    public GetAttachConfiguration(): IConfigurationSnippet {
        let name: string = `(${this.MIMode}) Attach`;

        let body: string = formatString(`{ 
\t${indentJsonString(CreateAttachString(name, this.miDebugger, this.executable))},
\t"MIMode": "${this.MIMode}"{0}
}`, [this.miDebugger === "cppdbg" && os.platform() === "win32" ? `,${os.EOL}\t"miDebuggerPath": "/path/to/gdb"` : ""]);

        return {
            "label": this.snippetPrefix + name,
            "description": `Attach with ${this.MIMode}.`,
            "bodyText": body.trim(),
            "debuggerType": DebuggerType.cppdbg
        };

    }
}

export class PipeTransportConfigurations extends Configuration {

    public GetLaunchConfiguration(isInitialConfiguration: boolean): IConfigurationSnippet {
        let name: string = `(${this.MIMode}) Pipe Launch`;

        let body: string = formatString(`
{
\t${indentJsonString(CreateLaunchString(name, this.miDebugger, this.executable, isInitialConfiguration))},
\t${indentJsonString(CreatePipeTransportString(this.pipeProgram, this.MIMode))},
\t"MIMode": "${this.MIMode}"{0}
}`, [this.additionalProperties ? `,${os.EOL}\t${indentJsonString(this.additionalProperties)}` : ""]);

        return {
            "label": this.snippetPrefix + name,
            "description": `Pipe Launch with ${this.MIMode}.`,
            "bodyText": body.trim(),
            "debuggerType": DebuggerType.cppdbg
        };

    }

    public GetAttachConfiguration(): IConfigurationSnippet {
        let name: string = `(${this.MIMode}) Pipe Attach`;

        let body: string = `
{
\t${indentJsonString(CreateRemoteAttachString(name, this.miDebugger, this.executable))},
\t${indentJsonString(CreatePipeTransportString(this.pipeProgram, this.MIMode))},
\t"MIMode": "${this.MIMode}"
}`;
        return {
            "label": this.snippetPrefix + name,
            "description": `Pipe Attach with ${this.MIMode}.`,
            "bodyText": body.trim(),
            "debuggerType": DebuggerType.cppdbg
        };

    }
}

export class WindowsConfigurations extends Configuration {

    public GetLaunchConfiguration(isInitialConfiguration: boolean): IConfigurationSnippet {
        let name = "(Windows) Launch";

        let body: string = `
{
\t${indentJsonString(CreateLaunchString(name, this.windowsDebugger, this.executable, isInitialConfiguration))}
}`;

        return {
            "label": this.snippetPrefix + name,
            "description": "Launch with the Visual Studio C/C++ debugger.",
            "bodyText": body.trim(),
            "isInitialConfiguration": true,
            "debuggerType": DebuggerType.cppvsdbg
        };

    }

    public GetAttachConfiguration(): IConfigurationSnippet {
        let name: string = "(Windows) Attach";

        let body: string = `
{
\t${indentJsonString(CreateAttachString(name, this.windowsDebugger, this.executable))}
}`;

        return {
            "label": this.snippetPrefix + name,
            "description": "Attach to a process with the Visual Studio C/C++ debugger.",
            "bodyText": body.trim(),
            "debuggerType": DebuggerType.cppvsdbg
        };

    }
}

export class WSLConfigurations extends Configuration {
    public bashPipeProgram = "C:\\\\\\\\Windows\\\\\\\\sysnative\\\\\\\\bash.exe";

    public GetLaunchConfiguration(isInitialConfiguration: boolean): IConfigurationSnippet {
        let name: string = `(${this.MIMode}) Bash on Windows Launch`;

        let body: string = formatString(`
{
\t${indentJsonString(CreateLaunchString(name, this.miDebugger, this.executable, isInitialConfiguration))},
\t${indentJsonString(CreatePipeTransportString(this.bashPipeProgram, this.MIMode))}{0}
}`, [this.additionalProperties ? `,${os.EOL}\t${indentJsonString(this.additionalProperties)}` : ""]);

        return {
            "label": this.snippetPrefix + name,
            "description": `Launch in Bash on Windows using ${this.MIMode}.`,
            "bodyText": body.trim(),
            "debuggerType": DebuggerType.cppdbg
        };
    }

    public GetAttachConfiguration(): IConfigurationSnippet {
        let name: string = `(${this.MIMode}) Bash on Windows Attach`;

        let body: string = `
{
\t${indentJsonString(CreateAttachString(name, this.miDebugger, this.executable))},
\t${indentJsonString(CreatePipeTransportString(this.bashPipeProgram, this.MIMode))}
}`;

        return {
            "label": this.snippetPrefix + name,
            "description": `Attach to a remote process running in Bash on Windows using ${this.MIMode}.`,
            "bodyText": body.trim(),
            "debuggerType": DebuggerType.cppdbg
        };
    }
}
