/***
 * Vivaldi Tab Stack Bridge — extension client.
 * Receives events from the Vivaldi UI mod
 * (prototype/braintool-stack-bridge.js) and dispatches them via the adapter.
 ***/

import { tabGroupsAPI } from './vivaldiTabGroupAdapter.js';

const BRIDGE_SOURCE = 'bt-vivaldi-stack-bridge';
const PROC_SEQ_KEY = 'vivaldiBridgeProcessedSeq';
const STALE_MS = 12000;

let _enabled = false;
let _lastHbTs = 0;
let _lastVer = null;
let _procSeq = 0;
let _seqLoaded = false;
let _lastEvents = [];
let _lastAlive = false;
let _statusTimer = null;
const _statusListeners = new Set();

const isAlive = () => _lastHbTs && (Date.now() - _lastHbTs < STALE_MS);
const currentStatus = () => ({
    enabled: _enabled,
    alive: !!isAlive(),
    version: _lastVer,
    lastTs: _lastHbTs,
});

async function loadProcessedSeq() {
    if (_seqLoaded) return;
    const r = await chrome.storage.local.get(PROC_SEQ_KEY);
    if (typeof r[PROC_SEQ_KEY] === 'number') _procSeq = r[PROC_SEQ_KEY];
    _seqLoaded = true;
}

function notifyStatus(force = false) {
    const alive = !!isAlive();
    if (!force && alive === _lastAlive) return;
    _lastAlive = alive;
    const status = currentStatus();
    for (const cb of _statusListeners) {
        try { cb(status); }
        catch (e) { console.warn('vivaldiBridgeClient: status listener error', e); }
    }
}

async function dispatch(events) {
    await loadProcessedSeq();
    if (!Array.isArray(events)) return;
    let maxSeq = _procSeq;
    for (const ev of events) {
        if (!ev || typeof ev.seq !== 'number' || ev.seq <= _procSeq) continue;
        try { await tabGroupsAPI.dispatchBridgeEvent(ev); }
        catch (e) { console.warn('vivaldiBridgeClient: dispatch error', ev, e); }
        if (ev.seq > maxSeq) maxSeq = ev.seq;
    }
    if (maxSeq > _procSeq) {
        _procSeq = maxSeq;
        chrome.storage.local.set({ [PROC_SEQ_KEY]: _procSeq });
    }
}

function startStatusTimer() {
    if (_statusTimer) return;
    _statusTimer = setInterval(() => {
        const alive = !!isAlive();
        tabGroupsAPI.setBridgeMode(_enabled && alive);
        notifyStatus();
    }, 2000);
}

function stopStatusTimer() {
    if (!_statusTimer) return;
    clearInterval(_statusTimer);
    _statusTimer = null;
}

async function processBridgeMessage(msg) {
    await loadProcessedSeq();
    const hb = msg.heartbeat || {};
    _lastHbTs = hb.ts || msg.ts || Date.now();
    _lastVer = hb.version || msg.bridgeVersion || msg.version || _lastVer;

    const events = Array.isArray(msg.events) ? msg.events : (msg.event ? [msg.event] : []);
    if (events.length) _lastEvents = events;

    if (_enabled && isAlive()) {
        await tabGroupsAPI.ready;
        tabGroupsAPI.setBridgeMode(true);
        await dispatch(events);
    }

    notifyStatus();
    return {
        ok: true,
        processedSeq: _procSeq,
        enabled: _enabled,
        alive: !!isAlive(),
        version: _lastVer,
    };
}

export const vivaldiBridgeClient = {
    async start() {
        if (_enabled) return;
        _enabled = true;
        startStatusTimer();
        if (isAlive()) {
            await tabGroupsAPI.ready;
            tabGroupsAPI.setBridgeMode(true);
            await dispatch(_lastEvents);
        }
        notifyStatus(true);
    },
    stop() {
        if (!_enabled) return;
        _enabled = false;
        stopStatusTimer();
        tabGroupsAPI.setBridgeMode(false);
        notifyStatus(true);
    },
    isBridgeMessage(msg) {
        return !!msg && msg.source === BRIDGE_SOURCE;
    },
    receiveExternalMessage(msg) {
        if (!this.isBridgeMessage(msg)) return Promise.resolve({ ok: false, ignored: true });
        return processBridgeMessage(msg);
    },
    onStatusChanged(cb) {
        _statusListeners.add(cb);
        return () => _statusListeners.delete(cb);
    },
};

export function getBridgeStatus() {
    return currentStatus();
}
