/**
 * The tail that turns the shipped Graph renderer bundle into a **Luciad-only** ES module.
 *
 * `逆向/01_解包/Graph/out/renderer/assets/index-B86bHcCD.js` is a Vite/ESM artifact whose only
 * exports are two helpers (`c`, `g`) and whose last statement mounts the whole Graph React app into
 * `#root`. Everything between is one module scope, and the LuciadRIA 2026.0 class/function names
 * survive minification (`RIAMap`, `FeatureLayer`, `createPolyline`, …) because the app imports them
 * by name.
 *
 * `server.ts` therefore serves that file with the mount call cut off and this list appended, which
 * is enough to drop everything after this comment and get the same engine:
 *
 *   import { RIAMap, getReference, createPoint } from '/geo/luciad-engine.js'
 *
 * Every name below has to exist at module scope — an unresolved name makes the whole module fail to
 * link, so the list is exactly what `luciad-stage.js` needs and nothing more. (Verified against the
 * bundle: of 21 names probed while building this, only `BlendingMode` / `PixelDensity` were absent.)
 */
export {
  RIAMap,
  getReference,
  createPoint,
  createPolyline,
  createCircleByCenterPoint,
  createBounds,
  createTransformation,
  Feature,
  FeatureModel,
  MemoryStore,
  FeatureLayer,
  FeaturePainter,
  LayerType,
  PointLabelPosition,
};
