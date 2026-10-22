/* Volt Streaming promo site: plans and registration against the control plane
 * (GET /api/signup/config, POST /api/signup, POST /api/signup/checkout-status).
 * No framework, no build. docs: volt-app/docs/ONBOARDING.md */
(function () {
  const cfg = window.VOLT_SITE || {};
  const API = String(cfg.apiBase || '').replace(/\/+$/, '') + '/api';

  // The default catalogue, so pricing renders even when the API is unreachable.
  const FALLBACK = {
    mode: 'waitlist', onlinePurchase: false, consoleUrl: null, salesEmail: cfg.contactEmail || null,
    plans: [
      { key: 'starter', name: 'Starter', tagline: 'One channel or a run of events, on air today.', priceLabel: '$99 per month', priceNote: 'Server time for events and $0.12 per GB delivered are billed on use', features: ['2 live channels or stations', '1 running at once', 'Live → VOD recordings and clips', 'Web player and share links', 'Email support'], highlight: false, contactSales: false, purchasable: false, trialDays: 0 },
      { key: 'pro', name: 'Pro', tagline: 'A small network: channels, events, radio and FAST.', priceLabel: '$490 per month', priceNote: 'Server time for events and $0.12 per GB delivered are billed on use', features: ['10 live channels or stations', '5 running at once', 'EPG, FAST and VOD → Live', 'Captions and translation add-ons', 'Analytics and operating reports', 'Priority support'], highlight: true, contactSales: false, purchasable: false, trialDays: 0 },
      { key: 'enterprise', name: 'Enterprise', tagline: 'Your own capacity, rights rules, DRM and single sign-on.', priceLabel: null, priceNote: 'Committed capacity and bandwidth, priced to your workload', features: ['Channels and concurrency to suit', 'DRM and geo rights at the edge', 'Single sign-on and sub-accounts', 'Dedicated servers on request', 'Named engineer'], highlight: false, contactSales: true, purchasable: false, trialDays: 0 },
    ],
  };

  let configPromise = null;
  function loadConfig() {
    configPromise = configPromise || fetch(API + '/signup/config', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .catch(() => ({ ...FALLBACK, offline: true }));
    return configPromise;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** What the main call to action says in each mode. */
  function ctaLabel(c) {
    if (c.mode === 'open') return 'Start a free trial';
    if (c.mode === 'paid') return 'Get started';
    if (c.mode === 'off') return 'Talk to us';
    return 'Register interest';
  }
  function planCta(p, c) {
    if (p.contactSales || c.mode === 'off') return { label: 'Talk to us', href: `register.html?plan=${encodeURIComponent(p.key)}` };
    if (c.mode === 'open') return { label: p.trialDays ? `Start ${p.trialDays}-day trial` : 'Start now', href: `register.html?plan=${encodeURIComponent(p.key)}` };
    if (c.mode === 'paid') return p.purchasable ? { label: `Buy ${p.name}`, href: `register.html?plan=${encodeURIComponent(p.key)}` } : { label: 'Talk to us', href: `register.html?plan=${encodeURIComponent(p.key)}` };
    return { label: 'Register interest', href: `register.html?plan=${encodeURIComponent(p.key)}` };
  }

  function renderPlans(el, c) {
    el.innerHTML = c.plans.map((p) => {
      const cta = planCta(p, c);
      return `<article class="plan${p.highlight ? ' hl' : ''}">
        ${p.highlight ? '<span class="pill sched tag"><i></i>Most chosen</span>' : ''}
        <h3>${esc(p.name)}</h3>
        <p class="tagline">${esc(p.tagline)}</p>
        <div class="price">${p.priceLabel ? esc(p.priceLabel) : 'Priced to your workload'}</div>
        <div class="pnote">${esc(p.priceNote || '')}</div>
        <ul>${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <a class="btn ${p.highlight ? 'btn-primary' : 'btn-ghost'}" href="${cta.href}">${esc(cta.label)}</a>
      </article>`;
    }).join('');
  }

  function wireCtas(c) {
    document.querySelectorAll('[data-cta]').forEach((a) => { a.textContent = ctaLabel(c); });
    document.querySelectorAll('[data-signin]').forEach((a) => { if (c.consoleUrl) a.href = c.consoleUrl + '/'; else a.hidden = true; });
    document.querySelectorAll('[data-mode-note]').forEach((n) => {
      n.textContent = c.mode === 'open' ? 'Free trial. No card needed. Your first channel can be on air in minutes.'
        : c.mode === 'paid' ? 'Monthly plans, cancel any time. Server time and bandwidth are billed on use.'
        : c.mode === 'off' ? 'Registration is closed for now. Talk to us about access.'
        : 'Volt is opening to new accounts in stages. Register and we will email you when yours is ready.';
    });
  }

  /* ---- home page ---- */
  async function home() {
    const c = await loadConfig();
    wireCtas(c);
    const el = document.getElementById('plans');
    if (el) renderPlans(el, c);
  }

  /* ---- register page ---- */
  async function register() {
    const c = await loadConfig();
    wireCtas(c);
    const q = new URLSearchParams(location.search);
    const form = document.getElementById('reg');
    const pick = document.getElementById('plan-pick');
    const msg = document.getElementById('reg-msg');
    const title = document.getElementById('reg-title');
    const lead = document.getElementById('reg-lead');
    const submit = form.querySelector('button[type=submit]');

    title.textContent = c.mode === 'open' ? 'Start your free trial' : c.mode === 'paid' ? 'Create your account' : c.mode === 'off' ? 'Talk to us' : 'Register your interest';
    lead.textContent = c.mode === 'open'
      ? 'Tell us who you are. We email you a link, you confirm the address with a 6-digit code and choose your password. No card needed.'
      : c.mode === 'paid'
      ? 'Tell us who you are, then pay securely with Stripe. As soon as payment clears we email you a link to confirm your address and choose your password.'
      : 'Volt is opening to new accounts in stages. Leave your details and we will email you when your access is ready.';

    const plans = c.plans || [];
    const wanted = q.get('plan');
    const first = plans.find((p) => p.key === wanted) || plans.find((p) => p.highlight) || plans[0];
    pick.innerHTML = plans.map((p) => `<label><input type="radio" name="plan" value="${esc(p.key)}" ${p.key === first?.key ? 'checked' : ''}>
      <span><b>${esc(p.name)}</b><br><small class="muted">${esc(p.tagline)}</small></span>
      <span class="pp">${p.priceLabel ? esc(p.priceLabel) : "Talk to us"}</span></label>`).join('');
    const updateButton = () => {
      const k = form.plan?.value;
      const p = plans.find((x) => x.key === k);
      submit.textContent = !p ? 'Register'
        : p.contactSales ? 'Send to Volt'
        : c.mode === 'paid' ? (p.purchasable ? 'Continue to payment' : 'Send to Volt')
        : c.mode === 'open' ? 'Start my trial'
        : 'Register interest';
    };
    pick.addEventListener('change', updateButton);
    updateButton();

    if (c.termsUrl || c.privacyUrl) {
      document.getElementById('terms').innerHTML = `By registering you agree to the ${c.termsUrl ? `<a href="${esc(c.termsUrl)}" target="_blank" rel="noopener">terms of service</a>` : 'terms of service'}${c.privacyUrl ? ` and <a href="${esc(c.privacyUrl)}" target="_blank" rel="noopener">privacy policy</a>` : ''}.`;
    }
    if (q.get('cancelled')) show('ok', 'Payment was cancelled and nothing was charged. You can try again or pick a different plan.');
    if (c.offline) show('err', `Registration is not reachable right now. Email ${cfg.contactEmail || 'us'} and we will set you up.`);
    if (c.mode === 'off') { show('err', 'Registration is closed at the moment. Leave your details anyway and we will be in touch.'); }

    function show(kind, text) { msg.className = `msg ${kind}`; msg.textContent = text; msg.hidden = false; }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.hidden = true;
      const email = form.email.value.trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return show('err', 'Enter a work email address.');
      const source = {};
      for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) if (q.get(k)) source[k] = q.get(k).slice(0, 200);
      if (document.referrer && !document.referrer.startsWith(location.origin)) source.referrer = document.referrer.slice(0, 300);
      submit.disabled = true;
      const prev = submit.textContent;
      submit.textContent = 'Sending…';
      try {
        const r = await fetch(API + '/signup', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, name: form.name.value.trim() || null, company: form.company.value.trim() || null, plan: form.plan?.value || null, website: form.website.value, source }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || j.message || `The server answered ${r.status}`);
        if (j.status === 'checkout' && j.checkoutUrl) { location.href = j.checkoutUrl; return; }
        done(j, email);
      } catch (err) {
        show('err', err.message || 'Something stopped the registration. Try again.');
        submit.disabled = false; submit.textContent = prev;
      }
    });

    function done(j, email) {
      const card = document.getElementById('reg-card');
      const head = j.status === 'check_email' ? 'Check your email' : j.status === 'contact' ? 'Thanks, we will be in touch' : 'You are on the list';
      const steps = j.status === 'check_email'
        ? `<ol class="steps-list">
            <li><span><b>Open the email from Volt</b> sent to ${esc(email)} and choose Set up my account.</span></li>
            <li><span><b>Confirm it is you</b> with the 6-digit code we email when you ask for it.</span></li>
            <li><span><b>Choose your password</b> and you are signed in to the console.</span></li>
          </ol>
          <p class="small muted" style="margin-top:18px">The link works once and lasts 7 days. Nothing arrived? Check your junk folder.</p>`
        : `<p class="muted">${esc(j.message || '')}</p>`;
      card.innerHTML = `<div class="done"><p class="eyebrow">Registered</p><h2 class="headline" style="font-size:30px">${head}</h2>${steps}
        ${j.devLink ? `<p class="small" style="margin-top:14px">Test server: <a href="${esc(j.devLink)}">open the welcome link</a>.</p>` : ''}</div>`;
    }
  }

  /* ---- thank-you page after Stripe ---- */
  async function thanks() {
    const c = await loadConfig();
    wireCtas(c);
    const sid = new URLSearchParams(location.search).get('session_id');
    const out = document.getElementById('pay-state');
    if (!sid) { out.textContent = 'We could not find your payment. If you were charged, check your email or contact us.'; return; }
    let tries = 0;
    const tick = async () => {
      tries++;
      try {
        const r = await fetch(API + '/signup/checkout-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) });
        const j = await r.json();
        if (j.status === 'active') {
          out.innerHTML = '<span class="pill live"><i></i>Payment confirmed</span><p style="margin-top:14px">We have emailed your welcome link. Open it, confirm the 6-digit code we send, and choose your password.</p>';
          return;
        }
        if (j.status === 'cancelled') { out.textContent = 'This subscription has been cancelled.'; return; }
      } catch { /* try again */ }
      if (tries < 20) { out.innerHTML = '<span class="pill sched"><i></i>Confirming payment</span><p style="margin-top:14px" class="muted">This usually takes a few seconds.</p>'; setTimeout(tick, 3000); }
      else out.innerHTML = '<p>Payment is still being confirmed. Your welcome email will arrive as soon as it clears, usually within a few minutes.</p>';
    };
    tick();
  }

  window.VoltSite = { home, register, thanks };
})();
