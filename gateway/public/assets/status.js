(function () {
  'use strict';

  var POLL_MS = 1500;
  var MAX_MS = 3 * 60 * 1000;
  var MAX_NET_ERRORS = 8;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var STEP_ORDER = ['received', 'validated', 'qualified', 'crm_contact', 'crm_note', 'reply_email', 'team_alert', 'done'];
  var DEFAULT_LABELS = {
    received: 'Submission received',
    validated: 'Validated & spam-checked',
    qualified: 'AI qualified the lead',
    crm_contact: 'HubSpot contact',
    crm_note: 'HubSpot note',
    reply_email: 'Email reply sent',
    team_alert: 'Team alerted',
    done: 'Done'
  };
  var STATE_TEXT = { pending: 'Pending', running: 'Running', ok: 'Done', failed: 'Failed', skipped: 'Skipped' };
  var SIM_TEXT = {
    crm_outage: 'Simulated failure: CRM outage',
    ai_invalid: 'Simulated failure: invalid AI output'
  };

  function $(id) { return document.getElementById(id); }

  var els = {
    stateMsg: $('state-msg'), stateTitle: $('state-title'), stateText: $('state-text'), stateLink: $('state-link'),
    view: $('status-view'), title: $('status-title'), sub: $('status-sub'), chips: $('chips'),
    pill: $('live-pill'), pillText: $('live-text'), announcer: $('announcer'),
    outcome: $('outcome'), outcomeTitle: $('outcome-title'), outcomeText: $('outcome-text'), outcomeInbox: $('outcome-inbox'),
    timeline: $('timeline'), elapsed: $('elapsed'),
    scoreWait: $('score-wait'), scoreBody: $('score-body'), scoreRing: $('score-ring'), scoreNum: $('score-num'),
    tierPill: $('tier-pill'), scoreReason: $('score-reason'), scoreBy: $('score-by'),
    leadName: $('lead-name'), leadCompany: $('lead-company'), leadEmail: $('lead-email'), leadId: $('lead-id')
  };

  var params = new URLSearchParams(window.location.search);
  var id = (params.get('id') || '').trim();
  var startedPolling = Date.now();
  var netErrors = 0;
  var stopped = false;
  var stepNodes = {};
  var lastStates = {};
  var lastDetailJson = {};
  var shownOutcome = false;
  var firstRender = true;

  /* ---------- Small helpers ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgIcon(state) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var p = document.createElementNS(SVG_NS, 'path');
    if (state === 'ok') p.setAttribute('d', 'M3.5 8.5l3 3 6-7');
    else if (state === 'failed') p.setAttribute('d', 'M4.5 4.5l7 7M11.5 4.5l-7 7');
    else p.setAttribute('d', 'M4.5 8h7');
    svg.appendChild(p);
    return svg;
  }
  function parseTime(s) {
    if (!s) return NaN;
    var t = Date.parse(s);
    return isNaN(t) ? NaN : t;
  }
  function fmtOffset(ms) {
    if (isNaN(ms)) return '';
    var s = Math.max(0, ms) / 1000;
    if (s < 60) return '+' + s.toFixed(1) + ' s';
    var m = Math.floor(s / 60);
    var rest = Math.round(s - m * 60);
    return '+' + m + ' m ' + (rest < 10 ? '0' : '') + rest + ' s';
  }
  function fmtDuration(ms) {
    var s = Math.max(0, ms) / 1000;
    if (s < 60) return s.toFixed(1) + ' s';
    var m = Math.floor(s / 60);
    return m + ' m ' + Math.round(s - m * 60) + ' s';
  }
  function humanKey(k) {
    var s = String(k).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function announce(text) {
    els.announcer.textContent = text;
  }
  function show(node) { node.classList.remove('hidden'); }
  function hide(node) { node.classList.add('hidden'); }

  /* ---------- Page states ---------- */
  function showMessage(title, text, withLink) {
    hide(els.view);
    show(els.stateMsg);
    els.stateTitle.textContent = title;
    els.stateText.textContent = text;
    if (withLink) show(els.stateLink); else hide(els.stateLink);
  }

  /* ---------- Detail rendering (key/value, never innerHTML) ---------- */
  function renderValue(v) {
    if (v === null || v === undefined) return el('span', null, '–');
    if (typeof v === 'boolean') return el('span', null, v ? 'yes' : 'no');
    if (typeof v === 'number' || typeof v === 'string') return el('span', null, String(v));
    var json;
    try { json = JSON.stringify(v); } catch (e) { json = String(v); }
    if (json && json.length > 400) json = json.slice(0, 400) + '…';
    return el('code', null, json);
  }
  function renderDetail(detail) {
    var dl = el('dl', 'kv');
    var keys = Object.keys(detail);
    if (!keys.length) {
      dl.appendChild(el('dt', null, 'Info'));
      dl.appendChild(el('dd', null, 'No extra details.'));
      return dl;
    }
    keys.forEach(function (k) {
      dl.appendChild(el('dt', null, humanKey(k)));
      var dd = el('dd');
      dd.appendChild(renderValue(detail[k]));
      dl.appendChild(dd);
    });
    return dl;
  }

  /* ---------- Timeline ---------- */
  function ensureStepNode(key) {
    if (stepNodes[key]) return stepNodes[key];
    var li = el('li', 'tl-step state-pending');
    var icon = el('span', 'tl-icon');
    icon.setAttribute('aria-hidden', 'true');
    var body = el('div', 'tl-body');
    var row = el('div', 'tl-row');
    var labelWrap = el('span');
    var label = el('span', 'tl-label');
    var state = el('span', 'tl-state');
    labelWrap.appendChild(label);
    labelWrap.appendChild(state);
    var time = el('span', 'tl-time');
    row.appendChild(labelWrap);
    row.appendChild(time);
    var summary = el('p', 'tl-summary');
    var details = el('details', 'tl-details hidden');
    var sum = el('summary', null, 'Details');
    var detailBody = el('div');
    details.appendChild(sum);
    details.appendChild(detailBody);
    body.appendChild(row);
    body.appendChild(summary);
    body.appendChild(details);
    li.appendChild(icon);
    li.appendChild(body);
    els.timeline.appendChild(li);
    stepNodes[key] = { li: li, icon: icon, label: label, state: state, time: time, summary: summary, details: details, detailBody: detailBody, iconState: null };
    return stepNodes[key];
  }

  function updateStep(step, createdAt) {
    var key = String(step.key || '');
    var n = ensureStepNode(key);
    var st = STATE_TEXT[step.state] ? step.state : 'pending';
    var label = step.label || DEFAULT_LABELS[key] || humanKey(key);

    n.li.className = 'tl-step state-' + st;
    n.label.textContent = label;
    n.state.textContent = STATE_TEXT[st];

    if (n.iconState !== st) {
      n.icon.textContent = '';
      if (st === 'ok' || st === 'failed' || st === 'skipped') n.icon.appendChild(svgIcon(st));
      else n.icon.appendChild(el('span', 'tl-dot'));
      n.iconState = st;
    }

    var at = parseTime(step.at);
    n.time.textContent = (!isNaN(at) && !isNaN(createdAt)) ? fmtOffset(at - createdAt) : '';
    if (n.time.textContent) n.time.setAttribute('title', new Date(at).toLocaleTimeString());

    n.summary.textContent = step.summary || (st === 'pending' ? 'Waiting…' : '');

    if (step.detail && typeof step.detail === 'object') {
      var json;
      try { json = JSON.stringify(step.detail); } catch (e) { json = ''; }
      if (json !== lastDetailJson[key]) {
        lastDetailJson[key] = json;
        n.detailBody.textContent = '';
        n.detailBody.appendChild(renderDetail(step.detail));
      }
      show(n.details);
    } else {
      hide(n.details);
    }

    if (!firstRender && lastStates[key] && lastStates[key] !== st && (st === 'ok' || st === 'failed' || st === 'running')) {
      announce(label + ': ' + STATE_TEXT[st].toLowerCase() + (step.summary ? '. ' + step.summary : ''));
    }
    lastStates[key] = st;
  }

  function renderSteps(steps, createdAt) {
    var byKey = {};
    (Array.isArray(steps) ? steps : []).forEach(function (s) { if (s && s.key) byKey[s.key] = s; });
    var keys = STEP_ORDER.slice();
    Object.keys(byKey).forEach(function (k) { if (keys.indexOf(k) === -1) keys.splice(keys.length - 1, 0, k); });
    keys.forEach(function (k) {
      updateStep(byKey[k] || { key: k, state: 'pending', summary: '', detail: null }, createdAt);
    });
  }

  /* ---------- Score card ---------- */
  function renderScore(q) {
    if (!q || typeof q !== 'object') {
      show(els.scoreWait);
      hide(els.scoreBody);
      return;
    }
    hide(els.scoreWait);
    show(els.scoreBody);
    var score = Math.max(0, Math.min(100, Math.round(Number(q.score) || 0)));
    var tier = (q.tier === 'hot' || q.tier === 'warm' || q.tier === 'cold') ? q.tier : 'cold';
    els.scoreNum.textContent = String(score);
    els.scoreRing.className = 'score-ring tier-' + tier;
    els.tierPill.className = 'tier-pill tier-' + tier;
    els.tierPill.textContent = tier;
    els.scoreReason.textContent = q.reason || '';
    var fallback = q.scored_by === 'rules-fallback';
    els.scoreBody.classList.toggle('is-fallback', fallback);
    els.scoreBy.textContent = fallback
      ? 'Scored by the rules fallback: ' + (q.fallback_reason || 'the AI response could not be used')
      : 'Scored by Google Gemini (structured output, schema-checked)';
  }

  /* ---------- Outcome ---------- */
  function lastStepTime(steps) {
    var max = NaN;
    (steps || []).forEach(function (s) {
      var t = parseTime(s && s.at);
      if (!isNaN(t) && (isNaN(max) || t > max)) max = t;
    });
    return max;
  }

  function renderOutcome(data, createdAt) {
    var lastAt = lastStepTime(data.steps);
    var total = (!isNaN(lastAt) && !isNaN(createdAt)) ? fmtDuration(lastAt - createdAt) : null;

    if (data.finished) {
      var o = data.outcome;
      els.outcome.className = 'card outcome fade-in' + (o === 'partial' ? ' is-partial' : o === 'failed' ? ' is-failed' : '');
      if (o === 'ok') {
        els.outcomeTitle.textContent = total ? 'All steps done in ' + total : 'All steps done';
        els.outcomeText.textContent = 'The lead was scored, saved to HubSpot, replied to and handed to the team.';
        setPill('is-done', 'Completed');
        els.title.textContent = 'All done';
      } else if (o === 'partial') {
        els.outcomeTitle.textContent = 'Finished with a failure handled: the team was alerted';
        els.outcomeText.textContent = 'One step failed, the workflow recovered and nothing was lost' + (total ? ' (' + total + ' in total).' : '.');
        setPill('is-warn', 'Finished, failure handled');
        els.title.textContent = 'Finished, with a failure handled';
      } else {
        els.outcomeTitle.textContent = 'Finished with a failure: the team was alerted';
        els.outcomeText.textContent = 'Something could not be completed automatically, so a person will follow up' + (total ? ' (' + total + ' in total).' : '.');
        setPill('is-fail', 'Finished with a failure');
        els.title.textContent = 'Finished with a failure';
      }
      els.outcomeInbox.textContent = 'Check your inbox for the reply from Fernbrook Studio (demo).';
      els.sub.textContent = 'This run is complete. Expand any step to see what happened.';
    } else {
      els.outcome.className = 'card outcome fade-in is-partial';
      els.outcomeTitle.textContent = 'This run stopped reporting progress';
      els.outcomeText.textContent = 'The workflow hasn’t updated for a while. The team gets alerted about stalled runs, and your reply may still arrive.';
      els.outcomeInbox.textContent = 'Check your inbox for the reply from Fernbrook Studio (demo).';
      setPill('is-warn', 'Stalled');
      els.title.textContent = 'Taking longer than expected';
      els.sub.textContent = 'Live updates have stopped for this run.';
    }
    show(els.outcome);
    if (!shownOutcome) {
      shownOutcome = true;
      announce(els.outcomeTitle.textContent);
    }
  }

  function setPill(cls, text) {
    els.pill.className = 'live-pill ' + cls;
    els.pillText.textContent = text;
  }

  /* ---------- Main render ---------- */
  function render(data) {
    hide(els.stateMsg);
    show(els.view);

    var createdAt = parseTime(data.created_at);
    var lead = data.lead || {};
    els.leadName.textContent = lead.first_name || '–';
    els.leadCompany.textContent = lead.company || '–';
    els.leadEmail.textContent = lead.email_masked || '–';
    els.leadId.textContent = data.lead_id || id;

    if (firstRender && lead.first_name) {
      els.title.textContent = 'Thanks, ' + lead.first_name + '. Your enquiry is on its way';
    }

    els.chips.textContent = '';
    (Array.isArray(data.simulated) ? data.simulated : []).forEach(function (s) {
      els.chips.appendChild(el('span', 'chip chip--sim', SIM_TEXT[s] || 'Simulated failure: ' + String(s)));
    });

    renderScore(data.qualification);
    renderSteps(data.steps, createdAt);

    var done = !!data.finished || !!data.stalled;
    if (!done && !isNaN(createdAt)) {
      els.elapsed.textContent = fmtDuration(Date.now() - createdAt) + ' elapsed';
    } else if (done) {
      var lastAt = lastStepTime(data.steps);
      els.elapsed.textContent = (!isNaN(lastAt) && !isNaN(createdAt)) ? fmtDuration(lastAt - createdAt) + ' total' : '';
    }

    if (done) renderOutcome(data, createdAt);
    else setPill('is-live', 'Live');

    firstRender = false;
    return done;
  }

  /* ---------- Polling ---------- */
  function schedule() {
    if (stopped) return;
    if (Date.now() - startedPolling > MAX_MS) {
      stopped = true;
      setPill('is-warn', 'Paused');
      els.sub.textContent = 'Live updates paused after 3 minutes. Refresh the page to check again.';
      announce('Live updates paused. Refresh the page to check again.');
      return;
    }
    window.setTimeout(poll, POLL_MS);
  }

  function poll() {
    fetch('/api/status?id=' + encodeURIComponent(id), {
      headers: { 'Accept': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (res) {
      if (res.status === 404) {
        stopped = true;
        showMessage('We couldn’t find that submission', 'The link may be mistyped, or the demo data has already been cleaned up.', true);
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json().then(function (data) {
        netErrors = 0;
        if (!data || typeof data !== 'object') throw new Error('bad body');
        var done = render(data);
        if (done) {
          stopped = true;
          return;
        }
        schedule();
      });
    }).catch(function () {
      if (stopped) return;
      netErrors += 1;
      if (netErrors >= MAX_NET_ERRORS) {
        stopped = true;
        if (els.view.classList.contains('hidden')) {
          showMessage('We couldn’t load this submission', 'The status service isn’t responding right now. Please refresh in a moment.', true);
        } else {
          setPill('is-warn', 'Connection lost');
          els.sub.textContent = 'We lost the connection to the status service. Refresh to try again.';
        }
        return;
      }
      if (!els.view.classList.contains('hidden')) setPill('is-warn', 'Reconnecting…');
      schedule();
    });
  }

  /* ---------- Boot ---------- */
  if (!id || id.length > 100 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    showMessage('We couldn’t find that submission', 'This link is missing a valid submission ID.', true);
    return;
  }
  poll();
})();
