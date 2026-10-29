import type { TabId } from '../types.ts';

interface DomElement {
  id: string;
  className: string;
  innerHTML: string;
  readonly classList: { add(...names: string[]): void };
  readonly style: { display: string };
  appendChild(node: unknown): unknown;
  setAttribute(name: string, value: string): void;
}

export interface GritShell {
  tab: TabId;
  eventsPanel: DomElement;
  menuPanel: DomElement;
  statusPanel: DomElement;
  mainPanel: DomElement;
  statusComponents: DomElement;
  configComponents: DomElement;
  statusTile: DomElement;
  spectrumTile: DomElement;
  interferenceTile: DomElement;
  poiContainer: DomElement;
  spoofingContainer: DomElement;
}

function div(doc: Document, id: string, className: string): DomElement {
  const node = doc.createElement('div') as unknown as DomElement;
  node.id = id;
  node.className = className;
  return node;
}

/** `gritJarvisInterface.js:438-597`: the GRIT-specific shell, with no SM status/config rows. */
export function buildGritShell(doc: Document, tab: TabId, host: Element): GritShell {
  const domHost = host as unknown as DomElement;
  const eventsPanel = div(doc, `grit-events-panel-${tab}`, 'events-panel grit-events-panel complete-panel');
  const menuPanel = div(doc, `grit-menuBar-panel-${tab}`, 'menuBar-panel grit-menuBar-panel complete-panel');
  const statusPanel = div(doc, `grit-status-panel-${tab}`, 'grit-status-panel complete-panel');
  const mainPanel = div(doc, `main-panel-${tab}`, 'main-panel complete-panel');
  const fetch = div(doc, `fetch-loader-${tab}`, 'fetch-loader');
  const statusComponents = div(doc, `grit-status-components-${tab}`, 'status-components grit-status-components');
  const configComponents = div(doc, `grit-config-components-${tab}`, 'config-components grit-config-components');
  for (const node of [eventsPanel, menuPanel, statusPanel, mainPanel]) domHost.appendChild(node);
  mainPanel.appendChild(fetch);
  mainPanel.appendChild(statusComponents);
  mainPanel.appendChild(configComponents);

  const statusTile = div(doc, `tile-0-${tab}`, 'tile grit-receiverPanel');
  statusPanel.appendChild(statusTile);

  const spectrumTile = div(doc, `tile-1-${tab}`, 'tile status-tile spectrum-viewer-comp');
  const interferenceTile = div(doc, `tile-2-${tab}`, 'tile status-tile interference-toolkit-comp');
  statusComponents.appendChild(spectrumTile);
  statusComponents.appendChild(interferenceTile);

  const tabs = div(doc, 'grit-config-tabs', 'row');
  tabs.innerHTML =
    `<div class="config-tabs"><ul class="nav nav-pills tabbing">` +
    `<li id="spoofingConfig" class="nav-item gritconfigtabs active"><a data-lang-spoofing-title href="#grit-config-spoofing-${tab}" data-toggle="pill"></a></li>` +
    `</ul></div><div class="tab-content">` +
    `<div id="grit-config-spoofing-${tab}" class="totaldata active active-config"></div>` +
    `</div><div class="configtab-bottom-gap"></div>`;
  configComponents.appendChild(tabs);
  const poiContainer = div(doc, `settings-points_of_interest-${tab}`, 'menu-layouts pointsOfInterest-container');
  mainPanel.appendChild(poiContainer);
  const spoofingContainer = doc.getElementById(`grit-config-spoofing-${tab}`) as unknown as DomElement;

  const popup = div(doc, 'tabs-popup', 'popup-modal');
  popup.setAttribute('data-popup', '');
  popup.innerHTML =
    `<div class="modal" id="popupModal" role="dialog"><div class="modal-dialog modal-md"><div class="modal-content">` +
    `<div class="modal-header"><button class="close-btn" data-dismiss="modal"></button><h4 class="modal-title"></h4></div>` +
    `<div class="modal-body"><p></p></div><div class="modal-footer"></div>` +
    `<div id="btn-template" class="Template" style="display:none"><button class="btn btn-default whiteBtn"></button></div>` +
    `</div></div></div>`;
  domHost.appendChild(popup);
  const poiPopup = div(doc, 'POIpopupModal', 'modal');
  poiPopup.innerHTML = '<div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h4 class="modal-title"></h4></div><div class="modal-body"><p></p></div><div class="modal-footer"></div></div></div>';
  domHost.appendChild(poiPopup);
  const loader = div(doc, 'connection-loader', '');
  loader.style.display = 'none';
  domHost.appendChild(loader);

  return {
    tab,
    eventsPanel,
    menuPanel,
    statusPanel,
    mainPanel,
    statusComponents,
    configComponents,
    statusTile,
    spectrumTile,
    interferenceTile,
    poiContainer,
    spoofingContainer,
  };
}
