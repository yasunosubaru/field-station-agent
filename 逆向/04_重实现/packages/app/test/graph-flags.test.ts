/**
 * Graph · Pre-process flags — the 10-marker store behind the timeline's `Flags (0/10)`.
 *
 * Every rule asserted here was measured in the shipped bundle
 * (`逆向/01_解包/Graph/out/renderer/assets/index-B86bHcCD.js`):
 *
 *   MAX_FLAGS = 10, DEFAULT_FLAG_COLOR = "#F95B61"            @1410884
 *   `addFlag` pushes `{id: newFlagId, …}` and bumps `newFlagId` @191629
 *   duplicate = |flag.timeCaptured − t| < 1000 ms, trash excluded @1424277
 *   `getActiveFlags` / `getTotalFlags` / `getOnlyActiveFlags`  @1414959
 *   delete = `state: "trashFlag"`, restore refuses at 10 / duplicate @1454591
 *   `FlagsInitialState: {allFlags, isFlagsPanelOpen}` on disk, `newFlagId = max(id)+1` @16246801
 *
 * The persisted bucket is this build's stand-in for `.gpf` (documented in `graph.js` and
 * `03_分析/13_Graph分析页.md §10`); the store shape itself is the original's.
 *
 *   node --test --test-force-exit "packages/app/test/graph-flags.test.ts"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FLAG_COLOR,
  FLAG_DUPLICATE_WINDOW_MS,
  FLAG_LIMIT,
  FLAG_STATES,
  FLAG_STORAGE_PREFIX,
  activeFlags,
  addFlag,
  canAddFlag,
  clearFlagSelection,
  emptyFlagState,
  emptyTrash,
  flagAtTime,
  flagOffsetSeconds,
  flagStorageKey,
  flagTimeLabel,
  flagTotal,
  gpsSecondsToMs,
  loadFlagState,
  msToGpsSeconds,
  nextFlagId,
  restoreFlag,
  restoreFlagState,
  saveFlagState,
  selectFlag,
  serializeFlagState,
  toggleFlagVisibility,
  trashFlag,
  updateFlag,
  visibleFlags,
} from '../src/web/panels/graph.js';

/* ---------------- helpers ---------------- */

/** Small `Storage` stand-in: no jsdom, just the three methods the store uses. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

let clock = 1_000_000;
/** A flag payload one second after the previous one, so duplicate checks stay out of the way. */
function nextPayload(extra = {}) {
  clock += 1000;
  return { timeCaptured: clock, timeBase: 'elapsed', description: '', ...extra };
}

function storeWith(count, base = {}) {
  let state = emptyFlagState();
  for (let i = 0; i < count; i += 1) {
    const result = addFlag(state, nextPayload());
    assert.equal(result.ok, true, `第 ${i + 1} 个 flag 应该能加`);
    state = result.state;
  }
  return { state: { ...state, ...base } };
}

/* ---------------- the constants ---------------- */

test('上限 10、默认色与状态字符串都是原版的', () => {
  assert.equal(FLAG_LIMIT, 10);
  assert.equal(DEFAULT_FLAG_COLOR, '#F95B61');
  assert.equal(FLAG_DUPLICATE_WINDOW_MS, 1000);
  assert.deepEqual(FLAG_STATES, {
    active: 'activeFlag',
    hidden: 'hiddenFlag',
    hover: 'hoverFlag',
    trash: 'trashFlag',
    selected: 'selectedFlag',
  });
  assert.deepEqual(emptyFlagState(), {
    allFlags: [],
    editFlagId: 0,
    newFlagId: 1,
    isFlagsPanelOpen: false,
  });
});

/* ---------------- GPS ⇄ ms, the flag time domain ---------------- */

test('GPS 秒 ↔ epoch ms 往返，标签是 W<week> <秒.毫秒>', () => {
  const absolute = 2442 * 604800 + 463097.35;
  const ms = gpsSecondsToMs(absolute);
  assert.equal(ms, Date.UTC(1980, 0, 6) + (absolute - 18) * 1000);
  assert.ok(Math.abs(msToGpsSeconds(ms) - absolute) < 1e-9);
  assert.equal(flagTimeLabel({ timeCaptured: ms, timeBase: 'gps' }), 'W2442 463097.350');
  assert.equal(flagTimeLabel({ timeCaptured: 72_000, timeBase: 'elapsed' }), '00:01:12');
  assert.equal(flagTimeLabel({ timeCaptured: Number.NaN }), '—');
  assert.equal(gpsSecondsToMs(Number.NaN), null);
});

test('flagOffsetSeconds：GPS 标记换到本文件秒，无 GPS 头时返回 null', () => {
  const start = 2442 * 604800 + 463097.35;
  const flag = { timeCaptured: gpsSecondsToMs(start + 12.5), timeBase: 'gps' };
  assert.ok(Math.abs(flagOffsetSeconds(flag, start) - 12.5) < 1e-6);
  assert.equal(flagOffsetSeconds(flag, null), null, '没有 #Start Time(GPS) 就不猜');

  // elapsed 标记不看文件头，本身就是秒
  assert.equal(flagOffsetSeconds({ timeCaptured: 4_500, timeBase: 'elapsed' }, null), 4.5);
  // 落在文件范围外也照样给出负值/超界值，由调用方决定是否跳
  assert.ok(flagOffsetSeconds(flag, start + 3600) < 0);
  assert.equal(flagOffsetSeconds({ timeCaptured: Number.NaN }, start), null);
});

/* ---------------- add / limit / duplicate ---------------- */

test('addFlag 从 1 连续编号，第 11 个被上限拒绝且状态不变', () => {
  const { state } = storeWith(10);
  assert.equal(state.allFlags.length, 10);
  assert.deepEqual(state.allFlags.map((flag) => flag.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(state.newFlagId, 11);
  assert.equal(flagTotal(state.allFlags), 10);

  const rejected = addFlag(state, nextPayload());
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'limit');
  assert.equal(rejected.state, state, '拒绝时原 state 原样返回');
});

test('canAddFlag / flagAtTime：1 秒内算重复，回收站里的不挡路', () => {
  const result = addFlag(emptyFlagState(), { timeCaptured: 10_000, timeBase: 'elapsed' });
  const flags = result.state.allFlags;

  assert.equal(canAddFlag(flags, 10_000).reason, 'duplicate');
  assert.equal(canAddFlag(flags, 10_500).reason, 'duplicate', '容差 < 1000 ms');
  assert.equal(canAddFlag(flags, 10_999).reason, 'duplicate');
  assert.equal(canAddFlag(flags, 11_000).ok, true, '正好 1000 ms 可以');
  assert.equal(canAddFlag(flags, 8_999).ok, true, '1001 ms 之外可以');
  assert.equal(flagAtTime(flags, 10_400).id, 1);

  const trashed = trashFlag(result.state, 1);
  assert.equal(flagAtTime(trashed.allFlags, 10_000), null);
  assert.equal(canAddFlag(trashed.allFlags, 10_000).ok, true, '删掉的标记不再占时间点');
});

test('addFlag 保留 description / color / 坐标，空描述是空串', () => {
  const result = addFlag(emptyFlagState(), {
    timeCaptured: 5_000,
    timeBase: 'gps',
    description: '  antenna moved  ',
    latitude: 45.12345,
    longitude: -75.98765,
    height: 81.2,
  });
  assert.equal(result.ok, true);
  const flag = result.flag;
  assert.equal(flag.description, '  antenna moved  ');
  assert.equal(flag.color, DEFAULT_FLAG_COLOR);
  assert.equal(flag.latitude, 45.12345);
  assert.equal(flag.longitude, -75.98765);
  assert.equal(flag.height, 81.2);
  assert.equal(flag.state, FLAG_STATES.active);
  assert.equal(flag.timeBase, 'gps');
  assert.equal(addFlag(emptyFlagState(), { timeCaptured: Number.NaN }).reason, 'invalid');
  // 缺经纬度就是 null，绝不补 0（0,0 是几内亚湾）
  assert.equal(result.state.allFlags[0].latitude === 0, false);
});

/* ---------------- delete → trash, restore, empty ---------------- */

test('删除进回收站：不计数、不上时间轴；恢复后回到 activeFlag', () => {
  const { state } = storeWith(3);
  const trashed = trashFlag(state, 2);
  assert.equal(flagTotal(trashed.allFlags), 2, '(n/10) 不含回收站');
  assert.deepEqual(visibleFlags(trashed.allFlags).map((flag) => flag.id), [1, 3]);
  assert.equal(activeFlags(trashed.allFlags).length, 2);

  const restored = restoreFlag(trashed, 2);
  assert.equal(restored.ok, true);
  assert.equal(flagTotal(restored.state.allFlags), 3);
  assert.equal(visibleFlags(restored.state.allFlags).length, 3);
  assert.equal(restored.state.allFlags.find((flag) => flag.id === 2).state, FLAG_STATES.active);
});

test('恢复也守上限与重复时间点（原版 tooltip 的两个拒绝文案）', () => {
  const ten = emptyFlagState();
  let full = ten;
  for (let i = 0; i < 10; i += 1) {
    full = addFlag(full, { timeCaptured: (i + 1) * 10_000, timeBase: 'elapsed' }).state;
  }
  // 删掉最后一个 → 只剩 9 个，恢复自己的时间点没问题
  assert.equal(restoreFlag(trashFlag(full, 10), 10).ok, true);

  // 上限：删一个再在别处补一个，回到 10 个，恢复就被 MAX_FLAGS 拦住
  const cut = trashFlag(full, 10);
  const refilled = addFlag(cut, { timeCaptured: 105_000, timeBase: 'elapsed' });
  assert.equal(refilled.ok, true);
  assert.equal(flagTotal(refilled.state.allFlags), 10);
  const atLimit = restoreFlag(refilled.state, 10);
  assert.equal(atLimit.ok, false);
  assert.equal(atLimit.reason, 'limit');

  // 重复时间点：删掉 #1（10 000）后在 10 500 加一个，恢复 #1 会撞上 500 ms 内的那个
  const few = emptyFlagState();
  let small = few;
  for (let i = 1; i <= 3; i += 1) {
    small = addFlag(small, { timeCaptured: i * 10_000, timeBase: 'elapsed' }).state;
  }
  const cutOne = trashFlag(small, 1);
  const near = addFlag(cutOne, { timeCaptured: 10_500, timeBase: 'elapsed' });
  assert.equal(near.ok, true);
  const duplicate = restoreFlag(near.state, 1);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'duplicate');

  assert.equal(restoreFlag(small, 999).reason, 'missing');
  assert.equal(restoreFlag(small, 1).reason, 'not-trash');
});

test('emptyTrash 只清回收站，活标记一个不动', () => {
  const { state } = storeWith(4);
  const withTrash = trashFlag(trashFlag(state, 1), 4);
  assert.equal(withTrash.allFlags.length, 4);
  const emptied = emptyTrash(withTrash);
  assert.deepEqual(emptied.allFlags.map((flag) => flag.id), [2, 3]);
  assert.equal(flagTotal(emptied.allFlags), 2);
  assert.deepEqual(emptyTrash(emptyFlagState()).allFlags, []);
});

/* ---------------- hide / show / select / update ---------------- */

test('隐藏的 flag 不画在时间轴上，但仍在列表里计数', () => {
  const { state } = storeWith(2);
  const hidden = toggleFlagVisibility(state, 1);
  assert.equal(hidden.allFlags.find((flag) => flag.id === 1).state, FLAG_STATES.hidden);
  assert.deepEqual(visibleFlags(hidden.allFlags).map((flag) => flag.id), [2]);
  assert.equal(flagTotal(hidden.allFlags), 2);
  const shown = toggleFlagVisibility(hidden, 1);
  assert.equal(shown.allFlags.find((flag) => flag.id === 1).state, FLAG_STATES.active);
  // 回收站里的 eye 不改变状态
  const trashed = trashFlag(state, 1);
  assert.deepEqual(toggleFlagVisibility(trashed, 1), trashed);
});

test('同一时刻只有一个 selectedFlag，清选择后回到 activeFlag', () => {
  const { state } = storeWith(3);
  const first = selectFlag(state, 2);
  assert.equal(first.editFlagId, 2);
  assert.equal(first.allFlags.find((flag) => flag.id === 2).state, FLAG_STATES.selected);
  const second = selectFlag(first, 3);
  assert.equal(second.editFlagId, 3);
  assert.equal(second.allFlags.find((flag) => flag.id === 2).state, FLAG_STATES.active);
  assert.equal(second.allFlags.find((flag) => flag.id === 3).state, FLAG_STATES.selected);
  const cleared = clearFlagSelection(second);
  assert.equal(cleared.editFlagId, 0);
  assert.equal(cleared.allFlags.filter((flag) => flag.state === FLAG_STATES.selected).length, 0);
  // 回收站里的不能选
  assert.deepEqual(selectFlag(trashFlag(state, 1), 1), trashFlag(state, 1));
});

test('updateFlag 按 id 合并，未知 id 不改任何东西', () => {
  const { state } = storeWith(2);
  const changed = updateFlag(state, { id: 2, description: 'edited', color: '#123456' });
  assert.equal(changed.allFlags[1].description, 'edited');
  assert.equal(changed.allFlags[1].color, '#123456');
  assert.equal(changed.allFlags[0].description, '');
  assert.deepEqual(updateFlag(state, { id: 99, description: 'x' }), state);
  assert.deepEqual(updateFlag(state, {}), state);
});

/* ---------------- persistence: one bucket per project ---------------- */

test('flagStorageKey 每个工程一桶，空 key 落到 (default)', () => {
  assert.equal(flagStorageKey('b1'), `${FLAG_STORAGE_PREFIX}b1`);
  assert.equal(flagStorageKey('clean'), `${FLAG_STORAGE_PREFIX}clean`);
  assert.notEqual(flagStorageKey('b1'), flagStorageKey('clean'));
  assert.equal(flagStorageKey(''), `${FLAG_STORAGE_PREFIX}(default)`);
  assert.equal(flagStorageKey(null), `${FLAG_STORAGE_PREFIX}(default)`);
  assert.equal(flagStorageKey('  b1  '), `${FLAG_STORAGE_PREFIX}b1`);
});

test('save → load 往返：计数器、面板开合、id 连续都还在', () => {
  const storage = memoryStorage();
  const { state } = storeWith(3);
  const saved = { ...state, isFlagsPanelOpen: true };
  assert.equal(saveFlagState(storage, 'clean', saved), true);

  const loaded = loadFlagState(storage, 'clean');
  assert.deepEqual(loaded.allFlags.map((flag) => flag.id), [1, 2, 3]);
  assert.equal(loaded.isFlagsPanelOpen, true);
  assert.equal(loaded.newFlagId, 4, 'newFlagId = max(id)+1，与 setStoreDefaults 一致');
  // 再存一次不丢字段
  assert.equal(saveFlagState(storage, 'clean', loaded), true);
  assert.equal(loadFlagState(storage, 'clean').allFlags.length, 3);
});

test('切工程不串：b1 的 flag 不会出现在 clean，反之亦然', () => {
  const storage = memoryStorage();
  const b1 = storeWith(2).state;
  const clean = storeWith(5).state;
  saveFlagState(storage, 'b1', b1);
  saveFlagState(storage, 'clean', clean);

  assert.equal(loadFlagState(storage, 'b1').allFlags.length, 2);
  assert.equal(loadFlagState(storage, 'clean').allFlags.length, 5);
  assert.equal(loadFlagState(storage, 'other').allFlags.length, 0);

  // 覆盖一个工程不碰另一个
  saveFlagState(storage, 'b1', emptyFlagState());
  assert.equal(loadFlagState(storage, 'b1').allFlags.length, 0);
  assert.equal(loadFlagState(storage, 'clean').allFlags.length, 5);
});

test('坏数据 / 无 storage 一律空状态，不抛错', () => {
  assert.deepEqual(loadFlagState(memoryStorage(), 'b1'), emptyFlagState());
  assert.deepEqual(loadFlagState(memoryStorage({ [flagStorageKey('b1')]: '{not json' }), 'b1'), emptyFlagState());
  assert.deepEqual(loadFlagState(null, 'b1'), emptyFlagState());
  assert.equal(saveFlagState(null, 'b1', emptyFlagState()), false);
  assert.equal(saveFlagState({ setItem() { throw new Error('quota'); } }, 'b1', emptyFlagState()), false);

  // 列表里坏行被丢掉，好行保留
  const restored = restoreFlagState({
    allFlags: [
      { id: 1, timeCaptured: 1000 },
      { id: 2, timeCaptured: 'not a number' },
      null,
      { id: 3, timeCaptured: 3000, state: 'madeUpState' },
    ],
    isFlagsPanelOpen: 1,
  });
  assert.deepEqual(restored.allFlags.map((flag) => flag.id), [1, 3]);
  assert.equal(restored.allFlags[1].state, 'activeFlag', '未知 state 回 activeFlag');
  assert.equal(restored.isFlagsPanelOpen, true);
});

test('也能读 .gpf 形状 {FlagsInitialState:{…}}，并重算 newFlagId', () => {
  const gpf = {
    DataInfo: { StartTime: 1 },
    FlagsInitialState: {
      allFlags: [
        { id: 7, timeCaptured: 1000, description: 'a', state: 'hiddenFlag' },
        { id: 9, timeCaptured: 9000, description: 'b' },
      ],
      isFlagsPanelOpen: true,
    },
  };
  const restored = restoreFlagState(gpf);
  assert.equal(restored.allFlags.length, 2);
  assert.equal(restored.newFlagId, 10);
  assert.equal(restored.isFlagsPanelOpen, true);
  assert.equal(restored.allFlags[0].state, 'hiddenFlag');
});

test('serializeFlagState 只写 .gpf 的两个字段', () => {
  const { state } = storeWith(1);
  const payload = serializeFlagState({ ...state, editFlagId: 1, isFlagsPanelOpen: true });
  assert.deepEqual(Object.keys(payload).sort(), ['allFlags', 'isFlagsPanelOpen']);
  assert.equal(payload.isFlagsPanelOpen, true);
  assert.equal(nextFlagId([]), 1);
  assert.equal(nextFlagId([{ id: 4 }, { id: 2 }]), 5);
});
