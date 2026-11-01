import type { TabId } from '../types.ts';
import type { ConfigDataMap, ConfigPageRuntime } from './types.ts';
import {
  BaseConfigPage,
  elementValue,
  scopedQueryAll,
  setChecked,
  setValue,
} from './base.ts';

export const NETWORK_MSG = {
  WIFI_AP_CHANNEL: 2091,
  WIFI_AP_SETTINGS: 2093,
  WIFI_MODE: 2144,
  IP_CONFIG: 1243,
  DNS_CONFIG: 1244,
  SAVE_ETHERNET_DATA: 1679,
  WIFI_AP_SSID: 2206,
  WIFI_AP_PASSKEY: 2090,
} as const;

/** `networkingSettings.js:1236-1600`. */
export class NetworkingSettingsPage extends BaseConfigPage {
  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'networkingSettings',
      fragmentPath: './../networkingSettings/networkingSettings.html',
      containerId: (tab) => `networkingSettings-layout_${tab}`,
    });
  }

  protected render(tab: TabId): void {
    const current = this.state.current(tab) as Record<string, Record<string, unknown>>;
    const ip = current[String(NETWORK_MSG.IP_CONFIG)];
    if (ip) {
      setValue(this.context, tab, '.ipaddress', ip.ipAddress);
      setValue(this.context, tab, '.subnetMask', ip.netmask);
      setValue(this.context, tab, '.ethernetGateway', ip.gateway);
      setChecked(this.context, tab, '#dhcp-on-off', ip.mode === 'DHCP');
    }
    const mode = current[String(NETWORK_MSG.WIFI_MODE)];
    if (mode) {
      const checked = ['ON', 'AP', 'CONCURRENT'].includes(String(mode.mode));
      setChecked(this.context, tab, '#wifi-hotspot-on-off', checked);
    }
  }

  setEthernet(
    tab: TabId,
    key: 'mode' | 'ipAddress' | 'netmask' | 'gateway',
    value: string,
  ): void {
    const current = this.state.current(tab) as Record<string, Record<string, unknown>>;
    this.state.setPending(tab, NETWORK_MSG.IP_CONFIG, key, value, current[String(NETWORK_MSG.IP_CONFIG)]?.[key]);
  }

  setDns(tab: TabId, value: string): void {
    const current = this.state.current(tab) as Record<string, Record<string, unknown>>;
    this.state.setPending(tab, NETWORK_MSG.DNS_CONFIG, 'ipAddress', value, current[String(NETWORK_MSG.DNS_CONFIG)]?.ipAddress);
  }

  setHotspot(tab: TabId, key: 'channel' | 'SSID' | 'passkey' | 'mode', value: unknown): void {
    const current = this.state.current(tab) as Record<string, Record<string, unknown>>;
    const msgId =
      key === 'channel'
        ? NETWORK_MSG.WIFI_AP_CHANNEL
        : key === 'mode'
          ? NETWORK_MSG.WIFI_MODE
          : NETWORK_MSG.WIFI_AP_SETTINGS;
    this.state.setPending(tab, msgId, key, value, current[String(msgId)]?.[key]);
  }

  applyEthernet(tab: TabId): 1 | 2 | undefined {
    return this.applySection(tab, 'ethernet');
  }

  applyHotspot(tab: TabId): 1 | 2 | undefined {
    return this.applySection(tab, 'hotspot');
  }

  private applySection(tab: TabId, section: 'ethernet' | 'hotspot'): 1 | 2 | undefined {
    if (!this.isDirty(tab)) return undefined;
    this.commands.setCurrentFeature(this.name);
    this.context.showLoadingScreen(tab, 6000, 'APPLYING');
    this.runSection(tab, section);
    return undefined;
  }

  protected runApply(tab: TabId) {
    this.runSection(tab, 'ethernet');
    this.runSection(tab, 'hotspot');
    return undefined;
  }

  private runSection(tab: TabId, section: 'ethernet' | 'hotspot'): void {
    const changed = this.state.pending(tab) as Record<string, Record<string, unknown>>;
    const current = this.state.current(tab) as Record<string, Record<string, unknown>>;
    if (section === 'ethernet') {
      const ip = changed[String(NETWORK_MSG.IP_CONFIG)];
      if (ip) {
        const baseline = current[String(NETWORK_MSG.IP_CONFIG)] ?? {};
        const mode = String(ip.mode ?? baseline.mode ?? 'STATIC');
        const ipAddress = mode === 'DHCP' ? '' : String(ip.ipAddress ?? baseline.ipAddress ?? elementValue(this.context, tab, '.ipaddress'));
        const netmask = mode === 'DHCP' ? '' : String(ip.netmask ?? baseline.netmask ?? elementValue(this.context, tab, '.subnetMask'));
        const gateway = mode === 'DHCP' ? '' : String(ip.gateway ?? baseline.gateway ?? elementValue(this.context, tab, '.ethernetGateway'));
        const params: ConfigDataMap = [
          { interfaceName: ['ETHA', 'enum', 4] },
          { mode: [mode, 'enum', 4] },
          { ipAddress: [ipAddress, 'string'] },
          { netmask: [netmask, 'string'] },
          { gateway: [gateway, 'string'] },
        ];
        this.commands.place(this.name, 'ipConfig', params, tab);
        this.commands.place(
          this.name,
          'saveethernetdata',
          [{ interfaceName: ['ETHA', 'enum', 4] }],
          tab,
        );
      }
      const dns = changed[String(NETWORK_MSG.DNS_CONFIG)];
      if (dns) {
        // Both spellings exist in the shipped tree; `.dnsipaddress` is the OEM fragment's class.
        const field =
          elementValue(this.context, tab, '.dnsipaddress') ||
          elementValue(this.context, tab, '.dns-ip-address');
        const address = dns.ipAddress ?? current[String(NETWORK_MSG.DNS_CONFIG)]?.ipAddress ?? field;
        this.commands.place(
          this.name,
          'dnsConfig',
          [
            { dnsserver: [1, 'enum', 4] },
            { ipAddress: [address, 'string'] },
          ],
          tab,
        );
        this.commands.place(
          this.name,
          'saveethernetdata',
          [{ interfaceName: ['ETHA', 'enum', 4] }],
          tab,
        );
      }
      return;
    }

    const channel = changed[String(NETWORK_MSG.WIFI_AP_CHANNEL)];
    if (channel) {
      this.commands.place(this.name, 'wifiapchannel', [{ channel: [channel.channel ?? 1, 'ulong', 4] }], tab);
    }
    const ap = changed[String(NETWORK_MSG.WIFI_AP_SETTINGS)];
    if (ap) {
      const baseline = current[String(NETWORK_MSG.WIFI_AP_SETTINGS)] ?? {};
      this.commands.place(
        this.name,
        'wifiapssid',
        [{ SSID: [ap.SSID ?? baseline.SSID ?? '', 'string'] }],
        tab,
      );
      this.commands.place(
        this.name,
        'wifiappasskey',
        [{ passkey: [ap.passkey ?? baseline.passkey ?? '', 'string'] }],
        tab,
      );
    }
    const modeChange = changed[String(NETWORK_MSG.WIFI_MODE)];
    if (ap && !modeChange) {
      const currentMode = current[String(NETWORK_MSG.WIFI_MODE)]?.mode;
      if (currentMode !== undefined) {
        this.commands.place(
          this.name,
          'wifimode',
          [{ mode: [currentMode, 'enum', 4] }],
          tab,
        );
      }
    }
    if (modeChange) {
      const currentMode = String(current[String(NETWORK_MSG.WIFI_MODE)]?.mode ?? 'OFF');
      const wanted = String(modeChange.mode ?? 'OFF');
      const mode =
        wanted === 'ON'
          ? currentMode === 'CLIENT'
            ? 'CONCURRENT'
            : 'AP'
          : currentMode === 'CONCURRENT'
            ? 'CLIENT'
            : 'OFF';
      this.commands.place(this.name, 'wifimode', [{ mode: [mode, 'enum', 4] }], tab);
    }
  }

  handleNetworkCommandResponse(data: 1 | 2, tab: TabId): void {
    this.commands.removeFeature(this.name, tab);
    this.context.clock.setTimeout(() => {
      this.context.closeApplyingScreen(tab, data);
      this.context.closeDialog(tab);
      if (data === 1) this.commit(tab);
      this.render(tab);
    }, 1000);
  }

  /**
   * The shipped fragment's own controls. `networkingSettings.js` binds them with delegated
   * handlers; the pages here are driven from the server, so each control gets a listener that
   * records the pending value — without them a field typed into the page would never reach
   * `/api/live`, which is exactly the "changes must travel" half of this page.
   */
  protected override bindActions(tab: TabId, container: Element): void {
    super.bindActions(tab, container);
    const text = (node: Element): string =>
      String((node as unknown as { value?: string }).value ?? '').trim();
    const on = (node: Element): boolean => Boolean((node as unknown as { checked?: boolean }).checked);
    const change = (selector: string, apply: (node: Element) => void): void => {
      for (const node of container.querySelectorAll(selector)) {
        node.addEventListener('change', () => apply(node));
      }
    };

    change('.ipaddress', (node) => this.setEthernet(tab, 'ipAddress', text(node)));
    change('.subnetMask', (node) => this.setEthernet(tab, 'netmask', text(node)));
    change('.ethernetGateway', (node) => this.setEthernet(tab, 'gateway', text(node)));
    change('#dhcp-on-off', (node) => this.setEthernet(tab, 'mode', on(node) ? 'DHCP' : 'STATIC'));
    // Both spellings exist in the shipped tree: `.dnsipaddress` in the OEM fragment, and the
    // dotted class the original's handler used.
    change('.dnsipaddress, .dns-ip-address', (node) => this.setDns(tab, text(node)));
    change('#wifi-hotspot-on-off', (node) => this.setHotspot(tab, 'mode', on(node) ? 'ON' : 'OFF'));

    for (const node of container.querySelectorAll('.wifi-channel-item')) {
      node.addEventListener('click', () => {
        const channel = Number((node.textContent ?? '').trim());
        if (!Number.isFinite(channel) || channel <= 0) return;
        this.setHotspot(tab, 'channel', channel);
        // `networkingSettings.js` mirrors the choice into `#selectedChannelVal` and the button.
        const label = container.querySelector('#selectedChannelVal');
        if (label) label.textContent = String(channel);
        const button = container.querySelector('#network-channel');
        if (button) {
          const first = button.childNodes[0];
          if (first) first.textContent = String(channel);
          else button.textContent = String(channel);
        }
      });
    }
  }

  resetNetworkSettingsUI(tab: TabId): void {
    this.context.showConnectionLoader(tab);
    this.context.clock.setTimeout(() => {
      this.reset(tab);
      this.context.hideConnectionLoader(tab);
    }, tab.startsWith('grit') ? 2500 : 2000);
  }

  /** All checkbox state for tests and programmatic UI. */
  controls(tab: TabId): { dhcp: boolean; hotspot: boolean } {
    return {
      dhcp: !!scopedQueryAll(this.context, tab, '#dhcp-on-off')[0]?.hasAttribute('checked'),
      hotspot: !!scopedQueryAll(this.context, tab, '#wifi-hotspot-on-off')[0]?.hasAttribute('checked'),
    };
  }
}
