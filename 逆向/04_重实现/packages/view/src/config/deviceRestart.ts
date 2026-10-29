import type { TabId } from '../types.ts';
import type { ConfigDataMap, ConfigPageRuntime } from './types.ts';
import { BaseConfigPage, setVisible } from './base.ts';

export const RESTART_MSG = {
  RESET: 18,
  FRESET: 20,
} as const;

export interface MarinePakFactoryResetState {
  marinePakFresetActive: boolean;
  luaStatusChecked: boolean;
  luaSuccessful: boolean;
  luaFresetSent: boolean;
}

/** `deviceRestart.js:20-290`; native Longhorn framing is an explicit host requirement. */
export class DeviceRestartPage extends BaseConfigPage {
  private readonly marinePak = new Map<TabId, MarinePakFactoryResetState>();
  private readonly nativeNeeds = new Map<TabId, string[]>();

  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'deviceRestart',
      fragmentPath: './../deviceRestart/deviceRestart.html',
      containerId: (tab) => `deviceRestart-layout_${tab}`,
    });
  }

  protected override bindActions(tab: TabId, container: Element): void {
    super.bindActions(tab, container);
    container.querySelector('#restartBtn')?.addEventListener('click', () => {
      this.context.createDialog(
        {
          title: this.context.translate('RESTARTCONFIRMATION'),
          titledataLangAttr: 'data-lang-restart-confirmation',
          content: this.context.translate('RECEIVERRESTART_1').replace('%1', '<br> <br>'),
          buttons: [
            {
              text: this.context.translate('YES'),
              dataLang: 'data-lang-yes',
              callback: () => {
                this.resetFunc(tab, this.eraseRequested(tab));
                this.context.closeDialog(tab);
              },
            },
            {
              text: this.context.translate('NO'),
              dataLang: 'data-lang-no',
              class: 'darkBtn',
              callback: () => this.context.closeDialog(tab),
            },
          ],
        },
        { tab },
      );
    });
    container.querySelector('#fresetBtn')?.addEventListener('click', () => {
      this.context.createDialog(
        {
          title: this.context.translate('FACTORY_RESET_CONIFRM'),
          titledataLangAttr: 'data-lang-factory-reset-confirmation',
          content: this.context.translate('FRESETMESSAGE').replace('%1', '<br> <br>'),
          buttons: [
            {
              text: this.context.translate('YES'),
              dataLang: 'data-lang-yes',
              callback: () => {
                this.fresetFunc(tab, this.eraseRequested(tab));
                this.context.closeDialog(tab);
              },
            },
            {
              text: this.context.translate('NO'),
              dataLang: 'data-lang-no',
              class: 'darkBtn',
              callback: () => this.context.closeDialog(tab),
            },
          ],
        },
        { tab },
      );
    });
    const erase = container.querySelector('#erase-nvm');
    erase?.addEventListener('click', () => {
      erase.classList.toggle('active-select-btn');
    });
  }

  resetFunc(tab: TabId, eraseNvm = false): void {
    const features = this.context.features(tab);
    if (features.isLongHorn) {
      this.longhornResetFunc(tab);
      return;
    }
    if (features.isGIII) {
      this.context.sendRaw?.(tab, 'LOG  VERSIONB ONTIME 1\n');
      this.context.sendRaw?.(tab, 'RESET\n');
      this.context.operations?.connection?.stopGiiiLogging?.(tab, true);
      this.context.showLoadingScreen(tab, 60000, 'RESTARTING');
      this.context.operations?.connection?.deletePingPongCounter?.(tab);
      return;
    }
    if (eraseNvm) this.clearLUAData(tab);
    this.commands.sendUntracked(
      'reset',
      [{ delayTime: [0, 'ulong', 4] }],
      tab,
    );
    this.context.showLoadingScreen(tab, 30000, 'RESTARTING');
    this.context.operations?.connection?.deletePingPongCounter?.(tab);
    if (tab.startsWith('grit')) {
      this.context.operations?.connection?.resetSpectrumViewer?.(tab);
    }
  }

  fresetFunc(tab: TabId, eraseNvm = false): void {
    if (eraseNvm) this.clearLUAData(tab);
    this.commands.sendUntracked(
      'freset',
      [{ target: ['STANDARD', 'enum', 4] }],
      tab,
    );
    this.context.operations?.connection?.deletePingPongCounter?.(tab);
    const marine = this.context.features(tab).isMarinePak;
    if (marine) {
      const state = this.marineState(tab);
      this.context.showLoadingScreen(tab, 30000, 'FRESETLOADINGMSG');
      this.context.clock.setTimeout(() => {
        state.marinePakFresetActive = true;
        this.context.operations?.connection?.close?.(tab, true);
        this.context.operations?.connection?.reestablish?.(tab, 'noLoader');
      }, 30000);
    } else {
      this.context.showLoadingScreen(tab, 30000, 'FRESETLOADINGMSG');
      this.resetConfigDataObjects(tab);
      if (tab.startsWith('grit')) {
        this.context.operations?.connection?.resetSpectrumViewer?.(tab);
      }
    }
  }

  clearLUAData(tab: TabId): void {
    for (const line of [
      'SOFTLOADRESET\n',
      'SOFTLOADSREC "S0~P~M7QP,M7QPB,OEM718D,OEM718DC,OEM719,OEM719A,OEM719B,OEM719C,OEM719D,OEM719AC,OEM719BC,OEM719N,OEM729,OEM729R,OEM729C,OEM729RC,OEM7500,OEM7500C,OEM7600,OEM7600C,OEM7700,OEM7700C,OEM7720,OEM7720C,PIM7500,PIM7500C"\n',
      'SOFTLOADSREC "S0~V~DEV-LOAD"\n',
      'SOFTLOADSREC "S0~T~DATA1"\n',
      'SOFTLOADSREC "S30900000000FFFFFFFFFA"\n',
      'SOFTLOADCOMMIT\n',
    ]) {
      this.context.sendRaw?.(tab, line);
    }
  }

  longhornResetFunc(tab: TabId): void {
    this.context.showLoadingScreen(tab, 20000, 'RESTARTING');
    const frame = this.context.operations?.native?.longhornResetFrame?.();
    if (frame) this.context.sendBinary?.(tab, frame);
    else this.requireNative(tab, 'Edie.pimtpframer_api().getresetframe()');
    this.context.clock.setTimeout(() => {
      this.context.operations?.connection?.close?.(tab, true);
      this.context.operations?.connection?.reestablish?.(tab, 'noLoader');
    }, 10000);
    this.context.clock.setTimeout(() => {
      this.context.operations?.connection?.reestablish?.(tab, 'noLoader');
    }, 21000);
  }

  handleLuaStatusCommandResponse(response: string, tab: TabId): void {
    const state = this.marineState(tab);
    if (response.includes('factoryreset.lua')) {
      if (response.includes('COMPLETED') && state.marinePakFresetActive) {
        state.luaSuccessful = true;
        this.context.closeApplyingScreen(tab, 1);
        this.context.operations?.connection?.reestablish?.(tab);
        this.marinePak.delete(tab);
      }
    } else if (response.includes('autoexec.lua')) {
      if (response.includes('COMPLETED') && state.marinePakFresetActive) {
        state.luaFresetSent = true;
        this.context.sendRaw?.(tab, 'LUA START factoryreset.lua\n');
        this.context.operations?.connection?.deletePingPongCounter?.(tab);
      }
    } else if (
      response.includes('Message is invalid') ||
      response.includes('SCRIPT_ERROR') ||
      response.includes('EXECUTOR_ERROR')
    ) {
      state.luaSuccessful = false;
      const element = this.context.document.querySelector(`#${tab} .lua-script-response`);
      if (element) {
        element.textContent =
          response === '<ERROR:Message is invalid for this model\r\n'
            ? this.context.translate('LUAFRESETINVALID')
            : response;
        setVisible(element, true);
      }
      state.marinePakFresetActive = false;
      this.context.clock.setTimeout(() => this.marinePak.delete(tab), 2500);
    }
  }

  resetConfigDataObjects(tab: TabId): void {
    this.context.operations?.connection?.resetConfigData?.(tab);
  }

  getMarinePakFresetActiveFlag(tab: TabId): boolean | undefined {
    return this.marinePak.get(tab)?.marinePakFresetActive;
  }

  getluaStatusChecked(tab: TabId): boolean | undefined {
    return this.marinePak.get(tab)?.luaStatusChecked;
  }

  setluaStatusChecked(value: boolean, tab: TabId): void {
    this.marineState(tab).luaStatusChecked = value;
  }

  getluaFresetSent(tab: TabId): boolean | undefined {
    return this.marinePak.get(tab)?.luaFresetSent;
  }

  setluaFresetSent(value: boolean, tab: TabId): void {
    this.marineState(tab).luaFresetSent = value;
  }

  checkLuaStatus(tab: TabId): void {
    if (this.getMarinePakFresetActiveFlag(tab)) {
      this.context.operations?.connection?.reestablish?.(tab, 'noLoader');
    }
  }

  getLuaScriptSuccessful(tab: TabId): boolean | undefined {
    return this.marinePak.get(tab)?.luaSuccessful;
  }

  clearMarinePakFresetObj(tab: TabId): void {
    this.marinePak.delete(tab);
  }

  nativeRequirements(tab: TabId): string[] {
    return [...(this.nativeNeeds.get(tab) ?? [])];
  }

  protected runApply(_tab: TabId): undefined {
    return undefined;
  }

  protected render(_tab: TabId): void {}

  private marineState(tab: TabId): MarinePakFactoryResetState {
    let value = this.marinePak.get(tab);
    if (!value) {
      value = {
        marinePakFresetActive: false,
        luaStatusChecked: false,
        luaSuccessful: false,
        luaFresetSent: false,
      };
      this.marinePak.set(tab, value);
    }
    return value;
  }

  private eraseRequested(tab: TabId): boolean {
    return (
      this.context.document
        .querySelector(`#${tab} #erase-nvm`)
        ?.classList.contains('active-select-btn') === true
    );
  }

  private requireNative(tab: TabId, requirement: string): void {
    const current = this.nativeNeeds.get(tab) ?? [];
    if (!current.includes(requirement)) current.push(requirement);
    this.nativeNeeds.set(tab, current);
  }
}
