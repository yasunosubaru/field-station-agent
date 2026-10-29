const fs = require('fs');
const s = fs.readFileSync(process.env.GRAPHSRC, 'utf8');
const names = ["CustomButton","Tooltip","CustomDialog","InputText","CustomInputField","ProgressBar","InputTextarea","CustomTextArea","Welcome","ProjectInfo","FileUpload","FileValidation","ErrorBanner","GraphingInfo","ProjectWizard","RecentActivity","AddFlagFooter","AddFlag","ColorPicker","FlagItem","EmptyState","Sidebar","TrashControls","Divider","CustomToastMessage","CompassButton","MapControls","Attribution","LuciadMap","MapLegend","MapEventInfo","SplitDateTimeInput","InputSwitch","CustomSwitch","Dropdown","CustomDropdown","ShowCurrent","ShowSpeedDropdown","ShowEventsSwitch","CropTimeline","Popup","FlagsList","EventsList","TimelineFlagsInfo","TimelineTrack","TimelineControls","Spinner","OverviewHeader","OverviewMap","FlagsPanel","Timeline","EChartsReact","DraggableCore","GridItem","GridLayout","ComposedComponent","ResponsiveGridLayout","ResponsiveGridWrapper","ChartControls","GeoMapChart","LineChart","GraphLabels","Checkbox","CustomCheckbox","GOSTab","ProjectInformation","TrackingMeasurement","PVTChartsPanel","HACharts","ReceiverStatusCharts","TabView","TabPanel","ChartZoomControls","ExportModal","Menu","CustomFloatingMenu","SettingsMenu","AppHeader","Landing","Overview","FileProcess"];
const out = ['component\tdefinition_offset\tdefinition_snippet'];
function findDef(n) {
  const cands = [];
  const pats = [`function ${n}(`, `${n}=({`, `const ${n}=({`, `${n}=()=>`, `,${n}=({`];
  for (const p of pats) {
    let i = -1;
    while ((i = s.indexOf(p, i + 1)) !== -1) {
      // ensure it's near app code and not a jsx usage
      cands.push(i);
      if (cands.length > 50) break;
    }
  }
  return cands;
}
for (const n of names) {
  const c = findDef(n);
  out.push([n, c.join(','), c.length ? JSON.stringify(s.slice(c[0], c[0] + 100)) : ''].join('\t'));
}
fs.writeFileSync('comp_index.tsv', out.join('\n'), 'utf8');
console.log(out.join('\n'));
