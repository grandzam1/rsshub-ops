(function () {
    const bar = document.createElement('div');
    bar.id = 'state-banner';
    document.body.prepend(bar);

    // Reserve space for the fixed banner. ResizeObserver keeps the padding in
    // sync when the banner wraps or the log section expands; older browsers
    // get a fixed fallback height.
    const FALLBACK_HEIGHT = 40;
    function pad(h) { document.body.style.paddingTop = (h || FALLBACK_HEIGHT) + 'px'; }
    if ('ResizeObserver' in window) {
        new ResizeObserver((entries) => pad(entries[0].target.offsetHeight)).observe(bar);
    } else {
        pad(FALLBACK_HEIGHT);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }
    function fmt(t) {
        const d = new Date(t);
        return isNaN(d.getTime()) ? '—' : d.toLocaleString();
    }
    function dot(v) { return `<span class="dot ${v === true ? 'ok' : v === false ? 'bad' : 'unknown'}"></span>`; }
    function cell(name, inner) { return `<span class="sb">${name}: ${inner}</span>`; }

    const LABELS = {
        RUNNING: 'Running',
        RESTARTING: 'Restarting',
        DEPLOYING: 'Deploying',
        ERROR: 'Error',
        STOPPED: 'Stopped',
        UNKNOWN: 'Unknown',
    };
    let serverElapsed = 0;
    let elapsedAt = Date.now();
    let logsOpen = false;

    function elapsedText() {
        const s = serverElapsed + Math.floor((Date.now() - elapsedAt) / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
    }

    function render(s) {
        serverElapsed = s.elapsedSeconds || 0;
        elapsedAt = Date.now();
        const busy = s.state === 'RESTARTING' || s.state === 'DEPLOYING';
        const stepText = s.step ? ` — step ${s.step.n} of ${s.step.of} (${esc(s.step.name)})` : '';
        const stateInner = busy
            ? `<span class="pulse"></span><b>${LABELS[s.state] || s.state}${stepText}</b> (<span class="sb-elapsed">${elapsedText()}</span>)`
            : `<b>${LABELS[s.state] || 'Unknown'}</b>${s.reason ? ` — ${esc(s.reason)}` : ''} (<span class="sb-elapsed">${elapsedText()}</span>)`;
        const op = s.operation;
        const opText = op
            ? `<b>${esc(op.name)}</b> ${op.ok ? '✓' : '✗'} · ${op.origin === 'github' ? 'from GitHub' : 'from the panel'} · ${fmt(op.at)}${op.message ? ` · ${esc(op.message)}` : ''}`
            : '<b>—</b>';
        const logs = s.state === 'ERROR' && s.logTail
            ? `<details class="sb-logs"${logsOpen ? ' open' : ''}><summary>Last 20 log lines</summary><pre>${esc(s.logTail)}</pre></details>`
            : '';
        bar.className = `sb-${s.state || 'UNKNOWN'}`;
        bar.innerHTML =
            `<span class="sb sb-state">${stateInner}</span>` +
            cell('RSSHub', dot(s.rsshub)) +
            cell('Redis', dot(s.redis)) +
            cell('Since', `<b>${fmt(s.since)}</b>`) +
            cell('Auto-recoveries since boot', `<b>${s.restarts == null ? '—' : esc(s.restarts)}</b>`) +
            cell('Last deploy', `<b>${fmt(s.lastDeploy)}</b>`) +
            cell('Last op', opText) +
            logs;
        const det = bar.querySelector('details.sb-logs');
        if (det) det.addEventListener('toggle', () => { logsOpen = det.open; });
        // disable mutating buttons while an operation is in progress
        document.querySelectorAll('.op-btn').forEach((b) => {
            b.disabled = busy;
            b.title = busy ? 'An operation is in progress' : '';
        });
    }

    async function tick() {
        try {
            const r = await fetch('/panel/api/state');
            if (r.ok) render(await r.json());
        } catch {}
    }
    tick();
    setInterval(tick, 5000);
    // update "time in state" every second between polls
    setInterval(() => {
        const el = bar.querySelector('.sb-elapsed');
        if (el) el.textContent = elapsedText();
    }, 1000);
})();
