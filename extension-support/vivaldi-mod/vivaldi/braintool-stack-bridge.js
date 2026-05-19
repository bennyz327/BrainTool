/***
 * BrainTool Vivaldi Tab Stack Bridge — UI mod.
 * Runs in chrome://vivaldi-webui (patched into window.html); sends stack
 * events to the BrainTool extension via cross-extension runtime messaging.
 * Debug: set window.__BT_BRIDGE_DEBUG = true.
 ***/
(function () {
    'use strict';

    const VERSION = '0.3';
    const BRIDGE_SOURCE = 'bt-vivaldi-stack-bridge';
    const HEARTBEAT_MS = 5000;
    const BUF_MAX = 200;
    const TARGET_KEY = '__bt_viv_bridge_extension_id';
    const SCRIPT = document.currentScript;
    const K = {
        heartbeat: '__bt_viv_bridge_heartbeat',
        events:    '__bt_viv_bridge_events',
        procSeq:   '__bt_viv_bridge_processed_seq',
    };
    const TAG = '[BT_BRIDGE]';
    const log = (...a) => console.log(TAG, ...a);
    const dbg = (...a) => { if (window.__BT_BRIDGE_DEBUG) console.log(TAG, ...a); };

    const parse = (t) => { try { return JSON.parse(t?.vivExtData || '{}'); } catch { return {}; } };
    const getGroup     = (t) => parse(t).group || '';
    const getTitle     = (t) => parse(t).fixedGroupTitle || '';
    const getColor     = (t) => parse(t).groupColor || null;
    const getCollapsed = (t) => { const v = parse(t); return !!(v.collapsed ?? v.folded); };
    const isPanel      = (t) => !!parse(t).panelId;

    const _seen  = new Map();   // tabId → {group, title, color, collapsed, windowId, raw}
    const _count = new Map();   // groupId → count
    const _meta  = new Map();   // groupId → {title, color, collapsed}
    let _events  = [];
    let _seq     = 0;
    let _writeQueued = false;
    let _sendQueued = false;
    let _targetExtensionId = null;
    let _lastSendOk = 0;

    function bump(gid, d) {
        if (!gid) return 0;
        const n = (_count.get(gid) || 0) + d;
        if (n <= 0) { _count.delete(gid); return 0; }
        _count.set(gid, n); return n;
    }

    const cleanId = (id) => (typeof id === 'string' && id.trim()) ? id.trim() : null;

    function configuredTargetId() {
        return cleanId(window.__BT_BRIDGE_EXTENSION_ID)
            || cleanId(SCRIPT?.dataset?.btExtensionId)
            || cleanId(SCRIPT?.getAttribute?.('data-bt-extension-id'))
            || cleanId(localStorage.getItem(TARGET_KEY));
    }

    function setTargetExtensionId(id) {
        const cleaned = cleanId(id);
        if (!cleaned) {
            localStorage.removeItem(TARGET_KEY);
            _targetExtensionId = null;
            log('target extension id cleared');
            return;
        }
        localStorage.setItem(TARGET_KEY, cleaned);
        _targetExtensionId = cleaned;
        log('target extension id set', cleaned);
        queueSend();
    }

    async function discoverTargetExtensionId() {
        const configured = configuredTargetId();
        if (configured) return configured;

        if (!chrome.management?.getAll) return null;
        try {
            const exts = await new Promise((resolve) => {
                chrome.management.getAll((items) => resolve(chrome.runtime.lastError ? [] : items));
            });
            const bt = exts.find(e => e?.enabled && /\bBrainTool\b/i.test(`${e.name || ''} ${e.shortName || ''}`));
            return cleanId(bt?.id);
        } catch {
            return null;
        }
    }

    function trimEventsThrough(seq) {
        if (typeof seq !== 'number') return;
        _events = _events.filter(e => e.seq > seq);
    }

    function queueStorageWrite() {
        if (_writeQueued) return;
        _writeQueued = true;
        Promise.resolve().then(() => {
            _writeQueued = false;
            chrome.storage.local.set({ [K.events]: _events });
        });
    }

    function sendBridgeMessage(reason = 'events') {
        if (!_targetExtensionId) {
            dbg('no target extension id; bridge message not sent', { reason });
            return;
        }
        const msg = {
            source: BRIDGE_SOURCE,
            bridgeVersion: VERSION,
            reason,
            ts: Date.now(),
            heartbeat: { ts: Date.now(), version: VERSION },
            events: _events.slice(-BUF_MAX),
        };
        chrome.runtime.sendMessage(_targetExtensionId, msg, (rsp) => {
            const err = chrome.runtime.lastError;
            if (err) {
                dbg('send failed', { target: _targetExtensionId, reason, error: err.message });
                return;
            }
            if (!rsp?.ok) {
                dbg('send rejected', { target: _targetExtensionId, reason, response: rsp });
                return;
            }
            _lastSendOk = Date.now();
            trimEventsThrough(rsp.processedSeq);
            queueStorageWrite();
            dbg('send ok', { reason, processedSeq: rsp.processedSeq, enabled: rsp.enabled, alive: rsp.alive });
        });
    }

    function queueSend() {
        if (_sendQueued) return;
        _sendQueued = true;
        Promise.resolve().then(() => {
            _sendQueued = false;
            sendBridgeMessage('events');
        });
    }

    function emit(type, payload) {
        const ev = { seq: ++_seq, type, payload, ts: Date.now() };
        log(type, payload);
        _events.push(ev);
        if (_events.length > BUF_MAX) _events = _events.slice(-BUF_MAX);
        queueStorageWrite();
        queueSend();
    }

    function process(tab) {
        if (isPanel(tab)) return;
        const id = tab.id;
        const group     = getGroup(tab);
        const title     = getTitle(tab);
        const color     = getColor(tab);
        const collapsed = getCollapsed(tab);
        const raw       = tab.vivExtData || '';
        const prev = _seen.get(id) || { group: '', title: '', color: null, collapsed: false, windowId: tab.windowId, raw: '' };

        // Verbose vivExtData diff — used to discover where `collapsed` lives.
        if (window.__BT_BRIDGE_DEBUG && raw !== prev.raw) {
            try {
                const a = JSON.parse(prev.raw || '{}'), b = JSON.parse(raw || '{}');
                const ch = {};
                for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
                    if (a[k] !== b[k]) ch[k] = { from: a[k], to: b[k] };
                }
                if (Object.keys(ch).length) dbg('vivExtData.diff', { tabId: id, changes: ch });
            } catch {}
        }

        if (group !== prev.group) {
            if (prev.group) {
                emit('tabLeftTG', { tabId: id, prevGroupId: prev.group });
                if (bump(prev.group, -1) === 0) { emit('tabGroupRemoved', { id: prev.group }); _meta.delete(prev.group); }
            }
            if (group) {
                const isNew = bump(group, 1) === 1;
                if (isNew) {
                    _meta.set(group, { title, color, collapsed });
                    emit('tabGroupCreated', { id: group, title, windowId: tab.windowId, color, collapsed });
                }
                emit('tabJoinedTG', { tabId: id, groupId: group, title, windowId: tab.windowId, color });
            }
        } else if (group) {
            const m = _meta.get(group) || { title: '', color: null, collapsed: false };
            if (title !== m.title || color !== m.color || collapsed !== m.collapsed) {
                _meta.set(group, { title, color, collapsed });
                emit('tabGroupUpdated', { id: group, title, windowId: tab.windowId, color, collapsed });
            }
        }
        _seen.set(id, { group, title, color, collapsed, windowId: tab.windowId, raw });
    }

    async function snapshot() {
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) process(t);
    }

    (async () => {
        // Discovery — answers runtime identity, target BT extension id, and
        // Vivaldi API surface (for collapsed/other field hunting).
        _targetExtensionId = await discoverTargetExtensionId();
        log('discover', {
            runtimeId: chrome?.runtime?.id ?? null,
            targetExtensionId: _targetExtensionId,
            vivaldiKeys: typeof vivaldi !== 'undefined' ? Object.keys(vivaldi) : null,
            tabsPrivateKeys: typeof vivaldi !== 'undefined' && vivaldi.tabsPrivate ? Object.keys(vivaldi.tabsPrivate) : null,
        });
        if (!_targetExtensionId) {
            log(`target extension id not configured; add data-bt-extension-id to the script tag or run window.__BT_BRIDGE.setTargetExtensionId('<BrainTool extension id>')`);
        }

        // Seed lastSeen / counts from current tabs (no emit on initial state).
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) {
            if (isPanel(t)) continue;
            const group = getGroup(t), title = getTitle(t), color = getColor(t), collapsed = getCollapsed(t);
            _seen.set(t.id, { group, title, color, collapsed, windowId: t.windowId, raw: t.vivExtData || '' });
            if (group) {
                bump(group, 1);
                if (!_meta.has(group)) _meta.set(group, { title, color, collapsed });
            }
        }
        log('seeded', { tabs: _seen.size, groups: _count.size });

        chrome.tabs.onUpdated.addListener((tabId, ci, tab) => {
            if (ci.vivExtData === undefined) return;
            process(tab);
        });
        chrome.tabs.onCreated.addListener(process);
        chrome.tabs.onRemoved.addListener((tabId) => {
            const prev = _seen.get(tabId);
            if (prev?.group) {
                emit('tabLeftTG', { tabId, prevGroupId: prev.group });
                if (bump(prev.group, -1) === 0) { emit('tabGroupRemoved', { id: prev.group }); _meta.delete(prev.group); }
            }
            _seen.delete(tabId);
        });

        // Extension acks processed seq → trim our buffer.
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            const v = changes[K.procSeq]?.newValue;
            if (typeof v !== 'number') return;
            trimEventsThrough(v);
        });

        // Heartbeat.
        const beat = () => {
            chrome.storage.local.set({ [K.heartbeat]: { ts: Date.now(), version: VERSION, targetExtensionId: _targetExtensionId, lastSendOk: _lastSendOk } });
            sendBridgeMessage('heartbeat');
        };
        beat();
        setInterval(beat, HEARTBEAT_MS);

        window.__BT_BRIDGE = {
            version: VERSION,
            seen: _seen,
            count: _count,
            meta: _meta,
            events: () => _events.slice(),
            snapshot,
            getTargetExtensionId: () => _targetExtensionId,
            setTargetExtensionId,
            sendNow: () => sendBridgeMessage('manual'),
        };
        log('ready', { version: VERSION });
    })();
})();
