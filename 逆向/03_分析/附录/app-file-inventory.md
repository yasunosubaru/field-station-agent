# 应用自带文件清单（不含 node_modules）

> 自动生成：`tools/gen_file_inventory.js`。行数为文本文件行数，二进制留空。
> 用途：证明「每一个文件都被某个子系统文档覆盖到」，是覆盖度账本。

总计 **1017** 个文件，**222.2 MB**。

## A1. 控制器/传输/解析  (9 文件, 0.23 MB)

| 文件 | 行 | 字节 |
|---|---:|---:|
| `controller/playback.js` | 2103 | 89440 |
| `controller/serverConnectV2.js` | 857 | 38513 |
| `controller/communication.js` | 750 | 27916 |
| `controller/frameCommand.js` | 250 | 27209 |
| `controller/genericparser.js` | 510 | 22569 |
| `controller/serverConnect.js` | 429 | 16220 |
| `controller/crc.js` | 178 | 7273 |
| `controller/pingpong.js` | 117 | 5449 |
| `controller/connectionLostHandler.js` | 89 | 5204 |

## A2. 数据模型/消息目录  (20 文件, 0.71 MB)

| 文件 | 行 | 字节 |
|---|---:|---:|
| `model/logparsers.js` | 3391 | 200233 |
| `model/NovatelIdConstants.js` | 4964 | 141711 |
| `model/MessageIdConstants.js` | 699 | 64886 |
| `model/M6MessageIdConstants.js` | 657 | 62140 |
| `model/featuresList.js` | 1459 | 55090 |
| `model/constellation.js` | 1355 | 47227 |
| `model/positionModes.js` | 706 | 39608 |
| `model/popper.min.js` | 5 | 21007 |
| `model/constellationHandler.js` | 401 | 20388 |
| `model/serverModel.js` | 476 | 20250 |
| `model/gritConstellation.js` | 368 | 16460 |
| `model/basemodel.js` | 241 | 11033 |
| `model/bestpos.js` | 249 | 8678 |
| `model/MessageIdTweaks.js` | 101 | 8478 |
| `model/FileSaver.js` | 248 | 8012 |
| `model/common.js` | 182 | 6491 |
| `model/satvis2.js` | 204 | 5816 |
| `model/Blob.js` | 167 | 5328 |
| `model/userStore.js` | 124 | 3624 |
| `model/GIIIMessageIdConstants.js` | 24 | 1341 |

## B. Manage 视图层  (122 文件, 8.96 MB)

| 文件 | 行 | 字节 |
|---|---:|---:|
| `view/js/plotly-latest.min.js` | 7 | 3238299 |
| `view/js/help.js` | 20225 | 1339979 |
| `view/positionConfig/positionConfig.js` | 6224 | 338730 |
| `view/html/nasHelp.html` | 5271 | 320329 |
| `view/portConfig/portConfig.js` | 4812 | 261984 |
| `view/spanConfig/spanConfig.js` | 4316 | 232520 |
| `view/loggingConfig/loggingConfig.js` | 4809 | 231026 |
| `view/js/interferenceToolKit.js` | 5989 | 227232 |
| `view/html/setUpMonitor.html` | 3038 | 167781 |
| `view/js/html2canvas.min.js` | 20 | 164788 |
| `view/loggingConfig/giii-loggingConfig.js` | 2817 | 139734 |
| `view/events/events.js` | 2539 | 136274 |
| `view/satelliteTracking/satelliteTracking.js` | 2674 | 132881 |
| `view/satelliteTracking/giii-satelliteTracking.js` | 2664 | 132393 |
| `view/js/welcome.js` | 2094 | 131599 |
| `view/addApplication/addApplication.js` | 2808 | 125490 |
| `view/deviceManagement/deviceManagement.js` | 1995 | 104365 |
| `view/positionConfig/lghn-positionConfig .js` | 1708 | 91671 |
| `view/alignConfig/alignConfig.js` | 1475 | 84531 |
| `view/networkingSettings/networkingSettings.js` | 1611 | 82657 |
| `view/html/index.html` | 1234 | 77090 |
| `view/radioConfig/radioConfig.js` | 1255 | 73345 |
| `view/spanConfig/spanConfig.html` | 1067 | 71187 |
| `view/deviceDetails/deviceDetails.js` | 1134 | 60289 |
| `view/genericView.js` | 1218 | 59453 |
| `view/deviceExport/deviceExport.js` | 1105 | 56708 |
| `view/js/longhornStatusUI.js` | 1338 | 54762 |
| `view/menuBar/menuBar.js` | 1073 | 53492 |
| `view/positionConfig/positionConfig.html` | 672 | 51246 |
| `view/terminalConsole/terminalConsole.js` | 1138 | 51092 |
| `view/js/pagination.js` | 1191 | 39156 |
| `view/js/loadConfiguration.js` | 806 | 39105 |
| `view/dynamicTiles/dynamicTiles.js` | 977 | 38584 |
| `view/terminalConsole/lghn-terminalConsole.js` | 843 | 38167 |
| `view/js/positionStatus.js` | 669 | 38150 |
| `view/pppCorrections/pppCorrections.js` | 676 | 38060 |
| `view/positionConfig/lghn-positionConfig.html` | 562 | 37998 |
| `view/deviceUpdate/lghn-deviceUpdate.js` | 723 | 35738 |
| `view/dynamicTiles/packery.pkgd.min.js` | 13 | 33925 |
| `view/terminalConsole/giii-terminalConsole.js` | 701 | 32797 |
| `view/js/statusbar.js` | 568 | 32384 |
| `view/agcStatus/agcStatus.js` | 601 | 27101 |
| `view/js/portStatus.js` | 520 | 26955 |
| `view/updateApplication/updateApplication.js` | 704 | 26215 |
| `view/deviceDetails/deviceDetails.html` | 287 | 25338 |
| `view/js/deviceInfo.js` | 458 | 25000 |
| `view/js/saveConfiguration.js` | 636 | 24684 |
| `view/spanInstallation/spanInstallation.js` | 518 | 23944 |
| `view/js/tileMovement.js` | 547 | 23750 |
| `view/deviceUpdate/deviceUpdate.js` | 452 | 21597 |
| `view/playbackcontrol/playbackview.js` | 439 | 20485 |
| `view/js/markerclusterer.min.js` | 1 | 20355 |
| `view/autoUpdates/autoUpdates.js` | 427 | 20215 |
| `view/loggingConfig/loggingConfig.html` | 304 | 20113 |
| `view/genericConfig.js` | 428 | 18918 |
| `view/networkingSettings/networkingSettings.html` | 219 | 17228 |
| `view/deviceDetails/giii-deviceDetails.js` | 355 | 17100 |
| `view/deviceRestart/deviceRestart.js` | 349 | 16680 |
| `view/logStatus/logStatus.js` | 286 | 15004 |
| `view/gnssConfig/gnssConfig.js` | 305 | 14873 |
| `view/dynamicTiles/draggabilly.pkgd.min.js` | 26 | 12116 |
| `view/js/spanStatus.js` | 216 | 12056 |
| `view/interferenceToolKit/interferenceToolKit.html` | 271 | 10860 |
| `view/spanInstallation/spanInstallation.html` | 187 | 10683 |
| `view/radioConfig/radioConfig.html` | 152 | 10327 |
| `view/spanConfig/lghn-spanConfig.html` | 159 | 10071 |
| `view/loggingConfig/giii-loggingConfig.html` | 156 | 9913 |
| `view/js/alignStatus.js` | 157 | 9640 |
| `view/alignConfig/alignConfig.html` | 175 | 9634 |
| `view/satelliteTracking/giii-satelliteTracking.html` | 157 | 9276 |
| `view/satelliteTracking/satelliteTracking.html` | 156 | 9239 |
| `view/html/playback.html` | 199 | 9220 |
| `view/html/welcome.html` | 149 | 8532 |
| `view/statusBar/statusBar.html` | 126 | 8505 |
| `view/welcome/welcome.html` | 167 | 7848 |
| `view/events/events.html` | 142 | 7799 |
| `view/generalSettings/generalSettings.js` | 147 | 7284 |
| `view/positionStatus/giii-positionStatus.html` | 114 | 7160 |
| `view/satelliteView/satelliteView.html` | 194 | 6829 |
| `view/pppCorrections/pppCorrections.html` | 99 | 6069 |
| `view/deviceDetails/giii-deviceDetails.html` | 104 | 5928 |
| `view/positionStatus/positionStatus.html` | 90 | 5851 |
| `view/logStatus/giii-logStatus.js` | 123 | 5773 |
| `view/spanStatus/spanStatus.html` | 97 | 5688 |
| `view/height-sd/lghn-height-sd.html` | 163 | 5669 |
| `view/2d-sd/lghn-2d-sd.html` | 150 | 5494 |
| `view/positionStatus/lghn-positionStatus.html` | 97 | 5202 |
| `view/js/interferencestatus.js` | 96 | 5169 |
| `view/deviceInfo/deviceInfo.html` | 85 | 4939 |
| `view/menuBar/menuBar.html` | 78 | 4688 |
| `view/js/satelliteView.js` | 83 | 4289 |
| `view/js/tilesManagement.js` | 97 | 4251 |
| `view/js/radioStatus.js` | 76 | 3987 |
| `view/deviceExport/deviceExport.html` | 61 | 3484 |
| `view/deviceUpdate/lghn-deviceUpdate.html` | 61 | 3406 |
| `view/playbackcontrol/playbackcontrol.html` | 106 | 3205 |
| `view/terminalConsole/lghn-terminalConsole.html` | 49 | 2650 |
| `view/deviceUpdate/deviceUpdate.html` | 42 | 2244 |
| `view/logStatus/giii-logStatus.html` | 39 | 2206 |
| `view/logStatus/logStatus.html` | 39 | 2132 |
| `view/agcStatus/agcStatus.html` | 49 | 2095 |
| `view/alignStatus/alignStatus.html` | 41 | 2074 |
| `view/gnssConfig/gnssConfig.html` | 42 | 2041 |
| `view/terminalConsole/giii-terminalConsole.html` | 43 | 1901 |
| `view/terminalConsole/terminalConsole.html` | 39 | 1852 |
| `view/portStatus/portStatus.html` | 38 | 1848 |
| `view/deviceInfo/giii-deviceInfo.html` | 36 | 1710 |
| `view/deviceRestart/deviceRestart.html` | 32 | 1667 |
| `view/portConfig/portConfig.html` | 32 | 1562 |
| `view/generalSettings/generalSettings.html` | 30 | 1510 |
| `view/radioStatus/radioStatus.html` | 29 | 1317 |
| `view/interferenceStatus/interferenceStatus.html` | 29 | 1199 |
| `view/languageSettings/languageSettings.html` | 24 | 1127 |
| `view/deviceManagement/devicesInfo.json` | 56 | 1087 |
| `view/languageSettings/languageSettings.js` | 31 | 1023 |
| `view/portConfig/lghn-portConfig.html` | 21 | 921 |
| `view/displaysSettings/displaysSettings.html` | 20 | 918 |
| `view/displaysSettings/displaysSettings.js` | 26 | 856 |
| `view/loggingConfig/lghn-loggingConfig.html` | 15 | 779 |
| `view/html/splashScreen.html` | 20 | 508 |
| `view/html/position.html` | 1 | 13 |
| `view/dynamicTiles/dynamicTiles.html` | 1 | 0 |

## C. Convert  (4 文件, 0.26 MB)

| 文件 | 行 | 字节 |
|---|---:|---:|
| `view/convert/convert.js` | 3425 | 192338 |
| `view/convert/cli.js` | 984 | 43184 |
| `view/convert/convert.html` | 527 | 32900 |
| `view/convert/edieConvertAPI.js` | 53 | 1986 |

## E. GRIT Monitor  (199 文件, 2.75 MB)

| 文件 | 行 | 字节 |
|---|---:|---:|
| `view/GRIT/styles/images/luciad_images/darkMode_exit-fullscreen.png` | — | 442993 |
| `view/GRIT/styles/gritStyles.css` | 9032 | 224898 |
| `view/GRIT/js/spectrumPlot.js` | 3343 | 157182 |
| `view/GRIT/gritEvents/gritEvents.js` | 2770 | 151733 |
| `view/GRIT/positionOverview/positionOverview.js` | 2879 | 138559 |
| `view/GRIT/luciadPositionOverview/luciadPositionOverview.js` | 2654 | 119834 |
| `view/GRIT/mitigationAssistant/mitigationAssistant.js` | 2249 | 106792 |
| `view/GRIT/pointsOfInterest/luciad/listView.js` | 1915 | 100681 |
| `view/GRIT/pointsOfInterest/listView.js` | 1911 | 98844 |
| `view/GRIT/luciadPositionOverview/luciadMapLayer.js` | 2671 | 98818 |
| `view/GRIT/styles/images/Map/vehicleIcons/vehicleicons.png` |  | 83053 |
| `view/GRIT/gritJarvisInterface.js` | 1644 | 77537 |
| `view/GRIT/spectrumViewer/spectrumViewer.js` | 1549 | 75349 |
| `view/GRIT/addFilterPopup/addFilterPopup.js` | 1413 | 61264 |
| `view/GRIT/luciadPositionOverview/addPOIDialog.js` | 957 | 54486 |
| `view/GRIT/styles/images/displaySprite.png` |  | 53238 |
| `view/GRIT/gritStatusBar/gritStatusBar.js` | 906 | 50875 |
| `view/GRIT/positionOverview/addPOIDialog.js` | 885 | 50086 |
| `view/GRIT/signalMatrix/signalMatrix.js` | 890 | 39477 |
| `view/GRIT/livePlayback/livePlayback.js` | 845 | 34367 |
| `view/GRIT/triggers/luciad/triggers.js` | 591 | 33717 |
| `view/GRIT/triggers/triggers.js` | 591 | 33693 |
| `view/GRIT/js/gritLandingPage.js` | 879 | 32329 |
| `view/GRIT/js/luciad/gritLandingPage.js` | 691 | 28201 |
| `view/GRIT/luciadPositionOverview/renderer.js` | 815 | 28033 |
| `view/GRIT/gritMenuBar/gritMenuBar.js` | 490 | 24213 |
| `view/GRIT/livePlayback/liveplaybackview.js` | 456 | 20151 |
| `view/GRIT/luciadPositionOverview/luciadMapViewMapLayer.js` | 504 | 18030 |
| `view/GRIT/displaysSettings/luciad/displaysSettings.js` | 413 | 17712 |
| `view/GRIT/displaysSettings/displaysSettings.js` | 411 | 17553 |
| `view/GRIT/positionOverview/positionOverview.html` | 316 | 17126 |
| `view/GRIT/luciadPositionOverview/luciadPositionOverview.html` | 308 | 15401 |
| `view/GRIT/pointsOfInterest/luciad/pointsOfInterest.js` | 328 | 15394 |
| `view/GRIT/pointsOfInterest/pointsOfInterest.js` | 328 | 15386 |
| `view/GRIT/mapLayer.js` | 252 | 14641 |
| `view/GRIT/spoofingConfiguration/spoofingConfiguration.js` | 321 | 11713 |
| `view/GRIT/displaysSettings/displaysSettings.html` | 201 | 10994 |
| `view/GRIT/styles/images/Map/google_img_dark.png` |  | 9824 |
| `view/GRIT/styles/images/Map/google_img_light.png` |  | 9174 |
| `view/GRIT/spectrumViewer/spectrumViewer.html` | 141 | 9007 |
| `view/GRIT/luciadPositionOverview/ShapePainter.js` | 209 | 8434 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/fixed_wing.png` |  | 8333 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/dark/fixed_wing.png` |  | 8175 |
| `view/GRIT/gritEvents/gritEvents.html` | 143 | 8120 |
| `view/GRIT/luciadPositionOverview/LuciadZoomController.js` | 262 | 8104 |
| `view/GRIT/gritStatusBar/gritStatusBar.html` | 110 | 7159 |
| `view/GRIT/html/luciad/gritLandingPage.html` | 157 | 6986 |
| `view/GRIT/pointsOfInterest/luciad/pointsOfInterest.html` | 114 | 6852 |
| `view/GRIT/pointsOfInterest/pointsOfInterest.html` | 116 | 6811 |
| `view/GRIT/styles/images/grit_menu.png` |  | 6723 |
| `view/GRIT/html/gritLandingPage.html` | 150 | 6606 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/helicopter.png` |  | 6204 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/dark/helicopter.png` |  | 6108 |
| `view/GRIT/luciadPositionOverview/CustomCompassButton.js` | 112 | 4681 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/tractor.png` |  | 4639 |
| `view/GRIT/styles/images/grit_title.svg` |  | 4635 |
| `view/GRIT/styles/images/recent_grit_img.svg` |  | 4635 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/dark/tractor.png` |  | 4541 |
| `view/GRIT/signalMatrix/signalMatrix.html` | 92 | 4456 |
| `view/GRIT/luciadPositionOverview/CustomSelectController.js` | 101 | 4455 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/boat.png` |  | 4254 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/dark/boat.png` |  | 4185 |
| `view/GRIT/luciadPositionOverview/CustomClickController.js` | 92 | 3993 |
| `view/GRIT/gritMenuBar/gritMenuBar.html` | 59 | 3800 |
| `view/GRIT/mapSettings/mapSettings.js` | 100 | 3761 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/drone.png` |  | 3745 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/dark/drone.png` |  | 3678 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/train.png` |  | 3450 |
| `view/GRIT/styles/images/luciad_images/exit-fullscreen.png` |  | 3430 |
| `view/GRIT/spoofingConfiguration/spoofingConfiguration.html` | 72 | 3276 |
| `view/GRIT/luciadPositionOverview/MouseHoverController.js` | 93 | 3236 |
| `view/GRIT/luciadPositionOverview/CustomContextMenuController.js` | 84 | 2970 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/dark/train.png` |  | 2853 |
| `view/GRIT/styles/images/Map/POI/dark_manualPOI.svg` |  | 2764 |
| `view/GRIT/styles/images/Map/POI/unselectedManual.svg` |  | 2746 |
| `view/GRIT/styles/images/Map/POI/manualPOI.svg` |  | 2744 |
| `view/GRIT/styles/images/Map/triggers_sprite.png` |  | 2686 |
| `view/GRIT/luciadPositionOverview/gradientController.js` | 91 | 2674 |
| `view/GRIT/luciadPositionOverview/luciadStyles.js` | 162 | 2590 |
| `view/GRIT/markerCustomPopup.js` | 77 | 2516 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/van.png` |  | 2489 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/dark/van.png` |  | 2409 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/human.png` |  | 2231 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/dark/human.png` |  | 2168 |
| `view/GRIT/styles/images/Map/Orientation/dark_trackUp.svg` |  | 2145 |
| `view/GRIT/styles/images/Map/Orientation/trackUp.svg` |  | 2145 |
| `view/GRIT/styles/images/Map/dark_hoverAddIcon.svg` |  | 2094 |
| `view/GRIT/styles/images/Map/hoverAddIcon.svg` |  | 2094 |
| `view/GRIT/styles/images/Map/cluster.png` |  | 2060 |
| `view/GRIT/luciadPositionOverview/useMouseCoordinate.js` | 56 | 2051 |
| `view/GRIT/styles/images/Map/EventMarkers/errorResting.svg` |  | 2050 |
| `view/GRIT/styles/images/Map/compass.svg` |  | 2031 |
| `view/GRIT/styles/images/Map/hovercluster.png` |  | 2026 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/car.png` |  | 1746 |
| `view/GRIT/livePlayback/liveplaybackcontrol.html` | 66 | 1733 |
| `view/GRIT/styles/images/Map/darkmode_recenter_blue.svg` |  | 1722 |
| `view/GRIT/styles/images/Map/recenter_blue.svg` |  | 1722 |
| `view/GRIT/styles/images/Map/recenter.svg` |  | 1720 |
| `view/GRIT/styles/images/Map/Orientation/dark_northUp.svg` |  | 1712 |
| `view/GRIT/styles/images/Map/Orientation/northUp.svg` |  | 1712 |
| `view/GRIT/styles/images/Map/vehicleIcons/images/dark/car.png` |  | 1678 |
| `view/GRIT/styles/images/luciad_images/darkMode_fullScreen.svg` |  | 1636 |
| `view/GRIT/styles/images/luciad_images/fullScreen.svg` |  | 1619 |
| `view/GRIT/luciadPositionOverview/ZoomController.js` | 42 | 1604 |
| `view/GRIT/styles/images/vehicle_icon.png` |  | 1543 |
| `view/GRIT/styles/images/Map/EventMarkers/warningResting.svg` |  | 1516 |
| `view/GRIT/styles/images/darkMode/red_warning_icon.svg` |  | 1428 |
| `view/GRIT/styles/images/red_warning_icon.svg` |  | 1428 |
| `view/GRIT/styles/images/help_inactive.svg` |  | 1264 |
| `view/GRIT/styles/images/darkMode/help_active.svg` |  | 1260 |
| `view/GRIT/styles/images/help_active.svg` |  | 1260 |
| `view/GRIT/triggers/triggers.html` | 27 | 1243 |
| `view/GRIT/luciadPositionOverview/ClickController.js` | 34 | 1205 |
| `view/GRIT/styles/images/menubar_settings.svg` |  | 1066 |
| `view/GRIT/styles/images/darkMode/grit_logging_edit.svg` |  | 945 |
| `view/GRIT/styles/images/grit_logging_edit.svg` |  | 939 |
| `view/GRIT/styles/images/add-filter-hover.svg` |  | 937 |
| `view/GRIT/styles/images/darkMode/add-filter-hover.svg` |  | 935 |
| `view/GRIT/styles/images/luciad_images/currentLocation.svg` |  | 906 |
| `view/GRIT/styles/images/dashboard_iocn_dark.svg` |  | 875 |
| `view/GRIT/styles/images/luciad_images/darkMode-exit-full-screen.svg` |  | 856 |
| `view/GRIT/styles/images/luciad_images/exit-full-screen.svg` |  | 848 |
| `view/GRIT/styles/images/Map/darkmode_spoofing_close.svg` |  | 841 |
| `view/GRIT/styles/images/Map/spoofing_close.svg` |  | 829 |
| `view/GRIT/styles/images/Map/addIcon.svg` |  | 699 |
| `view/GRIT/styles/images/Map/dark_addIcon.svg` |  | 699 |
| `view/GRIT/styles/images/Map/markerHover.png` |  | 611 |
| `view/GRIT/luciadPositionOverview/src/luciadria_deployment.txt` | 14 | 610 |
| `view/GRIT/luciadPositionOverview/src/luciadria_development.txt` | 14 | 592 |
| `view/GRIT/styles/images/darkMode/darkMode_expand_arrow.svg` |  | 576 |
| `view/GRIT/styles/images/expand-arrow.svg` |  | 576 |
| `view/GRIT/styles/images/Map/darkFadedMarker.svg` |  | 559 |
| `view/GRIT/styles/images/Map/fadedMarker.svg` |  | 557 |
| `view/GRIT/mitigationAssistant/mitigationAssistant.html` | 19 | 535 |
| `view/GRIT/styles/images/checkyourposition_icon.svg` |  | 496 |
| `view/GRIT/styles/images/darkMode/darkMode_filter_not_applied.svg` |  | 490 |
| `view/GRIT/styles/images/no_filter_applied.svg` |  | 490 |
| `view/GRIT/styles/images/block_filter_icon.png` |  | 434 |
| `view/GRIT/styles/images/mitigation_error.png` |  | 405 |
| `view/GRIT/styles/images/darkMode/darkMode_settings_icon.svg` |  | 395 |
| `view/GRIT/styles/images/settings-icon.svg` |  | 395 |
| `view/GRIT/styles/images/dashboard_iocn_inactive.png` |  | 389 |
| `view/GRIT/styles/images/darkMode/darkMode_filter_applied.svg` |  | 376 |
| `view/GRIT/styles/images/dashboard_iocn.png` |  | 376 |
| `view/GRIT/styles/images/darkMode/icon_add_location.svg` |  | 370 |
| `view/GRIT/luciadPositionOverview/src/license-loader.js` | 7 | 365 |
| `view/GRIT/styles/images/darkMode/drakMode_location_pin.svg` |  | 365 |
| `view/GRIT/styles/images/NotchFilter.svg` |  | 365 |
| `view/GRIT/styles/images/darkMode/icon_add_location_darkmode.svg` |  | 364 |
| `view/GRIT/styles/images/filter_applied.svg` |  | 362 |
| `view/GRIT/styles/images/amberWarning.png` |  | 359 |
| `view/GRIT/styles/images/icon_add_location.svg` |  | 355 |
| `view/GRIT/styles/images/black_alert_icon.svg` |  | 325 |
| `view/GRIT/styles/images/squiggly.png` |  | 316 |
| `view/GRIT/styles/images/checkjamming_icon.png` |  | 309 |
| `view/GRIT/styles/images/Map/lastPage.svg` |  | 309 |
| `view/GRIT/styles/images/Map/location_selected.png` |  | 306 |
| `view/GRIT/styles/images/Map/rxMarker.png` |  | 304 |
| `view/GRIT/styles/images/Map/darkmodeLastPage.svg` |  | 289 |
| `view/GRIT/styles/images/darkmode_filter.svg` |  | 281 |
| `view/GRIT/styles/images/tick.svg` |  | 279 |
| `view/GRIT/styles/images/darkMode/itk-add.svg` |  | 267 |
| `view/GRIT/styles/images/darkMode/darkMode_resetPlot.svg` |  | 266 |
| `view/GRIT/styles/images/itk-add.svg` |  | 265 |
| `view/GRIT/styles/images/darkMode/darkMode_Vector.svg` |  | 262 |
| `view/GRIT/styles/images/darkMode/resetPlot_dark.svg` |  | 259 |
| `view/GRIT/styles/images/darkMode/back-to-overview-btn.svg` |  | 258 |
| `view/GRIT/styles/images/resetPlot.svg` |  | 257 |
| `view/GRIT/styles/images/BandPassFilter.svg` |  | 255 |
| `view/GRIT/styles/images/Vector.svg` |  | 254 |
| `view/GRIT/styles/images/darkMode/grit_delete_icon.svg` |  | 252 |
| `view/GRIT/styles/images/darkMode/grit_delete_all_icon.svg` |  | 248 |
| `view/GRIT/styles/images/grit_delete_all_icon.svg` |  | 246 |
| `view/GRIT/styles/images/grit_delete_icon.svg` |  | 246 |
| `view/GRIT/styles/images/back-to-overview-btn.svg` |  | 244 |
| `view/GRIT/styles/images/luciad_images/darkMode_ic_zoom_in.svg` |  | 243 |
| `view/GRIT/styles/images/interference_alert.svg` |  | 238 |
| `view/GRIT/styles/images/resetPlot_active.svg` |  | 237 |
| `view/GRIT/styles/images/dark_history_location.svg` |  | 223 |
| `view/GRIT/styles/images/history_location.svg` |  | 223 |
| `view/GRIT/styles/images/Map/POI/dark_markPVAIcon.svg` |  | 212 |
| `view/GRIT/styles/images/luciad_images/ic_zoom_in.svg` |  | 209 |
| `view/GRIT/styles/images/Map/POI/dark_markPOSIcon.svg` |  | 207 |
| `view/GRIT/styles/images/filter_icon.png` |  | 195 |
| `view/GRIT/styles/images/Map/POI/unselectedMarkPVAIcon.svg` |  | 194 |
| `view/GRIT/styles/images/Map/POI/markPVAIcon.svg` |  | 192 |
| `view/GRIT/styles/images/Map/POI/unselectedMarkPOSIcon.svg` |  | 189 |
| `view/GRIT/styles/images/Map/POI/markPOSIcon.svg` |  | 187 |
| `view/GRIT/networkingSettings/networkingSettings.js` | 12 | 179 |
| `view/GRIT/styles/images/luciad_images/darkMode_separator.svg` |  | 171 |
| `view/GRIT/styles/images/luciad_images/separator.svg` |  | 171 |
| `view/GRIT/styles/images/interference_oval.svg` |  | 166 |
| `view/GRIT/styles/images/luciad_images/darkMode_ic_zoom_out.svg` |  | 166 |
| `view/GRIT/styles/images/Map/circle.svg` |  | 160 |
| `view/GRIT/styles/images/Map/dark_circle.svg` |  | 160 |
| `view/GRIT/styles/images/luciad_images/ic_zoom_out.svg` |  | 149 |
| `view/GRIT/networkingSettings/networkingSettings.html` | 3 | 94 |
| `view/GRIT/spoofing/spoofing.html` | 1 | 0 |
| `view/GRIT/spoofing/spoofing.js` | 1 | 0 |

## G. 帮助文档(内嵌)  (3 文件, 1.26 MB)

| 文件 | 行 | 字节 |
|---|---:|---:|
| `view/GRIT/helpFile/helpFile.html` | 10220 | 680486 |
| `view/GRIT/helpFile/noMapHelpFile.html` | 9587 | 637759 |
| `view/GRIT/helpFile/helpFile.js` | 24 | 780 |

## H. 国际化  (10 文件, 0.78 MB)

| 文件 | 行 | 字节 |
|---|---:|---:|
| `view/languageSupport/ru.js` | 1758 | 124452 |
| `view/languageSupport/eg.js` | 1864 | 118130 |
| `view/languageSupport/fr.js` | 1863 | 102119 |
| `view/languageSupport/es.js` | 1864 | 98746 |
| `view/languageSupport/pt.js` | 1864 | 98743 |
| `view/languageSupport/de.js` | 1864 | 98318 |
| `view/languageSupport/en.js` | 1924 | 92949 |
| `view/languageSupport/cn.js` | 1864 | 86789 |
| `view/languageSupport/languageSettings.json` | 31 | 702 |
| `view/json/genericview.js` | 18 | 353 |

## I. 静态资源  (612 文件, 14.00 MB)

| 文件 | 行 | 字节 |
|---|---:|---:|
| `view/images/Hexagon_A&P_NovAtel.png` | — | 815345 |
| `view/css/style.css` | 30624 | 772926 |
| `view/images/feedbackpopup.svg` | — | 720584 |
| `view/images/Resources/Images/Graph/MapView.png` | — | 639257 |
| `view/images/sats-sprite.png` | — | 585904 |
| `view/images/Resources/Images/Graph/ProcessedMapRoads.png` | — | 556589 |
| `view/css/jquery-ui-1.12.1/jquery-ui.js` | 18706 | 539419 |
| `view/images/advertisement/2017-Novatel-SectionHeadImages-CorrServices.png` | — | 463422 |
| `view/images/advertisement/AG-Home-Page-Banner.png` | — | 359568 |
| `view/images/advertisement/NovAtel7011-SM-NovAtelHomepageBanner-SPANLand.png` | — | 353748 |
| `view/css/jquery-ui-1.12.1/external/jquery/jquery.js` | 11009 | 304438 |
| `view/css/jquery.js` | 10599 | 290962 |
| `view/css/jquery-ui-1.12.1/jquery-ui.min.js` | 13 | 253681 |
| `view/fonts/OpenSans-Bold.ttf` | — | 224452 |
| `view/fonts/OpenSans-Light.ttf` | — | 222236 |
| `view/fonts/OpenSans-SemiBold.ttf` | — | 221164 |
| `view/fonts/OpenSans-Regular.ttf` | — | 217276 |
| `view/images/GraphingLogo.png` | — | 214675 |
| `view/fonts/OpenSans-LightItalic.ttf` | — | 213024 |
| `view/fonts/OpenSans-Italic.ttf` | — | 212760 |
| `view/images/advertisement/Hexagon_AP_NovAtel_Waypoint_Training_1.png` |  | 196533 |
| `view/images/advertisement/ros.png` |  | 192173 |
| `view/images/aboutPopup.svg` |  | 178031 |
| `view/images/WAAS-GIII.png` |  | 176352 |
| `view/images/loader.gif` |  | 174994 |
| `view/images/advertisement/HxGNLiveAppSuite.png` |  | 169524 |
| `view/fonts/Roboto-Regular.ttf` |  | 168260 |
| `view/images/splashScreen.png` |  | 166876 |
| `view/images/darkMode/splashScreen.png` |  | 164877 |
| `view/images/advertisement/info.png` |  | 164389 |
| `view/images/advertisement/05waypoint.png` |  | 159005 |
| `view/css/bootstrap.min.css` | 7 | 155764 |
| `view/images/advertisement/01HA_Firmware_Release.png` |  | 143066 |
| `view/images/SplashScreen1.png` |  | 138749 |
| `view/images/advertisement/waypoint.png` |  | 130538 |
| `view/images/advertisement/01scintillation.png` |  | 129664 |
| `view/images/advertisement/scintillation.png` |  | 129664 |
| `view/images/advertisement/WaypointtrainingAppSuite.png` |  | 124726 |
| `view/images/advertisement/02TerraStar_CorrectionServicesAd.png` |  | 120301 |
| `view/images/advertisement/TerraStar_CorrectionServicesAd.png` |  | 120301 |
| `view/images/advertisement/01Firmware_Release_7.10.02.png` |  | 116210 |
| `view/images/Resources/Images/Graph/GraphTwoLevelSelection.png` |  | 97795 |
| `view/images/advertisement/04Graph.png` |  | 91037 |
| `view/images/Resources/Images/Graph/PositionSD_AllStreams.png` |  | 84677 |
| `view/fonts/Akkurat.ttf` |  | 78320 |
| `view/images/spanOffsetSetup.png` |  | 62762 |
| `view/images/tabicon.ico` |  | 60308 |
| `view/css/bootstrap.min.js` | 7 | 58078 |
| `view/images/advertisement/edie_promo.jpg` |  | 57723 |
| `view/images/advertisement/wingsuit.gif` |  | 57669 |
| `view/images/Resources/Images/Graph/ProjectWizard.png` |  | 53082 |
| `view/images/Resources/Images/Graph/GetStarted.png` |  | 52987 |
| `view/images/advertisement/velocity.jpg` |  | 52061 |
| `view/images/spanInstallation/spanSprite.png` |  | 50947 |
| `view/images/advertisement/Firmware.jpg` |  | 48687 |
| `view/images/advertisement/Hexagon_AP_NovAtel_Waypoint_Training_2.png` |  | 48362 |
| `view/images/advertisement/03connected.jpg` |  | 47985 |
| `view/images/advertisement/connected.jpg` |  | 47985 |
| `view/images/Resources/Images/Graph/ProjectWizardValidate.png` |  | 47250 |
| `view/images/NAS_logo.ico` |  | 45746 |
| `view/images/Resources/Images/Graph/PositionSD_OneStream.png` |  | 45604 |
| `view/images/spanSetup.png` |  | 43944 |
| `view/images/exclamation_mark.png` |  | 41370 |
| `view/images/Resources/Images/Graph/ExportData.png` |  | 39157 |
| `view/css/jquery-ui-1.12.1/jquery-ui.css` | 1313 | 38638 |
| `view/images/spanImuSetup.png` |  | 38361 |
| `view/images/spanOffsetMbl.png` |  | 36301 |
| `view/images/advertisement/Ad_test.jpg` |  | 36055 |
| `view/css/jquery-ui-1.12.1/index.html` | 560 | 33147 |
| `view/images/darkMode/sprite_darkmode.png` |  | 32522 |
| `view/css/jquery-ui-1.12.1/jquery-ui.min.css` | 7 | 32082 |
| `view/images/Resources/Images/Graph/FlagBox.png` |  | 31982 |
| `view/images/Resources/Images/Graph/ProjectWizardInfo.png` |  | 31544 |
| `view/images/spanImuMbl.png` |  | 27815 |
| `view/images/lghn_span.png` |  | 27005 |
| `view/images/Resources/Images/Graph/ProjectWizardData.png` |  | 26985 |
| `view/images/darkMode/sm_welcome.svg` |  | 26571 |
| `view/images/sm_welcome.svg` |  | 26553 |
| `view/images/advertisement/DPP.jpg` |  | 25889 |
| `view/images/Resources/Images/Graph/FlagTrashBox.png` |  | 23731 |
| `view/images/splashscreen2.png` |  | 23011 |
| `view/images/Resources/Images/Graph/PlaybackControls.png` |  | 22718 |
| `view/images/advertisement/DYP.jpg` |  | 22146 |
| `view/images/spanInstallation/car-van.png` |  | 21161 |
| `view/images/Resources/Images/Graph/EditStartEndTime.png` |  | 20425 |
| `view/images/spanInstallation/boat-drown.png` |  | 19662 |
| `view/css/jquery-ui-1.12.1/jquery-ui.structure.css` | 887 | 19591 |
| `view/images/darkMode/spanInstallation/droneTop.png` |  | 19509 |
| `view/images/spanInstallation/marPakSpanSprites.png` |  | 19294 |
| `view/css/jquery-ui-1.12.1/jquery-ui.theme.css` | 444 | 19114 |
| `view/images/spanInstallation/droneTop.png` |  | 17880 |
| `view/images/Resources/Images/Graph/TimeLineBar_Overview.png` |  | 16207 |
| `view/images/Resources/Images/Hexagon_Novatel_LOGO.png` |  | 15982 |
| `view/css/jquery-ui-1.12.1/jquery-ui.structure.min.css` | 5 | 15552 |
| `view/images/app_branding.png` |  | 15137 |
| `view/images/banner.png` |  | 15124 |
| `view/images/darkmode_addapp_postprocessing.svg` |  | 15014 |
| `view/images/addapp_postprocessing.svg` |  | 14974 |
| `view/images/darkMode/pl_welcome.svg` |  | 14511 |
| `view/images/pl_welcome.svg` |  | 14503 |
| `view/images/Resources/Images/Graph/EditFlagBox.png` |  | 14134 |
| `view/css/jquery-ui-1.12.1/jquery-ui.theme.min.css` | 5 | 13853 |
| `view/images/Resources/Images/Graph/AddFlagMapView.png` |  | 13686 |
| `view/css/jquery-ui-1.12.1/AUTHORS.txt` | 334 | 12993 |
| `view/images/advertisement/download.jpeg` |  | 12675 |
| `view/images/spanInstallation/tractor-views.png` |  | 12159 |
| `view/images/warning.png` |  | 12067 |
| `view/images/recent_sm_img.svg` |  | 10682 |
| `view/images/darkMode/recent_sm_img.svg` |  | 10681 |
| `view/images/spanInstallation/helicopterTop.png` |  | 9574 |
| `view/images/spanInstallation/tractorSide.png` |  | 9539 |
| `view/images/sprite.png` |  | 9498 |
| `view/images/Resources/Images/Graph/FlagInfoPlayback.png` |  | 9152 |
| `view/images/darkMode/spanInstallation/fixedwingTop.png` |  | 8911 |
| `view/images/app_menu_active.svg` |  | 8795 |
| `view/images/darkMode/spanInstallation/helicopterTop.png` |  | 8795 |
| `view/images/recent_convert_img.svg` |  | 8713 |
| `view/images/Resources/Images/Graph/FlagMapView.png` |  | 8703 |
| `view/images/darkMode/spanInstallation/vanSide.png` |  | 8659 |
| `view/images/sm_menu.svg` |  | 8632 |
| `view/images/darkMode/recent_convert_img.svg` |  | 8583 |
| `view/images/darkMode/spanInstallation/tractorSide.png` |  | 8512 |
| `view/css/pagination.css` | 1 | 8367 |
| `view/images/spanInstallation/fixedwingTop.png` |  | 8314 |
| `view/images/spanInstallation/vanSide.png` |  | 8039 |
| `view/images/darkMode/spanInstallation/IMUViews/droneTop.png` |  | 7230 |
| `view/css/jquery-ui-1.12.1/images/ui-icons_555555_256x240.png` |  | 7074 |
| `view/images/spinner.svg` |  | 7050 |
| `view/css/jquery-ui-1.12.1/images/ui-icons_777777_256x240.png` |  | 7013 |
| `view/css/jquery-ui-1.12.1/images/ui-icons_444444_256x240.png` |  | 7006 |
| `view/images/Positioning_logo.png` |  | 6884 |
| `view/images/darkMode/app_branding.png` |  | 6816 |
| `view/images/darkMode/spanInstallation/carTop.png` |  | 6656 |
| `view/images/spanInstallation/IMUViews/droneTop.png` |  | 6547 |
| `view/images/settings_active.svg` |  | 6440 |
| `view/images/app_settings.svg` |  | 6373 |
| `view/css/jquery-ui-1.12.1/images/ui-icons_ffffff_256x240.png` |  | 6313 |
| `view/images/darkMode/spanInstallation/boatSide.png` |  | 6292 |
| `view/images/new_converticon.png` |  | 6086 |
| `view/images/darkMode/spanInstallation/carSide.png` |  | 6074 |
| `view/images/spanInstallation/boatSide.png` |  | 5860 |
| `view/images/darkMode/spanInstallation/IMUViews/carTop.png` |  | 5754 |
| `view/images/spanInstallation/helicopterSide.png` |  | 5694 |
| `view/images/darkMode/recent_pb_img.svg` |  | 5545 |
| `view/images/darkMode/spanInstallation/helicopterSide.png` |  | 5542 |
| `view/images/recent_pb_img.svg` |  | 5525 |
| `view/images/car_top.png` |  | 5381 |
| `view/images/darkMode/spanInstallation/vanTop.png` |  | 5340 |
| `view/images/darkMode/spanInstallation/boatTop.png` |  | 5235 |
| `view/images/darkMode/spanInstallation/IMUViews/carSide.png` |  | 5172 |
| `view/images/convert_menu.png` |  | 5138 |
| `view/images/spanInstallation/vanTop.png` |  | 5032 |
| `view/images/darkMode/NAS_logo.png` |  | 5018 |
| `view/images/new_s&micon.png` |  | 4972 |
| `view/images/new_playbackicon.png` |  | 4905 |
| `view/images/sm_title.png` |  | 4897 |
| `view/images/darkMode/spanInstallation/tractorTop.png` |  | 4895 |
| `view/images/darkMode/spanInstallation/trainSide.png` |  | 4807 |
| `view/images/spanInstallation/boatTop.png` |  | 4796 |
| `view/images/car_side.png` |  | 4756 |
| `view/css/jquery-ui-1.12.1/images/ui-icons_777620_256x240.png` |  | 4676 |
| `view/css/jquery-ui-1.12.1/images/ui-icons_cc0000_256x240.png` |  | 4632 |
| `view/images/spanInstallation/tractorTop.png` |  | 4592 |
| `view/images/darkMode/spanInstallation/IMUViews/fixedwingTop.png` |  | 4461 |
| `view/images/darkMode/spanInstallation/IMUViews/vanSide.png` |  | 4358 |
| `view/images/darkMode/spanInstallation/IMUViews/helicopterTop.png` |  | 4305 |
| `view/images/spanInstallation/IMUViews/fixedwingTop.png` |  | 4217 |
| `view/images/darkMode/spanInstallation/IMUViews/boatSide.png` |  | 4202 |
| `view/images/spanInstallation/IMUViews/Fill 1.png` |  | 4159 |
| `view/images/spanInstallation/IMUViews/helicopterTop.png` |  | 4159 |
| `view/images/white-arrow.png` |  | 4058 |
| `view/images/spanInstallation/IMUViews/vanSide.png` |  | 4046 |
| `view/images/convert_title.svg` |  | 3987 |
| `view/images/header-desktop.png` |  | 3974 |
| `view/images/spanInstallation/IMUViews/boatSide.png` |  | 3792 |
| `view/images/PostProcessing_mini_icon.svg` |  | 3736 |
| `view/images/playback/replay.svg` |  | 3703 |
| `view/images/darkMode/spanInstallation/humanSide.png` |  | 3694 |
| `view/images/HxGN_Logo.png` |  | 3664 |
| `view/images/spanInstallation/carTop.png` |  | 3636 |
| `view/images/spanInstallation/IMUViews/carTop.png` |  | 3636 |
| `view/images/spanInstallation/humanSide.png` |  | 3565 |
| `view/images/darkMode/spanInstallation/fixedwingSide.png` |  | 3545 |
| `view/images/playback/rewind30.svg` |  | 3521 |
| `view/images/playback/collapsed_replay.svg` |  | 3520 |
| `view/images/updateError.svg` |  | 3515 |
| `view/images/error_icon.svg` |  | 3508 |
| `view/images/exclamation.svg` |  | 3507 |
| `view/images/darkMode/spanInstallation/IMUViews/trainSide.png` |  | 3462 |
| `view/images/spanInstallation/IMUViews/tractorSide.png` |  | 3461 |
| `view/images/add_folder.svg` |  | 3386 |
| `view/images/spanInstallation/carSide.png` |  | 3352 |
| `view/images/spanInstallation/IMUViews/carSide.png` |  | 3352 |
| `view/images/darkMode/spanInstallation/IMUViews/boatTop.png` |  | 3323 |
| `view/images/Resources/Images/Graph/PositionMarker.png` |  | 3321 |
| `view/images/darkMode/spanInstallation/IMUViews/tractorSide.png` |  | 3281 |
| `view/images/darkMode/home_menu.svg` |  | 3267 |
| `view/images/home_menu.svg` |  | 3250 |
| `view/images/events_blue.svg` |  | 3248 |
| `view/images/playback/errorIcon.svg` |  | 3242 |
| `view/images/spanInstallation/fixedwingSide.png` |  | 3223 |
| `view/images/convert-var-convrt-frmt1.svg` |  | 3140 |
| `view/images/spanInstallation/IMUViews/trainSide.png` |  | 3139 |
| `view/images/spanInstallation/trainSide.png` |  | 3139 |
| `view/images/convert-var-convrt-frmt.svg` |  | 3121 |
| `view/images/header.png` |  | 3088 |
| `view/images/spanInstallation/IMUViews/boatTop.png` |  | 3086 |
| `view/images/pl_menu.png` |  | 3062 |
| `view/images/recent_pb_img.png` |  | 3062 |
| `view/images/icon_plus.png` |  | 3046 |
| `view/images/darkMode/spanInstallation/droneSide.png` |  | 3018 |
| `view/images/feedback_receiver_configuration.svg` |  | 2960 |
| `view/images/darkMode/spanInstallation/trainTop.png` |  | 2939 |
| `view/images/darkMode/spanInstallation/IMUViews/helicopterSide.png` |  | 2921 |
| `view/images/spanInstallation/droneSide.png` |  | 2840 |
| `view/css/jquery.mousewheel.min.js` | 8 | 2778 |
| `view/images/darkMode/spanInstallation/IMUViews/vanTop.png` |  | 2773 |
| `view/images/normal_poor_u237.svg` |  | 2767 |
| `view/images/selected_poor_u237_selected.svg` |  | 2734 |
| `view/images/help_active.svg` |  | 2719 |
| `view/images/Resources/Images/Graph/CompassIcon.png` |  | 2715 |
| `view/images/normal_good_u235.svg` |  | 2681 |
| `view/images/spanInstallation/IMUViews/helicopterSide.png` |  | 2655 |
| `view/images/selected_good_u235_selected.svg` |  | 2648 |
| `view/images/darkMode/events-delete.svg` |  | 2633 |
| `view/images/events-delete.svg` |  | 2631 |
| `view/images/imu_setup_top_compass.svg` |  | 2593 |
| `view/images/pl_title.png` |  | 2582 |
| `view/images/imu_setup_front_compass.svg` |  | 2577 |
| `view/images/imu_setup_side_compass.svg` |  | 2575 |
| `view/images/spanInstallation/IMUViews/vanTop.png` |  | 2523 |
| `view/images/tile_drag.svg` |  | 2523 |
| `view/images/darkMode/spanInstallation/IMUViews/carFront.png` |  | 2482 |
| `view/images/darkMode/sw_update_tick.svg` |  | 2425 |
| `view/images/sw_update_tick.svg` |  | 2425 |
| `view/images/darkMode/spanInstallation/IMUViews/trainTop.png` |  | 2424 |
| `view/images/normal_ok_u236.svg` |  | 2390 |
| `view/images/selected_ok_u236_selected.svg` |  | 2357 |
| `view/images/car_front.png` |  | 2319 |
| `view/images/spanInstallation/carFront.png` |  | 2319 |
| `view/images/darkMode/feedback_receiver_configuration.svg` |  | 2318 |
| `view/images/darkMode/ic_settings_24px.svg` |  | 2308 |
| `view/images/darkMode/settings.svg` |  | 2306 |
| `view/images/config-settings.svg` |  | 2305 |
| `view/images/darkMode/config-settings.svg` |  | 2302 |
| `view/images/feedback_receiver_configuration1.svg` |  | 2301 |
| `view/images/itk/settings.svg` |  | 2296 |
| `view/images/close_SW_Update.svg` |  | 2280 |
| `view/images/checkbox_active.svg` |  | 2215 |
| `view/images/checkbox_inactive.svg` |  | 2215 |
| `view/images/spanInstallation/IMUViews/trainTop.png` |  | 2213 |
| `view/images/spanInstallation/trainTop.png` |  | 2213 |
| `view/images/darkMode/spanInstallation/cursor_drag.svg` |  | 2203 |
| `view/images/Resources/Images/Graph/ButtonForward30.png` |  | 2202 |
| `view/images/spanInstallation/cursor_drag.svg` |  | 2186 |
| `view/images/new_nas_icon.png` |  | 2175 |
| `view/images/events-active-box.svg` |  | 2145 |
| `view/images/itk/close.svg` |  | 2137 |
| `view/images/dialog_close.svg` |  | 2131 |
| `view/images/normal_u249.svg` |  | 2131 |
| `view/images/playback/close.svg` |  | 2131 |
| `view/images/events-close.svg` |  | 2130 |
| `view/images/Resources/Images/Graph/HomeIcon.png` |  | 2118 |
| `view/images/darkMode/spanInstallation/IMUViews/boatFront.png` |  | 2094 |
| `view/images/Resources/Images/Graph/CenterMapButton.png` |  | 2069 |
| `view/images/darkMode/spanInstallation/IMUViews/tractorTop.png` |  | 2024 |
| `view/images/darkMode/events-save.svg` |  | 1983 |
| `view/images/events-save.svg` |  | 1981 |
| `view/images/darkMode/spanInstallation/IMUViews/fixedwingFront.png` |  | 1967 |
| `view/images/Resources/Images/Graph/ButtonHideGraph.png` |  | 1967 |
| `view/images/spanInstallation/IMUViews/boatFront.png` |  | 1932 |
| `view/images/playback/collapsed_pause.svg` |  | 1931 |
| `view/images/Resources/Images/Graph/ShowFlagButton.png` |  | 1925 |
| `view/images/Resources/Images/Graph/RestoreFlagButton.png` |  | 1922 |
| `view/css/jquery-ui-1.12.1/package.json` | 75 | 1921 |
| `view/images/Resources/Images/Graph/HideFlagButton.png` |  | 1913 |
| `view/images/Resources/Images/Graph/PlusSignOutline.png` |  | 1907 |
| `view/images/Resources/Images/Graph/Button_Flags.png` |  | 1903 |
| `view/images/darkMode/feedback_snip_file.svg` |  | 1900 |
| `view/images/Resources/Images/Graph/CompassIcon_41x41.png` |  | 1897 |
| `view/images/feedback_snip_file1.svg` |  | 1883 |
| `view/images/darkMode/spanInstallation/IMUViews/fixedwingSide.png` |  | 1881 |
| `view/images/Resources/Images/Graph/ButtonMenu.png` |  | 1879 |
| `view/css/jquery-ui-1.12.1/LICENSE.txt` | 44 | 1860 |
| `view/images/darkMode/spanInstallation/IMUViews/vanFront.png` |  | 1858 |
| `view/images/spanInstallation/IMUViews/carFront.png` |  | 1851 |
| `view/images/spanInstallation/IMUViews/tractorTop.png` |  | 1836 |
| `view/images/connectionlost_alert.svg` |  | 1819 |
| `view/images/Resources/Images/Graph/ButtonsZoomIn.png` |  | 1802 |
| `view/images/darkMode/spanInstallation/IMUViews/helicopterFront.png` |  | 1785 |
| `view/images/spanInstallation/IMUViews/fixedwingFront.png` |  | 1784 |
| `view/images/Resources/Images/Graph/ButtonResetZoom.png` |  | 1779 |
| `view/images/Resources/Images/Graph/ButtonZoomOut.png` |  | 1767 |
| `view/images/tab_close.svg` |  | 1754 |
| `view/images/darkMode/spanInstallation/humanTop.png` |  | 1741 |
| `view/images/terraStar_No_Internet.svg` |  | 1741 |
| `view/images/darkMode/wifi_lock.svg` |  | 1732 |
| `view/images/wifi_lock.svg` |  | 1722 |
| `view/images/spanInstallation/IMUViews/vanFront.png` |  | 1721 |
| `view/images/spanInstallation/IMUViews/fixedwingSide.png` |  | 1717 |
| `view/images/success-check.svg` |  | 1699 |
| `view/images/spanInstallation/IMUViews/helicopterFront.png` |  | 1669 |
| `view/images/Resources/Images/Graph/WarningMarker.png` |  | 1666 |
| `view/images/block.png` |  | 1645 |
| `view/images/Resources/Images/Graph/ButtonResizeTile.png` |  | 1644 |
| `view/images/spanInstallation/humanTop.png` |  | 1635 |
| `view/images/spanInstallation/userAnt.png` |  | 1624 |
| `view/images/events-dismiss.svg` |  | 1621 |
| `view/images/Resources/Images/Graph/ZoomInButton.png` |  | 1591 |
| `view/images/darkMode/feedback_sentiment_dissatisfied.svg` |  | 1588 |
| `view/images/darkMode/feedback_sentiment_dissatisfied.txt` | 9 | 1588 |
| `view/images/Resources/Images/Graph/PlusSignSolid.png` |  | 1584 |
| `view/images/Resources/Images/Graph/ResetZoom.png` |  | 1582 |
| `view/images/darkMode/feedback_sentiment_dissatisfied_selected.svg` |  | 1581 |
| `view/images/feedback_sentiment_dissatisfied.svg` |  | 1571 |
| `view/images/feedback_sentiment_dissatisfied_selected.svg` |  | 1571 |
| `view/images/darkMode/feedback_sentiment_satisfied.svg` |  | 1563 |
| `view/images/darkMode/feedback_sentiment_satisfied_selected.svg` |  | 1556 |
| `view/images/spanInstallation/IMUViews/largevesselSide.png` |  | 1550 |
| `view/images/spanInstallation/largevesselSide.png` |  | 1550 |
| `view/images/feedback_sentiment_satisfied.svg` |  | 1546 |
| `view/images/feedback_sentiment_satisfied_selected.svg` |  | 1546 |
| `view/images/darkMode/spanInstallation/IMUViews/tractorFront.png` |  | 1528 |
| `view/images/darkMode/spanInstallation/IMUViews/humanFront.png` |  | 1522 |
| `view/images/darkMode/spanInstallation/IMUViews/trainFront.png` |  | 1499 |
| `view/images/IMU_Pitch.svg` |  | 1497 |
| `view/images/deviceManager/connection_sprite.png` |  | 1496 |
| `view/images/softwareUpdateLogo.png` |  | 1465 |
| `view/images/Resources/Images/Graph/ZoomOutButton.png` |  | 1456 |
| `view/images/darkMode/spinner.svg` |  | 1445 |
| `view/images/spanInstallation/IMUViews/humanFront.png` |  | 1437 |
| `view/images/deviceManager/spinner.svg` |  | 1435 |
| `view/images/icon_folder.png` |  | 1432 |
| `view/images/darkMode/feedback_sentiment_excited.svg` |  | 1430 |
| `view/images/darkMode/spanInstallation/IMUViews/droneFront.png` |  | 1430 |
| `view/images/darkMode/feedback_sentiment_excited_selected.svg` |  | 1423 |
| `view/images/darkMode/settings_arrow.svg` |  | 1423 |
| `view/images/darkMode/feedback_sentiment_neutral.svg` |  | 1420 |
| `view/images/slider.png` |  | 1419 |
| `view/images/darkMode/spanInstallation/userAnt.png` |  | 1418 |
| `view/images/darkMode/feedback_sentiment_neutral_selected.svg` |  | 1413 |
| `view/images/feedback_sentiment_excited.svg` |  | 1413 |
| `view/images/feedback_sentiment_excited_selected.svg` |  | 1413 |
| `view/images/darkMode/spanInstallation/IMUViews/droneSide.png` |  | 1408 |
| `view/images/events-arrow.svg` |  | 1406 |
| `view/images/itk/settings_arrow.svg` |  | 1406 |
| `view/images/feedback_sentiment_neutral.svg` |  | 1403 |
| `view/images/feedback_sentiment_neutral_selected.svg` |  | 1403 |
| `view/images/spanInstallation/IMUViews/tractorFront.png` |  | 1399 |
| `view/images/spanInstallation/tractorFront.png` |  | 1399 |
| `view/images/spanInstallation/IMUViews/trainFront.png` |  | 1383 |
| `view/images/darkMode/spanInstallation/IMUViews/humanSide.png` |  | 1379 |
| `view/images/add_tab_plus.svg` |  | 1377 |
| `view/images/darkMode/wifi_disconnect.svg` |  | 1365 |
| `view/images/wifi_disconnect.svg` |  | 1355 |
| `view/images/darkMode/events-filter.svg` |  | 1348 |
| `view/images/events-filter.svg` |  | 1346 |
| `view/images/arrow.svg` |  | 1334 |
| `view/images/darkMode/spanInstallation/right.png` |  | 1311 |
| `view/images/spanInstallation/IMUViews/droneFront.png` |  | 1308 |
| `view/images/spanInstallation/humanSide1.png` |  | 1286 |
| `view/images/spanInstallation/IMUViews/humanSide.png` |  | 1286 |
| `view/images/darkMode/spanInstallation/down.png` |  | 1256 |
| `view/images/app_help.svg` |  | 1251 |
| `view/images/spanInstallation/droneFrontSmall.png` |  | 1250 |
| `view/images/spanInstallation/droneSideSmall.png` |  | 1250 |
| `view/images/spanInstallation/IMUViews/droneSide.png` |  | 1250 |
| `view/images/darkMode/share.svg` |  | 1245 |
| `view/images/darkMode/spanInstallation/front.png` |  | 1242 |
| `view/images/itk/share.svg` |  | 1235 |
| `view/images/darkMode/connect.svg` |  | 1220 |
| `view/images/deviceManager/connect.svg` |  | 1218 |
| `view/images/darkMode/spanInstallation/imu.png` |  | 1207 |
| `view/images/spanInstallation/imu.png` |  | 1207 |
| `view/images/darkMode/more.svg` |  | 1206 |
| `view/images/more.svg` |  | 1204 |
| `view/images/tile_edit.svg` |  | 1196 |
| `view/images/darkMode/passwordShow.svg` |  | 1187 |
| `view/images/deviceManager/radio_btn_checked.svg` |  | 1183 |
| `view/images/passwordShow.svg` |  | 1177 |
| `view/images/darkMode/spanInstallation/back.png` |  | 1174 |
| `view/images/darkMode/feedback_check_box_tristate.svg` |  | 1166 |
| `view/images/USB_Blocked.png` |  | 1162 |
| `view/images/darkMode/spanInstallation/left.png` |  | 1159 |
| `view/images/feedback_check_box_tristate.svg` |  | 1156 |
| `view/images/darkMode/feedback_sentiment_verySatisfied.svg` |  | 1150 |
| `view/images/darkMode/feedback_sentiment_very_satisfied_selected.svg` |  | 1143 |
| `view/images/spanInstallation/right.png` |  | 1137 |
| `view/images/app_menu.svg` |  | 1135 |
| `view/images/feedback_sentiment_very_satisfied.svg` |  | 1133 |
| `view/images/feedback_sentiment_very_satisfied_selected.svg` |  | 1133 |
| `view/images/spanInstallation/front.png` |  | 1116 |
| `view/images/spanInstallation/down.png` |  | 1102 |
| `view/images/darkMode/disconnect.svg` |  | 1096 |
| `view/images/deviceManager/disconnect.svg` |  | 1094 |
| `view/images/deviceManager/info_outline.svg` |  | 1094 |
| `view/images/darkMode/unchecked_box.svg` |  | 1077 |
| `view/images/darkMode/checked_box.svg` |  | 1075 |
| `view/images/spanInstallation/back.png` |  | 1069 |
| `view/images/darkMode/menubar_settings.svg` |  | 1068 |
| `view/images/Remove.png` |  | 1067 |
| `view/images/feedback_checked_box.svg` |  | 1065 |
| `view/images/feedback_unchecked_box.svg` |  | 1060 |
| `view/images/menubar_settings.svg` |  | 1058 |
| `view/images/darkMode/info.svg` |  | 1053 |
| `view/images/darkMode/spanInstallation/refPoint.svg` |  | 1053 |
| `view/images/darkMode/feedback_unchecked_box_blue.svg` |  | 1051 |
| `view/images/darkMode/open.svg` |  | 1046 |
| `view/images/deviceManager/open.svg` |  | 1044 |
| `view/images/itk/info.svg` |  | 1043 |
| `view/images/feedback_unchecked_box_blue.svg` |  | 1041 |
| `view/images/deviceManager/radio_btn_unchecked.svg` |  | 1034 |
| `view/images/darkMode/feedback_timeline_control.svg` |  | 1030 |
| `view/images/darkMode/feedback_exit.svg` |  | 1028 |
| `view/images/spanInstallation/IMUViews/largevesselTop.png` |  | 1028 |
| `view/images/spanInstallation/largevesselTop.png` |  | 1028 |
| `view/images/spanInstallation/left.png` |  | 1027 |
| `view/images/feedback_timeline_control1.svg` |  | 1013 |
| `view/images/feedback_exit.svg` |  | 1012 |
| `view/images/feedback_Information_access.svg` |  | 1004 |
| `view/images/axis_xz.png` |  | 1003 |
| `view/images/darkMode/feedback_Information_access.svg` |  | 997 |
| `view/images/playback/collapsed_play.svg` |  | 996 |
| `view/images/axis_xy.png` |  | 988 |
| `view/images/darkMode/feedback_managing_multiple.svg` |  | 987 |
| `view/images/Resources/Images/GRIT/ReplayButton.png` |  | 985 |
| `view/images/feedback_Information_access1.svg` |  | 980 |
| `view/images/Resources/Images/Graph/ErrorMarker.png` |  | 977 |
| `view/images/feedback_managing_multiple1.svg` |  | 970 |
| `view/images/darkMode/feedback_application_speed.svg` |  | 969 |
| `view/images/Resources/Images/Graph/Button_Flags_50x50.png` |  | 957 |
| `view/images/darkMode/spanInstallation/secAnt.png` |  | 954 |
| `view/images/spanInstallation/secAnt.png` |  | 954 |
| `view/images/feedback_application_speed1.svg` |  | 952 |
| `view/images/darkMode/logging_edit.svg` |  | 951 |
| `view/images/settings.png` |  | 948 |
| `view/images/axis_yz.png` |  | 939 |
| `view/images/darkMode/add-port.svg` |  | 939 |
| `view/images/logging_edit.svg` |  | 938 |
| `view/images/ic_close.svg` |  | 935 |
| `view/images/add-port.svg` |  | 925 |
| `view/images/help.png` |  | 922 |
| `view/images/darkMode/spanInstallation/primAnt.png` |  | 907 |
| `view/images/spanInstallation/primAnt.png` |  | 907 |
| `view/images/darkMode/warning_icon.svg` |  | 905 |
| `view/images/warning_icon.svg` |  | 905 |
| `view/images/darkMode/spanInstallation/up.png` |  | 901 |
| `view/images/default_img.svg` |  | 893 |
| `view/images/playback/connectionTile.svg` |  | 893 |
| `view/images/unknown.svg` |  | 893 |
| `view/images/spanInstallation/up.png` |  | 889 |
| `view/images/image-box.svg` |  | 881 |
| `view/images/darkMode/spanInstallation/IMUViews/largevesselSide.png` |  | 870 |
| `view/images/darkMode/spanInstallation/largevesselSide.png` |  | 870 |
| `view/images/itk/itksettings-close.svg` |  | 856 |
| `view/images/darkMode/info_blue.svg` |  | 852 |
| `view/images/itk/info_blue.svg` |  | 850 |
| `view/images/Resources/Images/NAS_Screens/Button_Option_On_29x18.png` |  | 838 |
| `view/images/darkMode/chevron_right.svg` |  | 836 |
| `view/images/darkMode/feedback_popup_icon.svg` |  | 836 |
| `view/images/darkMode/chevron_down.svg` |  | 832 |
| `view/images/chevron_right.svg` |  | 831 |
| `view/images/chevron_down.svg` |  | 827 |
| `view/images/feedback_popup_icon.svg` |  | 820 |
| `view/images/feedback_menu_icon.svg` |  | 817 |
| `view/images/feedback_snip_file.svg` |  | 815 |
| `view/images/playback/recording.svg` |  | 804 |
| `view/images/darkMode/feedback_close.svg` |  | 796 |
| `view/images/darkMode/tabs_close.svg` |  | 792 |
| `view/images/radio_selected.svg` |  | 790 |
| `view/images/feedback_close.svg` |  | 780 |
| `view/images/tabs_close.svg` |  | 780 |
| `view/images/Resources/Images/Graph/RestoreFlagButton_21x18.png` |  | 774 |
| `view/images/spanInstallation/IMUViews/largevesselFront.png` |  | 774 |
| `view/css/jsin.1.2.min.js` | 8 | 769 |
| `view/images/selected_check.svg` |  | 763 |
| `view/images/feedback_managing_multiple.svg` |  | 740 |
| `view/images/menubar_settings_active.svg` |  | 722 |
| `view/images/darkMode/hidePassword.svg` |  | 718 |
| `view/images/gear.png` |  | 718 |
| `view/images/Resources/Images/Graph/HomeIcon_22x18.png` |  | 710 |
| `view/images/darkMode/spanInstallation/IMUViews/humanTop.png` |  | 701 |
| `view/images/usb.png` |  | 701 |
| `view/images/hxgn_logo.svg` |  | 693 |
| `view/images/menu.png` |  | 685 |
| `view/images/normal_u15573.svg` |  | 684 |
| `view/images/advertisement/download-log.log` |  | 678 |
| `view/images/Resources/Images/Graph/Flag.png` |  | 672 |
| `view/images/spanInstallation/IMUViews/humanTop.png` |  | 656 |
| `view/images/darkMode/toggleswitch_off.svg` |  | 645 |
| `view/images/toggleswitch_off.svg` |  | 645 |
| `view/images/Resources/Images/NAS_Screens/Button_Option_Off_28x18.png` |  | 642 |
| `view/images/spanInstallation/refPoint.png` |  | 642 |
| `view/images/darkMode/toggleswitch_on.svg` |  | 640 |
| `view/images/Resources/Images/Graph/ButtonHideGraph_21x18.png` |  | 639 |
| `view/images/trash.png` |  | 639 |
| `view/images/delete_warning_icon.png` |  | 638 |
| `view/images/toggleswitch_on.svg` |  | 638 |
| `view/images/slider_arrow.png` |  | 629 |
| `view/images/susbcriptionResendIcon.svg` |  | 619 |
| `view/images/darkMode/darkMode_ic_cursor_drag_24.svg` |  | 615 |
| `view/images/ic_cursor_drag_24.svg` |  | 615 |
| `view/images/darkMode/feedback_go_back.svg` |  | 614 |
| `view/images/Resources/Images/Graph/ButtonForward30_15x18.png` |  | 613 |
| `view/images/feedback_go_back.svg` |  | 604 |
| `view/images/radio_unselected.svg` |  | 599 |
| `view/images/darkMode/spanInstallation/IMUViews/largevesselTop.png` |  | 598 |
| `view/images/darkMode/spanInstallation/largevesselTop.png` |  | 598 |
| `view/images/darkMode/Notifications_Off.svg` |  | 596 |
| `view/images/Notifications_Off.svg` |  | 592 |
| `view/images/terrastarError.svg` |  | 589 |
| `view/images/icon_folder.svg` |  | 573 |
| `view/images/icon_folder_b.svg` |  | 573 |
| `view/images/Resources/Images/Playback_Screens/ButtonReplay_18x18.png` |  | 573 |
| `view/images/playback/record.svg` |  | 571 |
| `view/images/Resources/Images/Graph/HideFlagButton_17x16.png` |  | 560 |
| `view/images/Resources/Images/NAS_Screens/Button_Settings.png` |  | 555 |
| `view/images/Resources/Images/GRIT/ReplayButton_15x18.png` |  | 552 |
| `view/images/events.png` |  | 541 |
| `view/images/darkMode/spanInstallation/IMUViews/largevesselFront.png` |  | 528 |
| `view/images/Button_Option_On.png` |  | 516 |
| `view/images/Resources/Images/NAS_Screens/Button_Option_On.png` |  | 516 |
| `view/images/darkMode/Notifications_On.svg` |  | 501 |
| `view/images/error-info.png` |  | 499 |
| `view/images/Notifications_On.svg` |  | 487 |
| `view/images/feedback_timeline_control.svg` |  | 486 |
| `view/images/darkMode/drakmode-tsc-icon.svg` |  | 473 |
| `view/images/normal_check.svg` |  | 472 |
| `view/images/download.png` |  | 462 |
| `view/images/darkMode/zoom_out.svg` |  | 461 |
| `view/images/Button_Option_Off.png` |  | 460 |
| `view/images/Resources/Images/NAS_Screens/Button_Option_Off.png` |  | 460 |
| `view/images/Resources/Images/NAS_Screens/Button_Settings_18x18.png` |  | 453 |
| `view/images/Resources/Images/Playback_Screens/ButtonReplay.png` |  | 452 |
| `view/images/darkMode/usb_icon.svg` |  | 451 |
| `view/images/usb_icon.svg` |  | 449 |
| `view/images/spoofing_amber_warning.png` |  | 448 |
| `view/images/feedback_application_speed.svg` |  | 436 |
| `view/images/Download_complete_icon.png` |  | 421 |
| `view/images/app_retry_btn.png` |  | 417 |
| `view/images/app_menu.png` |  | 414 |
| `view/images/darkMode/close_port.svg` |  | 412 |
| `view/images/darkMode/search.svg` |  | 408 |
| `view/images/close_port.svg` |  | 398 |
| `view/images/grit_pos_overvw_map.svg` |  | 397 |
| `view/images/grit_pos_overvw_map1.svg` |  | 396 |
| `view/images/search.svg` |  | 391 |
| `view/images/error_download_icon.png` |  | 389 |
| `view/images/chevrondown.png` |  | 383 |
| `view/images/darkMode/showPassword.svg` |  | 383 |
| `view/images/Resources/Images/Playback_Screens/ButtonPlay_16x18.png` |  | 375 |
| `view/images/darkMode/menubar_status.svg` |  | 362 |
| `view/images/darkMode/btn_radio_selected_disabled.svg` |  | 358 |
| `view/images/menubar_status_active.svg` |  | 356 |
| `view/images/darkMode/menubar_tools.svg` |  | 355 |
| `view/images/grit_signal_matrix1.svg` |  | 355 |
| `view/images/grit_signal_matrix.svg` |  | 354 |
| `view/images/btn_radio_selected_disabled.svg` |  | 353 |
| `view/images/menubar_status.svg` |  | 352 |
| `view/images/Close.png` |  | 351 |
| `view/images/darkMode/btn_radio_selected.svg` |  | 351 |
| `view/images/darkMode/menubar_device.svg` |  | 351 |
| `view/images/btn_radio_selected.svg` |  | 350 |
| `view/images/darkMode/hotspot.svg` |  | 345 |
| `view/images/menubar_tools.svg` |  | 345 |
| `view/images/playback/hotspot.svg` |  | 345 |
| `view/images/menubar_device.svg` |  | 341 |
| `view/images/summary-screen.svg` |  | 340 |
| `view/images/summary-screen1.svg` |  | 338 |
| `view/images/darkMode/partial_select_box.svg` |  | 336 |
| `view/images/menubar_tools_active.svg` |  | 335 |
| `view/images/more.png` |  | 334 |
| `view/images/cancel_banner.svg` |  | 332 |
| `view/images/darkMode/cancel_banner.svg` |  | 332 |
| `view/images/playback/warningIcon.svg` |  | 332 |
| `view/images/Resources/Images/Playback_Screens/ButtonPlay.png` |  | 327 |
| `view/images/partial_select_box.svg` |  | 326 |
| `view/images/darkMode/info_not_supported.svg` |  | 324 |
| `view/images/Resources/Images/Graph/ButtonMenu_6x18.png` |  | 316 |
| `view/images/info_not_supported.svg` |  | 307 |
| `view/images/darkMode/btn_radio_unselected.svg` |  | 301 |
| `view/images/check_box_disabled.svg` |  | 300 |
| `view/images/menubar_device_active.svg` |  | 297 |
| `view/images/btn_radio_unselected.svg` |  | 295 |
| `view/images/darkMode/menubar_config.svg` |  | 286 |
| `view/images/app_action_image.png` |  | 285 |
| `view/images/events.svg` |  | 283 |
| `view/images/menubar_config_active.svg` |  | 280 |
| `view/images/darkmode_delete_app.svg` |  | 278 |
| `view/images/delete_app.svg` |  | 278 |
| `view/images/menubar_config.svg` |  | 276 |
| `view/images/playback/pause_button.svg` |  | 276 |
| `view/images/Resources/Images/Playback_Screens/ButtonPause_18x18.png` |  | 268 |
| `view/images/darkMode/add_circle_blue.svg` |  | 267 |
| `view/images/darkMode/itk-add.svg` |  | 267 |
| `view/images/Resources/Images/Graph/Flag_17x18.png` |  | 267 |
| `view/images/itk-add.svg` |  | 265 |
| `view/images/darkMode/offline_Import_dm.svg` |  | 264 |
| `view/images/darkMode/folder_blue.svg` |  | 258 |
| `view/images/add_circle_blue.svg` |  | 257 |
| `view/images/darkMode/folder_black.svg` |  | 253 |
| `view/images/offline_Import.svg` |  | 253 |
| `view/images/folder_blue.svg` |  | 248 |
| `view/images/folder_white.svg` |  | 248 |
| `view/images/Resources/Images/Playback_Screens/ButtonPause.png` |  | 246 |
| `view/images/darkMode/delete_icon.svg` |  | 244 |
| `view/images/delete_icon.svg` |  | 242 |
| `view/images/playback/play_button.svg` |  | 233 |
| `view/images/darkMode/drakmode-sbas-icon.svg` |  | 224 |
| `view/images/darkMode/download_icon.svg` |  | 208 |
| `view/images/download_icon.svg` |  | 206 |
| `view/images/new_cross.png` |  | 198 |

## J. Edie 原生解码层  (7 文件, 16.43 MB)

| 文件 | 行 | 字节 |
|---|---:|---:|
| `Edie/messages_public.json` | 167353 | 7234808 |
| `Edie/pimtpaddon.node` | — | 5863424 |
| `Edie/windows/edie-node-wrappers.node` | — | 3507712 |
| `Edie/hatanaka/windows/rnx2crx.exe` | — | 280544 |
| `Edie/waasg-III_messages.json` | 4315 | 199342 |
| `Edie/windows/configurationfile.node` |  | 139264 |
| `Edie/logger_config.toml` | 54 | 1604 |

## K. 安装/工具  (10 文件, 176.18 MB)

| 文件 | 行 | 字节 |
|---|---:|---:|
| `Apps/windows/Graph_Setup.exe` | — | 157612185 |
| `shortcuts/Unzip/node.exe` | — | 26111128 |
| `tosrec.exe` | — | 737280 |
| `datablk.exe` |  | 155648 |
| `shortcuts/Unzip/node_modules.zip` |  | 114860 |
| `shortcuts/Unzip/createShortCuts.js` | 84 | 3127 |
| `shortcuts/Unzip/createShortCuts.js.bak` |  | 900 |
| `shortcuts/Unzip/decompose.js` | 6 | 245 |
| `shortcuts/Unzip/createShortCuts.cmd` | 4 | 70 |
| `shortcuts/Unzip/decompose.cmd` | 4 | 55 |

## Z. 根目录入口  (21 文件, 0.67 MB)

| 文件 | 行 | 字节 |
|---|---:|---:|
| `jarvisInterface.js` | 6910 | 373503 |
| `Packery_Commercial_License.pdf` |  | 170607 |
| `assets/icons/win/installericon.ico` |  | 50106 |
| `assets/icons/linux/NAS.png` |  | 28154 |
| `assets/icons/linux/NASApp.png` |  | 28154 |
| `main.js` | 490 | 16321 |
| `updater.js` | 165 | 8001 |
| `README.md` | 94 | 6275 |
| `application.js` | 92 | 3656 |
| `create-shortcut.js` | 93 | 3418 |
| `.gitlab-ci.yml.bak` |  | 2531 |
| `LoadConfig.bat` | 79 | 2259 |
| `Jenkinsfile` |  | 1726 |
| `assets/icons/linux/installericon.png` |  | 1556 |
| `assets/icons/win/loading.gif` |  | 1227 |
| `package.json` | 42 | 1134 |
| `index.js` | 31 | 917 |
| `Components.json` | 1 | 67 |
| `.npmrc` |  | 41 |
| `createHex.bat` | 1 | 22 |
| `.env` |  | 12 |

