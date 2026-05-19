/***
 *
 * Vivaldi tab-group adapter (Route A: vivExtData).
 *
 * Provides a single `tabGroupsAPI` surface that mirrors the subset of
 * chrome.tabGroups + chrome.tabs.group/ungroup that BrainTool uses. On Chrome
 * it passes through to native APIs; on Vivaldi it routes through
 * `tab.vivExtData` JSON patching, since Vivaldi silently no-ops the native
 * Tab Group API. See resources/VivaldiTabGroupHackRoutes.md for the
 * background and resources/TabGroupAPIAudit.md for the call-site inventory.
 *
 * Intentionally not synced on Vivaldi: real group color, collapsed state — no
 * vivExtData field exists for either. Adapter drops `collapsed` silently in
 * update() and returns a synthetic grey color for BrainTool's existing UI.
 *
 ***/

'use strict';

// ---------------------------------------------------------------------------
// Detection. MV3 extension service workers reject top-level await, so module
// load must stay synchronous and public async methods wait on `_ready`.
// ---------------------------------------------------------------------------

let _isVivaldi = false;
let _ready = Promise.resolve();
const VIVALDI_SYNTHETIC_COLOR = 'grey';

async function _detectVivaldi() {
    try {
        if (typeof navigator !== 'undefined' && /Vivaldi/i.test(navigator.userAgent || '')) return true;
        const wins = await chrome.windows.getAll();
        if (wins.some(w => 'vivExtData' in w)) return true;
        const tabs = await chrome.tabs.query({});
        return tabs.some(t => 'vivExtData' in t);
    } catch (e) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// vivExtData helpers
// ---------------------------------------------------------------------------

function _parseVivExtData(tab) {
    if (!tab) return {};
    try { return JSON.parse(tab.vivExtData || '{}'); }
    catch { return {}; }
}

async function _writeVivExtData(tabId, patch) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    if (!tab) return;
    const data = _parseVivExtData(tab);
    for (const k of Object.keys(patch)) {
        if (patch[k] === undefined || patch[k] === '') delete data[k];
        else data[k] = patch[k];
    }
    try {
        await chrome.tabs.update(tabId, { vivExtData: JSON.stringify(data) });
    } catch (e) {
        console.warn(`vivaldiTabGroupAdapter: write failed for tab ${tabId}`, e);
    }
}

function _vivTabIsPanel(tab) {
    return !!_parseVivExtData(tab).panelId;
}
function _vivTabGroup(tab) {
    return _parseVivExtData(tab).group || '';
}
function _vivTabTitle(tab) {
    return _parseVivExtData(tab).fixedGroupTitle || '';
}
function _cachedVivTabGroup(tab) {
    return _vivTabGroup(tab) || _lastSeen.get(tab?.id)?.group || '';
}
function _cachedVivTabTitle(tab) {
    return _vivTabTitle(tab) || _lastSeen.get(tab?.id)?.title || '';
}
function _generateGroupId() {
    const u = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return u.replace(/-/g, '');
}

// ---------------------------------------------------------------------------
// Vivaldi-path implementations
// ---------------------------------------------------------------------------

async function _vQuery() {
    const tabs = await chrome.tabs.query({});
    const groups = new Map();
    for (const seen of _lastSeen.values()) {
        if (!seen.group || groups.has(seen.group)) continue;
        groups.set(seen.group, {
            id: seen.group,
            title: seen.title || '',
            windowId: seen.windowId,
            color: VIVALDI_SYNTHETIC_COLOR,
            collapsed: false,
        });
    }
    for (const t of tabs) {
        if (_vivTabIsPanel(t)) continue;
        const g = _cachedVivTabGroup(t);
        if (!g) continue;
        if (!groups.has(g)) {
            groups.set(g, {
                id: g,
                title: _cachedVivTabTitle(t),
                windowId: t.windowId,
                color: VIVALDI_SYNTHETIC_COLOR,
                collapsed: false,
            });
        }
    }
    return Array.from(groups.values());
}

async function _vGet(id) {
    if (!id) return null;
    const tabs = await _vTabsForGroup(id);
    const t = tabs[0];
    const seen = Array.from(_lastSeen.values()).find(s => s.group === id);
    if (!t && !seen) return null;
    const meta = _lastGroupMeta.get(id);
    return {
        id, title: meta?.title || _cachedVivTabTitle(t) || seen?.title || '', windowId: t?.windowId ?? seen?.windowId,
        color: meta?.color ?? VIVALDI_SYNTHETIC_COLOR, collapsed: meta?.collapsed ?? false,
    };
}

async function _vUpdate(id, props = {}) {
    if (!id || props.title === undefined) return;
    // `collapsed` and real browser color are dropped silently on Vivaldi.
    const members = await _vTabsForGroup(id);
    for (const t of members) {
        await _writeVivExtData(t.id, { fixedGroupTitle: props.title });
        _rememberVivTab(t.id, id, props.title, t.windowId);
    }
}

async function _vGroup({ tabIds, groupId, createProperties } = {}) {
    if (tabIds === undefined || tabIds === null) return null;
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    const gid = groupId || _generateGroupId();

    let inheritedTitle;
    if (groupId) {
        const existing = await _vGet(groupId);
        inheritedTitle = existing?.title;
    }
    for (const tid of ids) {
        let tab;
        try { tab = await chrome.tabs.get(tid); } catch {}
        const patch = { group: gid };
        if (inheritedTitle) patch.fixedGroupTitle = inheritedTitle;
        await _writeVivExtData(tid, patch);
        _rememberVivTab(tid, gid, inheritedTitle, tab?.windowId);
    }
    return gid;
}

async function _vUngroup(tabIds) {
    if (tabIds === undefined || tabIds === null) return;
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    for (const tid of ids) {
        // Empty group → "not in any stack". Also clear title so a future
        // re-group starts clean.
        await _writeVivExtData(tid, { group: '', fixedGroupTitle: '' });
        _rememberVivTab(tid, '', '');
    }
}

async function _vTabsForGroup(groupId) {
    const tabs = await chrome.tabs.query({});
    const byId = new Map(tabs.map(t => [t.id, t]));
    const ids = new Set();
    for (const t of tabs) {
        if (!_vivTabIsPanel(t) && _cachedVivTabGroup(t) === groupId) ids.add(t.id);
    }
    for (const [tabId, seen] of _lastSeen.entries()) {
        if (seen.group === groupId) ids.add(tabId);
    }
    return Array.from(ids).map(id => byId.get(id)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Synthetic events (Vivaldi only)
// ---------------------------------------------------------------------------

function _makeEmitter() {
    const listeners = new Set();
    return {
        addListener: (cb) => listeners.add(cb),
        removeListener: (cb) => listeners.delete(cb),
        _emit: (...args) => {
            for (const cb of listeners) {
                try { cb(...args); }
                catch (e) { console.warn('vivaldiTabGroupAdapter listener error', e); }
            }
        },
    };
}

const _onCreated = _makeEmitter();
const _onUpdated = _makeEmitter();
const _onRemoved = _makeEmitter();
const _onTabGroupTransition = _makeEmitter();

const _lastSeen = new Map();        // tabId → { group, title, windowId }
const _groupCount = new Map();      // groupId → number of tabs currently in it
const _lastGroupMeta = new Map();   // groupId → { title, color, collapsed } — bridge-populated

let _bridgeMode = false;            // when true: chrome.tabs.onUpdated path on Vivaldi is bypassed; events arrive via dispatchBridgeEvent()

function _bumpGroupCount(gid, delta) {
    const next = (_groupCount.get(gid) || 0) + delta;
    if (next <= 0) { _groupCount.delete(gid); return 0; }
    _groupCount.set(gid, next);
    return next;
}

function _rememberVivTab(tabId, group, title = '', windowId) {
    const prev = _lastSeen.get(tabId) || { group: '', title: '', windowId };
    const nextGroup = group || '';
    if (prev.group && prev.group !== nextGroup) _bumpGroupCount(prev.group, -1);
    if (nextGroup && prev.group !== nextGroup) _bumpGroupCount(nextGroup, 1);
    _lastSeen.set(tabId, {
        group: nextGroup,
        title: title || prev.title || '',
        windowId: windowId ?? prev.windowId,
    });
}

function _processVivTabState(tab) {
    if (!tab) return;
    const id = tab.id;
    if (_vivTabIsPanel(tab)) {
        const prev = _lastSeen.get(id);
        if (prev?.group) {
            const c = _bumpGroupCount(prev.group, -1);
            if (c === 0) _onRemoved._emit({ id: prev.group });
        }
        _lastSeen.delete(id);
        return;
    }
    const group = _vivTabGroup(tab);
    const windowId = tab.windowId;
    const prev = _lastSeen.get(id) || { group: '', title: '', windowId };
    const title = _vivTabTitle(tab) || prev.title || '';

    if (group !== prev.group) {
        _onTabGroupTransition._emit({
            tabId: id, prevGroupId: prev.group, newGroupId: group, tab,
        });
        if (prev.group) {
            const c = _bumpGroupCount(prev.group, -1);
            if (c === 0) _onRemoved._emit({ id: prev.group });
        }
        if (group) {
            const c = _bumpGroupCount(group, 1);
            if (c === 1) {
                _onCreated._emit({
                    id: group, title, windowId,
                    color: VIVALDI_SYNTHETIC_COLOR, collapsed: false,
                });
            } else if (title) {
                _onUpdated._emit({
                    id: group, title, windowId,
                    color: VIVALDI_SYNTHETIC_COLOR, collapsed: undefined,
                });
            }
        }
    } else if (group && title !== prev.title) {
        _onUpdated._emit({
            id: group, title, windowId,
            color: VIVALDI_SYNTHETIC_COLOR, collapsed: undefined,
        });
    }
    _lastSeen.set(id, { group, title, windowId });
}

function _initChromeTransitionTracking() {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (!('groupId' in changeInfo)) return;
        const newGid = (tab && tab.groupId > 0) ? tab.groupId : TGID_NONE_CHROME;
        _onTabGroupTransition._emit({
            tabId,
            prevGroupId: undefined,         // Chrome doesn't surface the previous id
            newGroupId: newGid,
            tab,
        });
    });
}

function _initChromeEventForwarding() {
    chrome.tabGroups.onCreated.addListener((tg) => _onCreated._emit(tg));
    chrome.tabGroups.onUpdated.addListener((tg) => _onUpdated._emit(tg));
    chrome.tabGroups.onRemoved.addListener((tg) => _onRemoved._emit(tg));
    _initChromeTransitionTracking();
}

async function _initVivEventTracking() {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
        if (_vivTabIsPanel(t)) continue;
        const group = _vivTabGroup(t);
        const title = _vivTabTitle(t);
        _lastSeen.set(t.id, { group, title, windowId: t.windowId });
        if (group) _bumpGroupCount(group, 1);
    }
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (_bridgeMode) return;                            // bridge takes over IN direction
        if (!('vivExtData' in changeInfo)) return;
        _processVivTabState(tab);
    });
    chrome.tabs.onCreated.addListener((tab) => {
        if (_bridgeMode) return;
        _processVivTabState(tab);
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
        if (_bridgeMode) return;
        const prev = _lastSeen.get(tabId);
        if (prev?.group) {
            const c = _bumpGroupCount(prev.group, -1);
            if (c === 0) _onRemoved._emit({ id: prev.group });
        }
        _lastSeen.delete(tabId);
    });
}

// ---------------------------------------------------------------------------
// Bridge dispatch (called by vivaldiBridgeClient.js when an event arrives from
// the UI mod). The bridge is the source of truth for
// Vivaldi-side stack mutations; we mirror its events into the adapter's
// internal state so subsequent query()/get() reflect reality, then re-emit on
// the same emitters that background.js already subscribes to.
// ---------------------------------------------------------------------------

async function _dispatchBridgeEvent(ev) {
    if (!ev || !ev.type || !ev.payload) return;
    const p = ev.payload;
    switch (ev.type) {
        case 'tabGroupCreated': {
            _lastGroupMeta.set(p.id, { title: p.title || '', color: p.color ?? null, collapsed: !!p.collapsed });
            _onCreated._emit({
                id: p.id, title: p.title || '', windowId: p.windowId,
                color: p.color ?? VIVALDI_SYNTHETIC_COLOR, collapsed: !!p.collapsed,
            });
            break;
        }
        case 'tabGroupUpdated': {
            _lastGroupMeta.set(p.id, { title: p.title || '', color: p.color ?? null, collapsed: !!p.collapsed });
            _onUpdated._emit({
                id: p.id, title: p.title || '', windowId: p.windowId,
                color: p.color ?? VIVALDI_SYNTHETIC_COLOR, collapsed: !!p.collapsed,
            });
            break;
        }
        case 'tabGroupRemoved': {
            _lastGroupMeta.delete(p.id);
            _onRemoved._emit({ id: p.id });
            break;
        }
        case 'tabJoinedTG': {
            _rememberVivTab(p.tabId, p.groupId, p.title || '', p.windowId);
            if (p.color !== undefined && p.color !== null) {
                const meta = _lastGroupMeta.get(p.groupId) || { title: p.title || '', color: null, collapsed: false };
                meta.color = p.color; meta.title = p.title || meta.title;
                _lastGroupMeta.set(p.groupId, meta);
            }
            let tab;
            try { tab = await chrome.tabs.get(p.tabId); } catch { return; }
            _onTabGroupTransition._emit({
                tabId: p.tabId, prevGroupId: '', newGroupId: p.groupId, tab,
            });
            break;
        }
        case 'tabLeftTG': {
            const prev = _lastSeen.get(p.tabId);
            _rememberVivTab(p.tabId, '', '', prev?.windowId);
            let tab;
            try { tab = await chrome.tabs.get(p.tabId); } catch { return; }
            _onTabGroupTransition._emit({
                tabId: p.tabId, prevGroupId: p.prevGroupId || prev?.group || '', newGroupId: '', tab,
            });
            break;
        }
        default:
            // Unknown event types are ignored — protocol may grow.
            break;
    }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

const TGID_NONE_CHROME = (typeof chrome !== 'undefined' && chrome.tabGroups)
    ? chrome.tabGroups.TAB_GROUP_ID_NONE
    : -1;

const tabGroupsAPI = {
    get isVivaldi() {
        return _isVivaldi;
    },

    get ready() {
        return _ready;
    },

    get TAB_GROUP_ID_NONE() {
        return _isVivaldi ? '' : TGID_NONE_CHROME;
    },

    getTabGroupId(tab) {
        if (!tab) return this.TAB_GROUP_ID_NONE;
        if (_isVivaldi) return _cachedVivTabGroup(tab);
        return ('groupId' in tab) ? tab.groupId : this.TAB_GROUP_ID_NONE;
    },

    hasGroup(tab) {
        const id = this.getTabGroupId(tab);
        return _isVivaldi ? !!id : (id > 0);
    },

    async query() {
        await _ready;
        if (_isVivaldi) return _vQuery();
        return new Promise(resolve => chrome.tabGroups.query({}, resolve));
    },

    async queryTabs(groupId) {
        await _ready;
        if (_isVivaldi) return _vTabsForGroup(groupId);
        return new Promise(resolve => chrome.tabs.query({ groupId }, resolve));
    },

    async get(id) {
        await _ready;
        if (_isVivaldi) return _vGet(id);
        if (id === undefined || id === null) return null;
        if (id === TGID_NONE_CHROME) return null;
        try { return await chrome.tabGroups.get(id); }
        catch { return null; }
    },

    async update(id, props) {
        await _ready;
        if (_isVivaldi) return _vUpdate(id, props);
        return chrome.tabGroups.update(id, props);
    },

    async group(opts) {
        await _ready;
        if (_isVivaldi) return _vGroup(opts);
        // Native returns the groupId via callback or Promise depending on signature.
        return new Promise((resolve, reject) => {
            try {
                chrome.tabs.group(opts, (gid) => {
                    if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                    else resolve(gid);
                });
            } catch (e) { reject(e); }
        });
    },

    async ungroup(tabIds) {
        await _ready;
        if (_isVivaldi) return _vUngroup(tabIds);
        return chrome.tabs.ungroup(tabIds);
    },

    onCreated: {
        addListener(cb) {
            _onCreated.addListener(cb);
        },
        removeListener(cb) {
            _onCreated.removeListener(cb);
        },
    },
    onUpdated: {
        addListener(cb) {
            _onUpdated.addListener(cb);
        },
        removeListener(cb) {
            _onUpdated.removeListener(cb);
        },
    },
    onRemoved: {
        addListener(cb) {
            _onRemoved.addListener(cb);
        },
        removeListener(cb) {
            _onRemoved.removeListener(cb);
        },
    },

    // Per-tab membership transitions. Fires `{tabId, prevGroupId, newGroupId, tab}`
    // when a tab joins, leaves, or moves between groups. On Chrome `prevGroupId`
    // is undefined (the native API doesn't surface it). `newGroupId` is the
    // adapter-typed id: empty string on Vivaldi when not in a group; -1 on Chrome.
    onTabGroupTransition: {
        addListener(cb) { _onTabGroupTransition.addListener(cb); },
        removeListener(cb) { _onTabGroupTransition.removeListener(cb); },
    },

    setBridgeMode(active) { _bridgeMode = !!active; },
    dispatchBridgeEvent(ev) { return _dispatchBridgeEvent(ev); },

    // Used by popup.js: resolves when an ungroup of `tabId` is observed.
    // On Chrome we watch changeInfo.groupId; on Vivaldi we watch vivExtData.
    waitForUngroup(tabId, timeoutMs = 500) {
        return _ready.then(() => new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                chrome.tabs.onUpdated.removeListener(handler);
                resolve();
            };
            const handler = (tid, changeInfo, tab) => {
                if (tid !== tabId) return;
                if (_isVivaldi) {
                    if ('vivExtData' in changeInfo && _vivTabGroup(tab) === '') finish();
                } else if ('groupId' in changeInfo && changeInfo.groupId === TGID_NONE_CHROME) {
                    finish();
                }
            };
            chrome.tabs.onUpdated.addListener(handler);
            setTimeout(finish, timeoutMs);
        }));
    },
};

async function _initTabGroupAdapter() {
    _isVivaldi = await _detectVivaldi();
    if (_isVivaldi) await _initVivEventTracking();
    else _initChromeEventForwarding();
}

_ready = _initTabGroupAdapter().catch(e => {
    console.warn('vivaldiTabGroupAdapter: initialization failed, falling back to native tabGroups', e);
    _isVivaldi = false;
    _initChromeEventForwarding();
});

export { tabGroupsAPI };
