export const LOCAL_AGENT_READONLY_COMMANDS = [
  "ping",
  "status",
  "read_dir",
  "read_file_head",
] as const;

export const LOCAL_AGENT_WRITE_COMMANDS = [
  "shell.exec",
  "fs.write",
] as const;

const READONLY_SET = new Set<string>(LOCAL_AGENT_READONLY_COMMANDS);
const WRITE_SET = new Set<string>(LOCAL_AGENT_WRITE_COMMANDS);
const SUPPORTED_SET = new Set<string>([
  ...LOCAL_AGENT_READONLY_COMMANDS,
  ...LOCAL_AGENT_WRITE_COMMANDS,
]);

export function isLocalReadonlyCommand(command: string): boolean {
  return READONLY_SET.has(command);
}

export function isLocalWriteCommand(command: string): boolean {
  return WRITE_SET.has(command);
}

export function isLocalSupportedCommand(command: string): boolean {
  return SUPPORTED_SET.has(command);
}

export function isCloudOnlyCommand(command: string): boolean {
  return command.startsWith("github.");
}

export function supportedLocalCommandsSummary(): string {
  return [
    `Lectura local: ${LOCAL_AGENT_READONLY_COMMANDS.join(", ")}`,
    `Escritura local/sandbox: ${LOCAL_AGENT_WRITE_COMMANDS.join(", ")}`,
    "Cloud-only: github.* se ejecuta en hocker.one / cloud-hocker-one, no en este agente.",
  ].join("\n");
}
