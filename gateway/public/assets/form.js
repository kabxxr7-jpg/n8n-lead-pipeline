(function () {
  'use strict';

  var startedAt = Date.now();

  var form = document.getElementById('lead-form');
  if (!form) return;

  var alertBox = document.getElementById('form-alert');
  var submitBtn = document.getElementById('submit-btn');
  var btnLabel = submitBtn.querySelector('.btn-label');
  var sendingStatus = document.getElementById('sending-status');
  var message = document.getElementById('f-message');
  var counter = document.getElementById('message-counter');

  var MSG_MIN = 20;
  var MSG_MAX = 1500;
  var FIELD_ORDER = ['name', 'email', 'company', 'website', 'service', 'budget', 'timeline', 'message', 'crm', 'consent'];
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var sending = false;

  /* ---------- Character counter ---------- */
  function updateCounter() {
    var n = message.value.trim().length;
    counter.textContent = n + ' / ' + MSG_MAX;
    counter.classList.remove('is-short', 'is-over', 'is-ok');
    if (n > MSG_MAX) counter.classList.add('is-over');
    else if (n >= MSG_MIN) counter.classList.add('is-ok');
    else counter.classList.add('is-short');
  }
  message.addEventListener('input', updateCounter);
  updateCounter();

  /* ---------- Error helpers ---------- */
  function fieldWrap(name) {
    return form.querySelector('[data-field="' + name + '"]');
  }
  function controlFor(name) {
    return form.elements[name];
  }
  function setFieldError(name, text) {
    var wrap = fieldWrap(name);
    var err = document.getElementById('e-' + name);
    var ctrl = controlFor(name);
    if (!wrap || !err) return false;
    err.textContent = text || '';
    wrap.classList.toggle('has-error', !!text);
    if (ctrl && ctrl.setAttribute) {
      if (text) ctrl.setAttribute('aria-invalid', 'true');
      else ctrl.removeAttribute('aria-invalid');
    }
    return true;
  }
  function clearErrors() {
    FIELD_ORDER.forEach(function (f) { setFieldError(f, ''); });
  }
  function showAlert(kind, title, body) {
    alertBox.className = 'alert alert--' + kind;
    alertBox.textContent = '';
    var strong = document.createElement('strong');
    strong.textContent = title;
    alertBox.appendChild(strong);
    if (body) alertBox.appendChild(document.createTextNode(body));
    alertBox.focus({ preventScroll: true });
    alertBox.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
  function clearAlert() {
    alertBox.className = 'alert';
    alertBox.textContent = '';
  }
  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function focusFirstError(errors) {
    for (var i = 0; i < FIELD_ORDER.length; i++) {
      if (errors[FIELD_ORDER[i]]) {
        var ctrl = controlFor(FIELD_ORDER[i]);
        if (ctrl && ctrl.focus) ctrl.focus();
        return;
      }
    }
  }

  // Clear a field's error as soon as the user edits it
  FIELD_ORDER.forEach(function (f) {
    var ctrl = controlFor(f);
    if (!ctrl || !ctrl.addEventListener) return;
    var evt = (ctrl.type === 'checkbox' || ctrl.tagName === 'SELECT') ? 'change' : 'input';
    ctrl.addEventListener(evt, function () {
      if (fieldWrap(f) && fieldWrap(f).classList.contains('has-error')) setFieldError(f, '');
    });
  });

  /* ---------- Data + validation ---------- */
  function val(name) {
    var el = controlFor(name);
    return el && typeof el.value === 'string' ? el.value.trim() : '';
  }
  function collect() {
    var sim = form.querySelector('input[name="simulate"]:checked');
    var crm = form.querySelector('input[name="crm"]:checked');
    return {
      name: val('name'),
      email: val('email'),
      company: val('company'),
      website: val('website'),
      service: val('service'),
      budget: val('budget'),
      timeline: val('timeline'),
      message: val('message'),
      consent: !!controlFor('consent').checked,
      simulate: sim ? sim.value : 'none',
      crm: crm ? crm.value : 'hubspot',
      fax: controlFor('fax').value,
      started_at: startedAt
    };
  }
  function validate(d) {
    var e = {};
    if (!d.name) e.name = 'Please enter your name.';
    else if (d.name.length > 120) e.name = 'That name is a bit long (120 characters max).';
    if (!d.email) e.email = 'Please enter your work email.';
    else if (!EMAIL_RE.test(d.email) || d.email.length > 200) e.email = 'That email doesn’t look right. Check for typos.';
    if (!d.company) e.company = 'Please enter your company name.';
    if (d.website && (/\s/.test(d.website) || d.website.indexOf('.') === -1)) e.website = 'Enter a web address like example.com, or leave it blank.';
    if (!d.service) e.service = 'Please choose a service.';
    if (!d.budget) e.budget = 'Please choose a budget range.';
    if (!d.timeline) e.timeline = 'Please choose a timeline.';
    if (!d.message) e.message = 'Please tell us a little about your project.';
    else if (d.message.length < MSG_MIN) e.message = 'A little more detail please: at least ' + MSG_MIN + ' characters (' + d.message.length + ' so far).';
    else if (d.message.length > MSG_MAX) e.message = 'Please keep it under ' + MSG_MAX + ' characters (' + d.message.length + ' now).';
    if (!d.consent) e.consent = 'Please tick the box to continue.';
    return e;
  }

  /* ---------- Sending state ---------- */
  function setSending(on) {
    sending = on;
    submitBtn.disabled = on;
    submitBtn.classList.toggle('is-loading', on);
    submitBtn.setAttribute('aria-busy', on ? 'true' : 'false');
    btnLabel.textContent = on ? 'Sending…' : 'Send enquiry';
    sendingStatus.textContent = on ? 'Sending your enquiry.' : '';
  }

  function minutesText(seconds) {
    var s = Math.max(1, Math.round(Number(seconds) || 60));
    if (s < 60) return s + (s === 1 ? ' second' : ' seconds');
    var m = Math.ceil(s / 60);
    return m + (m === 1 ? ' minute' : ' minutes');
  }

  function safeStatusUrl(url, id) {
    // Only follow same-origin relative paths to the status page.
    if (typeof url === 'string' && /^\/status(\.html)?\?/.test(url)) return url;
    if (id) return '/status?id=' + encodeURIComponent(id);
    return null;
  }

  /* ---------- Submit ---------- */
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (sending) return;
    clearAlert();
    clearErrors();

    var data = collect();
    var errors = validate(data);
    if (Object.keys(errors).length) {
      Object.keys(errors).forEach(function (k) { setFieldError(k, errors[k]); });
      focusFirstError(errors);
      return;
    }

    setSending(true);

    fetch('/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(data)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { status: res.status, body: body || {} };
      });
    }).then(function (r) {
      var b = r.body;
      if (r.status === 202 && b.ok) {
        var dest = safeStatusUrl(b.status_url, b.lead_id);
        if (dest) {
          sendingStatus.textContent = 'Sent. Opening your live status page.';
          btnLabel.textContent = 'Sent, opening status…';
          window.location.assign(dest);
          return;
        }
        setSending(false);
        showAlert('info', 'Thanks, your enquiry was received.', ' Check your inbox for a reply.');
        return;
      }
      setSending(false);
      if (r.status === 400 && b.fields && typeof b.fields === 'object') {
        var shown = {};
        var unmatched = [];
        Object.keys(b.fields).forEach(function (k) {
          var msg = String(b.fields[k]);
          if (setFieldError(k, msg)) shown[k] = true;
          else unmatched.push(msg);
        });
        showAlert('error', 'Please check the highlighted fields.', unmatched.length ? ' ' + unmatched.join(' ') : '');
        focusFirstError(shown);
        return;
      }
      if (r.status === 422 && b.error === 'spam_suspected') {
        showAlert('warn', 'We couldn’t accept that submission.',
          ' Our spam guard flagged it' + (b.reason ? ': ' + String(b.reason) : '') + '. If you’re a real person, wait a few seconds and try again.');
        return;
      }
      if (r.status === 429) {
        showAlert('warn', 'You’ve sent a few already.', ' Try again in ' + minutesText(b.retry_after_s) + '.');
        return;
      }
      if (r.status === 503 && b.error === 'daily_cap') {
        showAlert('warn', 'Demo daily limit reached.', ' This demo caps submissions per day to keep costs sane. Please try tomorrow.');
        return;
      }
      showAlert('error', 'Something went wrong on our side.', ' Your enquiry wasn’t sent. Please try again in a moment.');
    }).catch(function () {
      setSending(false);
      showAlert('error', 'We couldn’t reach the server.', ' Check your connection and try again.');
    });
  });

  // If the page is restored from the back/forward cache, reset the button.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) setSending(false);
  });
})();
