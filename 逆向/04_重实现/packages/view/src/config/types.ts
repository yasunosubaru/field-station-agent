import type { Clock } from '../clock.ts';
import type { FeatureFlags, FragmentLoader, TabId, UserStoreLike } from '../types.ts';
import type { CommandParam, ParamType } from '../../../protocol/src/command.ts';
import type { ConfigCommandCoordinator } from './state.ts';

export const COMMAND_RESPONSE = {
  UNKNOWN: 0,
  OK: 1,
  ERROR: 2,
} as const;

export type CommandResponse = (typeof COMMAND_RESPONSE)[keyof typeof COMMAND_RESPONSE];

export interface ConfigCommandEntry {
  messageId: number;
  enums: Record<string, Record<string, number>>;
}

/** Shape of `packages/protocol/data/commands.json`. */
export type ConfigCommandCatalog = Record<string, ConfigCommandEntry>;

/**
 * The shipped page code writes `[value, type, byteLength]`. String lengths are derived by
 * `frameCommand.binaryCommand`, so the third member is optional only for strings.
 */
export type ConfigParamSpec =
  | [value: unknown, type: Exclude<ParamType, 'string'>, length: number]
  | [value: unknown, type: 'string', length?: number];

export type ConfigDataMap = Array<Record<string, ConfigParamSpec>>;

export interface ConfigTransport {
  sendBinary(tab: TabId, bytes: Uint8Array): void;
  /** `controller.requestlog(tab, string)`: no CRC framing. */
  sendRaw(tab: TabId, text: string): void;
  /** `frameCommand.frameasciirequest`: CRC-framed ASCII. */
  sendAsciiFrame(tab: TabId, request: string): void;
}

export interface ConfigDialogButton {
  text: string;
  callback?: (event?: unknown) => void;
  class?: string;
  dataLang?: string;
  'data-dismiss'?: string;
}

export interface ConfigDialogOptions {
  title: string;
  content: string;
  titledataLangAttr?: string;
  closeCallback?: (event?: unknown) => void;
  buttons?: ConfigDialogButton[];
}

export interface ConfigDialogDisplay {
  tab?: TabId;
  isOverlayPopup?: boolean;
  isPOIPopup?: boolean;
  isErrorPopup?: boolean;
}

export interface ConfigFileHost {
  defaultDocuments?(): string;
  readText?(path: string): string | Promise<string>;
  writeText?(
    path: string,
    data: string,
    options?: { append?: boolean },
  ): void | Promise<void>;
  exists?(path: string): boolean | Promise<boolean>;
  ensureDirectory?(path: string): void | Promise<void>;
  chooseOpenFile?(options: {
    title?: string;
    defaultPath?: string;
    extensions: string[];
  }): string | undefined | Promise<string | undefined>;
  chooseSaveFile?(options: {
    title?: string;
    defaultPath?: string;
  }): string | undefined | Promise<string | undefined>;
  chooseDirectory?(options: {
    title?: string;
    defaultPath?: string;
  }): string | undefined | Promise<string | undefined>;
  openFolder?(path: string): void;
}

export interface ConfigOperationsHost {
  files?: ConfigFileHost;
  ftp?: {
    download?(
      tab: TabId,
      options: {
        host: string;
        port: 21;
        user: 'guest';
        files: string[];
        directory: string;
      },
    ): void | Promise<void>;
  };
  native?: {
    /** The `Edie.pimtpframer_api().getresetframe()` result, already converted from hex. */
    longhornResetFrame?(): Uint8Array | undefined;
    /** A PIMTP terminal request framed by `Edie.pimtpframer_api`; the panel sends the bytes. */
    longhornTerminalFrame?(command: string): Uint8Array | undefined;
  };
  connection?: {
    close?(tab: TabId, reconnect?: boolean): void;
    reestablish?(tab: TabId, loader?: string): void;
    deletePingPongCounter?(tab: TabId): void;
    resetSpectrumViewer?(tab: TabId): void;
    stopGiiiLogging?(tab: TabId, lowDiskSpace?: boolean): void;
    resetConfigData?(tab: TabId): void;
    setTerminalActive?(tab: TabId, active: boolean): void;
  };
  terrastar?: {
    fetch?(
      kind: 'info' | 'resend',
      psn: string,
    ): Promise<Record<string, unknown>>;
  };
}

export interface ConfigPageContext {
  document: Document;
  fragments: FragmentLoader;
  clock: Clock;
  store: UserStoreLike;
  features(tab: TabId): FeatureFlags;
  deviceTileId(tab: TabId): string;
  translate(key: string): string;
  createDialog(options: ConfigDialogOptions, display?: ConfigDialogDisplay): void;
  closeDialog(tab: TabId): void;
  showLoadingScreen(tab: TabId, milliseconds: number, labelKey?: string): void;
  closeApplyingScreen(tab: TabId, response: CommandResponse): void;
  showConnectionLoader(tab: TabId): void;
  hideConnectionLoader(tab: TabId): void;
  unloggingLogsOnWCOM?(tab: TabId): void;
  sendBinary?(tab: TabId, bytes: Uint8Array): void;
  sendRaw?(tab: TabId, text: string): void;
  sendAsciiFrame?(tab: TabId, request: string): void;
  portNames?: readonly string[];
  longhorn?: {
    applyConfiguration?(tab: TabId, values: Record<string, unknown>): void;
    resetReceiver?(tab: TabId): void;
    openFolder?(tab: TabId, path: string): void;
  };
  connectedPortName?(tab: TabId): string | undefined;
  giiiDataPortState?(tab: TabId): string | undefined;
  openConfigPage?(tab: TabId, name: string): void;
  messageId?(name: string, tab: TabId): number | undefined;
  localFileLoggingInfo?(tab: TabId): Record<string, unknown> | undefined;
  setRadioPort?(tab: TabId, port: string | undefined): void;
  restartReceiver?(tab: TabId, kind: 'normal' | 'giii'): void;
  setDialogDirty?(tab: TabId, dialogClass: string, dirty: boolean): void;
  localSettings?: {
    heightUnit?(tab: TabId): 'Ellipsoidal' | 'MSL';
    setHeightUnit?(tab: TabId, unit: 'Ellipsoidal' | 'MSL'): void;
    applyLanguage?(languageId: string): void;
  };
  copyText?(text: string): void;
  operations?: ConfigOperationsHost;
}

export interface ConfigPage {
  readonly name: string;
  readonly fragmentPath: string;
  mount(tab: TabId, containerId: string): boolean;
  unmount(tab: TabId): void;
  updateData(msgId: number, data: Record<string, unknown>): void;
  reset(tab: TabId): void;
  discard(tab: TabId): void;
  isDirty(tab: TabId): boolean;
  apply(tab: TabId): CommandResponse | undefined;
  handleCommandResponse(
    response: CommandResponse,
    tab: TabId,
    msgId?: number,
    error?: string,
  ): void;
  /** Receives every response before feature completion aggregation. */
  onCommandResponse?(
    msgId: number,
    value: number,
    tab: TabId,
    error?: string,
  ): void;
  processLanguage(tab?: TabId): number;
  defaultData(tab: TabId): Record<string, unknown>;
  currentData(tab: TabId): Record<string, unknown>;
  changedData(tab: TabId): Record<string, unknown>;
}

export interface ConfigPageRuntime {
  context: ConfigPageContext;
  commands: ConfigCommandCoordinator;
}

export interface ConfigPageDefinition {
  name: string;
  fragmentPath: string;
}

export interface ConfigCommandRequest {
  command: string;
  params: ConfigDataMap;
}

export function isConfigCommandCatalog(value: unknown): value is ConfigCommandCatalog {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every(
    (entry) =>
      !!entry &&
      typeof entry === 'object' &&
      Number.isFinite(Number((entry as { messageId?: unknown }).messageId)),
  );
}

export function param(
  value: unknown,
  type: ParamType,
  length: number,
): ConfigParamSpec {
  return [value, type, length] as ConfigParamSpec;
}

export function commandParam(value: unknown, type: ParamType, length: number): CommandParam {
  return { value: value as string | number, type, length };
}
