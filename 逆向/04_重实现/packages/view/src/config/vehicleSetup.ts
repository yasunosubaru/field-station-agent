import type { TabId } from '../types.ts';
import type {
  CommandResponse,
  ConfigPage,
  ConfigPageDefinition,
  ConfigPageRuntime,
} from './types.ts';
import { SpanInstallationPage } from './localSettings.ts';

/**
 * The per-page language table `spanInstallation.js:424-463` runs after the generic pass.
 *
 * The generic marker walk (`base.ts#applyPageMarkers`) turns `data-lang-maxheight` into the key
 * `MAXHEIGHT`, which exists. Three markers do not fit that rule and were blank on the shipped
 * screen until this table filled them: `data-lang-frombaseline` → `FROM_BASE_LINE`,
 * `data-lang-fromtbdline` → `FROM_TBD_LINE`, `data-lang-fromrearline` → `FROM_REAR_LINE`. The
 * strings come from the shipped `en.js`, keyed exactly as the original keys them.
 */
const SPAN_INSTALLATION_LABELS: Array<[string, string]> = [
  ['data-lang-vehicle-type-link', 'SPAN_VEHICLE_TYPE_LINK'],
  ['data-lang-default', 'DEFAULT'],
  ['data-lang-generic', 'GENERIC'],
  ['data-lang-boat', 'BOAT'],
  ['data-lang-large-vessel', 'LARGE_VESSEL'],
  ['data-lang-small-vessel', 'SMALL_VESSEL'],
  ['data-lang-car', 'CAR'],
  ['data-lang-drone', 'DRONE'],
  ['data-lang-fixedwing', 'FIXEDWING'],
  ['data-lang-helicoptor', 'HELICOPTOR'],
  ['data-lang-human', 'HUMAN'],
  ['data-lang-tractor', 'TRACTOR'],
  ['data-lang-train', 'TRAIN'],
  ['data-lang-van', 'VAN'],
  ['data-lang-dimensions', 'DIMENSIONS'],
  ['data-lang-maxheight', 'MAXHEIGHT'],
  ['data-lang-maxwidth', 'MAXWIDTH'],
  ['data-lang-maxlength', 'MAXLENGTH'],
  ['data-lang-refpointlocation', 'REFPOINTLOCATION'],
  ['data-lang-frombaseline', 'FROM_BASE_LINE'],
  ['data-lang-fromtbdline', 'FROM_TBD_LINE'],
  ['data-lang-fromrearline', 'FROM_REAR_LINE'],
  ['data-lang-measurments-apprxmte', 'MEASURMENT_APPRXMATE'],
  ['data-lang-measurment-msg', 'MEASURMENT_MSG'],
  ['data-lang-span-wizard-msg', 'WIZARD_NAVIGATION_MSG'],
  ['data-lang-span-wizard-link', 'WIZARD_LINK'],
  ['data-lang-reference-point-imu', 'REFERENCE_POINT_IMU'],
  ['data-lang-refpoint-msg', 'REFERENCE_POINT_MSG'],
  ['data-lang-rear-line', 'REAR_LINE'],
  ['data-lang-tbd-line', 'TBD_LINE'],
  ['data-lang-base-line', 'BASE_LINE'],
  ['data-lang-cancel', 'CANCEL'],
  ['data-lang-meter-units', 'METER_UNITS'],
  ['data-lang-apply', 'APPLY'],
  ['data-lang-type', 'TYPE'],
  ['data-lang-need-help', 'NEED_HELP'],
];

/**
 * **Vehicle Setup** (manual §2.2.7) — the screen behind *Settings ▸ Vehicle Setup…*.
 *
 * The shipped suite has no `vehicleSetup` component: the Vehicle Setup screen *is* the
 * `spanInstallation` template. `spanInstallation.html` holds `#vehicleSetupTab`,
 * `#vehicleSetup-spanConfig-link`, the thirteen `.veh-images .card` vehicle types and the six
 * dimension/reference-point inputs (`#maxHeight`, `#maxWidth`, `#maxLength`, `#baseLine`,
 * `#TBDLine`, `#rearLine`), and `jarvisInterface.js:4998` reaches it as
 * `#displaysSettings-layout_<tab> #display-settings #vehicleSetupTab`. So this page serves that
 * fragment in its own container instead of re-drawing it.
 *
 * It is a **local** page, by the manual's own wording: *"These fields are used to properly scale
 * the visual representation of the vehicle. They are not used in the position solution."* and
 * *"[the RP location] is used only to show the location of the IMU on the SPAN Configuration
 * window."* No receiver message carries a vehicle's dimensions, so nothing here is sent to a
 * receiver — Apply writes the values to the user store, exactly as `spanInstallation.js:331-357`
 * does. The SPAN configuration that *does* reach the receiver is the SPAN page (CONNECTIMU /
 * INSCONFIG / SETIMUTOANTOFFSET), linked from this screen's wizard link.
 *
 * Own instance rather than the shared `SpanInstallationPage`: the two containers can be mounted in
 * the same document (the drawer serves one page per request, but a tab may hold both layouts), and
 * sharing the state object would make editing one silently rewrite the other.
 */
export class VehicleSetupPage implements ConfigPage {
  readonly name = 'vehicleSetup';
  readonly fragmentPath = './../spanInstallation/spanInstallation.html';
  readonly definition: ConfigPageDefinition & { containerId(tab: TabId): string } = {
    name: 'vehicleSetup',
    fragmentPath: './../spanInstallation/spanInstallation.html',
    containerId: (tab: TabId) => `vehicleSetup-layout_${tab}`,
  };

  private readonly installation: SpanInstallationPage;
  private readonly runtime: ConfigPageRuntime;

  constructor(runtime: ConfigPageRuntime) {
    this.runtime = runtime;
    this.installation = new SpanInstallationPage(runtime);
  }

  private get context() {
    return this.runtime.context;
  }

  /** The vehicle currently selected, then every dimension/RP value that has been saved. */
  getSelectedVehicle(tab: TabId): string {
    return this.installation.getSelectedVehicle(tab);
  }

  getInstallationDetails(tab: TabId): Record<string, unknown> {
    return this.installation.getInstallationDetails(tab);
  }

  /** `spanInstallation.js:329-357`: 0…999.99 m, at most three decimals; never sent anywhere. */
  setInstallation(tab: TabId, key: string, value: unknown): boolean {
    return this.installation.setInstallation(tab, key, value);
  }

  mount(tab: TabId, containerId = this.definition.containerId(tab)): boolean {
    const mounted = this.installation.mount(tab, containerId);
    if (mounted) this.decorate(tab, containerId);
    return mounted;
  }

  /**
   * The two steps the shipped screen needs beyond the fragment itself, both copied from the
   * original rather than re-invented:
   *
   *   labels  `spanInstallation.js:424-463` — the explicit table in `SPAN_INSTALLATION_LABELS`;
   *           three of the markers do not resolve through the generic `data-lang-*` rule.
   *   cards   `jarvisInterface.js:5016` — `.veh-images .card` ships `display:none` and that step
   *           reveals the vehicle types for this model: the non-marine set, plus Large Vessel,
   *           or only the marine set on a MarinePak (where the SPAN wizard link is hidden too).
   *
   * Nothing here invents text: every string comes from `context.translate` (the shipped `en.js`).
   */
  private decorate(tab: TabId, containerId: string): void {
    const container = this.context.document.getElementById(containerId);
    if (!container) return;
    for (const [attribute, key] of SPAN_INSTALLATION_LABELS) {
      const text = this.context.translate(key);
      if (!text || text === key) continue;
      for (const node of container.querySelectorAll(`[${attribute}]`)) node.textContent = text;
    }
    const marine = Boolean(this.context.features(tab).isMarinePak);
    for (const card of container.querySelectorAll('.veh-images .card')) {
      const isMarine = card.classList.contains('marPak');
      const show = marine ? isMarine : !isMarine || card.classList.contains('largevessel');
      const styled = card as Element & { style?: CSSStyleDeclaration };
      if (styled.style) styled.style.display = show ? 'block' : 'none';
    }
    if (marine) {
      for (const node of container.querySelectorAll('#vehicleSetup-spanConfig-link a, #vehicleSetup-spanConfig-link span')) {
        const styled = node as Element & { style?: CSSStyleDeclaration };
        if (styled.style) styled.style.display = 'none';
      }
    }
  }

  unmount(tab: TabId): void {
    this.installation.unmount(tab);
  }

  updateData(msgId: number, data: Record<string, unknown>): void {
    this.installation.updateData(msgId, data);
  }

  reset(tab: TabId): void {
    this.installation.reset(tab);
  }

  discard(tab: TabId): void {
    this.installation.discard(tab);
  }

  isDirty(tab: TabId): boolean {
    return this.installation.isDirty(tab);
  }

  apply(tab: TabId): CommandResponse | undefined {
    return this.installation.apply(tab);
  }

  handleCommandResponse(
    response: CommandResponse,
    tab: TabId,
    msgId?: number,
    error?: string,
  ): void {
    this.installation.handleCommandResponse(response, tab, msgId, error);
  }

  processLanguage(tab?: TabId): number {
    return this.installation.processLanguage(tab);
  }

  defaultData(tab: TabId): Record<string, unknown> {
    return this.installation.defaultData(tab);
  }

  currentData(tab: TabId): Record<string, unknown> {
    return this.installation.currentData(tab);
  }

  changedData(tab: TabId): Record<string, unknown> {
    return this.installation.changedData(tab);
  }
}
