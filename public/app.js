const app = document.querySelector('#app');
const toastRegion = document.querySelector('#toast-region');

const state = {
  session: null,
  products: [],
  productId: null,
  bundle: null,
  sources: [],
  view: 'products',
  selectedOpportunityId: null,
  candidateDrafts: {},
  pollingRunIds: new Set(),
};

const VIEWS = [
  ['products', 'Products'],
  ['profile', 'GTM Profile'],
  ['discussion', 'Discussion'],
  ['experiments', 'Experiments'],
  ['opportunities', 'Opportunities'],
  ['learnings', 'Learnings'],
  ['settings', 'Settings'],
];

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const formatDate = (value) => value ? new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value)) : '—';
const formatMoney = (cents) => new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format((Number(cents) || 0) / 100);
const humanize = (value) => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const safeExternalUrl = (value) => {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
};

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') await boot();
    throw new Error(data.error || 'The request could not be completed.');
  }
  return data;
}

function toast(message, type = 'success') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  toastRegion.append(node);
  setTimeout(() => node.remove(), 3600);
}

function logo() {
  return '<div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>Signalroom</span></div>';
}

async function boot() {
  state.session = await request('/api/session');
  if (!state.session.authenticated) return renderAuth();
  const [products, sources] = await Promise.all([request('/api/products'), request('/api/sources')]);
  state.products = products.products;
  state.sources = sources.sources;
  const remembered = Number(sessionStorage.getItem('gtm_product_id'));
  state.productId = state.products.some((product) => product.id === remembered) ? remembered : state.products[0]?.id || null;
  if (state.productId) await loadProduct(state.productId, false);
  renderShell();
  resumeRunPolling();
}

function renderAuth() {
  const { setupNeeded, setupAllowed, deploymentLocked } = state.session;
  app.innerHTML = `
    <main class="auth-shell">
      <section class="auth-card">
        ${logo()}
        <p class="eyebrow" style="margin-top:40px">Private by default</p>
        <h1>${deploymentLocked ? 'Workspace locked.' : setupNeeded ? 'Make it yours.' : 'Welcome back.'}</h1>
        <p class="lede">${deploymentLocked
          ? 'This copy has no owner account and refuses public access. Complete first-run setup on the machine where it is hosted.'
          : setupNeeded
            ? 'Create the one owner account. Product notes, evidence about people, and outreach drafts stay behind this sign-in.'
            : 'Sign in to continue your evidence-first GTM research.'}</p>
        ${deploymentLocked ? '<p class="danger-note">No stored product content is available from this screen.</p>' : `
          <form id="auth-form" class="stack">
            <div class="field"><label for="email">Owner email</label><input id="email" name="email" type="email" autocomplete="username" required /></div>
            <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${setupNeeded ? 'new-password' : 'current-password'}" minlength="${setupNeeded ? 12 : 1}" required /></div>
            ${setupNeeded ? '<p class="fine-print">Use at least 12 characters. Setup is available only from this machine.</p>' : ''}
            <p class="fine-print">When this workspace is opened from a public address, use HTTPS so the secure owner session can work.</p>
            <button class="button" type="submit">${setupNeeded ? 'Create private workspace' : 'Sign in'}</button>
          </form>`}
      </section>
    </main>`;
  if (!deploymentLocked && (setupAllowed || !setupNeeded)) {
    document.querySelector('#auth-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const button = event.currentTarget.querySelector('button');
      button.disabled = true;
      try {
        await request(setupNeeded ? '/api/setup' : '/api/login', {
          method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
        });
        await boot();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    });
  }
}

async function loadProduct(productId, shouldRender = true) {
  const previousOpportunityId = state.selectedOpportunityId;
  state.productId = Number(productId);
  sessionStorage.setItem('gtm_product_id', String(productId));
  state.bundle = await request(`/api/products/${productId}`);
  state.selectedOpportunityId = state.bundle.opportunities.some((item) => item.id === previousOpportunityId)
    ? previousOpportunityId
    : state.bundle.opportunities[0]?.id || null;
  if (shouldRender) renderShell();
}

function productOptions() {
  if (!state.products.length) return '<option value="">No products yet</option>';
  return state.products.map((product) => `<option value="${product.id}" ${product.id === state.productId ? 'selected' : ''}>${escapeHtml(product.name)}</option>`).join('');
}

function navButtons(mobile = false) {
  return VIEWS.map(([id, label]) => `<button data-view="${id}" class="${state.view === id ? 'active' : ''}">${mobile ? '' : '<span class="nav-dot"></span>'}${label}</button>`).join('');
}

function renderShell() {
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        ${logo()}
        <div class="product-switch"><label for="product-switch">Active product</label><select id="product-switch">${productOptions()}</select></div>
        <nav class="nav" aria-label="Main navigation">${navButtons()}</nav>
        <div class="sidebar-footer"><span>${escapeHtml(state.session.owner.email)}</span><button id="logout" class="text-button">Sign out</button></div>
      </aside>
      <main class="main">
        <div class="mobile-bar">${logo()}<select id="mobile-product-switch" aria-label="Active product">${productOptions()}</select></div>
        <nav class="mobile-nav" aria-label="Mobile navigation">${navButtons(true)}</nav>
        <div id="page-root"></div>
      </main>
    </div>`;
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    state.view = button.dataset.view;
    renderShell();
  }));
  for (const id of ['product-switch', 'mobile-product-switch']) {
    document.querySelector(`#${id}`)?.addEventListener('change', async (event) => {
      if (event.target.value) await loadProduct(event.target.value);
    });
  }
  document.querySelector('#logout')?.addEventListener('click', async () => {
    await request('/api/logout', { method: 'POST' });
    state.bundle = null;
    await boot();
  });
  renderPage();
}

function pageHead(eyebrow, title, description, action = '') {
  return `<header class="page-head"><div><span class="eyebrow">${escapeHtml(eyebrow)}</span><h1>${escapeHtml(title)}</h1></div><div>${description ? `<p>${escapeHtml(description)}</p>` : ''}${action}</div></header>`;
}

function renderPage() {
  const root = document.querySelector('#page-root');
  const renderer = {
    products: renderProducts,
    profile: renderProfile,
    discussion: renderDiscussion,
    experiments: renderExperiments,
    opportunities: renderOpportunities,
    learnings: renderLearnings,
    settings: renderSettings,
  }[state.view];
  root.innerHTML = renderer();
  bindView();
}

function renderProducts() {
  return `<section class="page">
    ${pageHead('Product portfolio', 'Products', 'Each product keeps its own evidence, thesis, experiments, opportunities, and learning history.')}
    <div class="grid two">
      <div class="grid">
        ${state.products.map((product) => `<button class="card product-card" data-open-product="${product.id}">
          <span class="eyebrow">${product.id === state.productId ? 'Active product' : 'Product'}</span>
          <h2>${escapeHtml(product.name)}</h2>
          <p class="muted">${escapeHtml(product.notes || product.website_url || 'No source note added yet.')}</p>
          <span class="arrow">↗</span>
        </button>`).join('') || '<div class="empty"><h2>No products yet</h2><p>Add the first product to begin with evidence, not a questionnaire.</p></div>'}
      </div>
      <form id="product-form" class="card stack">
        <div><span class="eyebrow">New product</span><h2>Start with what exists</h2><p class="muted">A website and README are useful, but only the name is required. You can add approved material later.</p></div>
        <div class="form-grid">
          <div class="field full"><label for="product-name">Product name *</label><input id="product-name" name="name" required /></div>
          <div class="field"><label for="website-url">Website URL</label><input id="website-url" name="websiteUrl" type="url" placeholder="https://…" /></div>
          <div class="field"><label for="repo-url">Public repository URL</label><input id="repo-url" name="repositoryUrl" type="url" placeholder="Read only" /></div>
          <div class="field full"><label for="readme">README or product document</label><textarea id="readme" name="readme" placeholder="Paste approved product material…"></textarea></div>
          <div class="field full"><label for="notes">Your notes</label><textarea id="notes" name="notes" placeholder="What is true today? What have you observed?"></textarea></div>
        </div>
        <button class="button" type="submit">Add product</button>
      </form>
    </div>
  </section>`;
}

function requireProduct(content) {
  return state.bundle ? content : `<section class="page">${pageHead('Workspace', 'Choose a product', 'Add or select a product before using this view.')}<div class="empty"><h2>No active product</h2><button class="button" data-view="products">Go to products</button></div></section>`;
}

function groupedStatements() {
  return (state.bundle?.profile?.statements || []).reduce((groups, item) => {
    (groups[item.section] ||= []).push(item);
    return groups;
  }, {});
}

function claimEvidence(claim) {
  const link = safeExternalUrl(claim.evidence_url);
  if (!claim.evidence_excerpt && !link) return '<span class="fine-print">No evidence attached — treat this state with care.</span>';
  return `<div class="evidence-actions">
    ${link ? `<a class="evidence-link" href="${escapeHtml(link)}" target="_blank" rel="noreferrer">Open source ↗</a>` : ''}
    ${claim.evidence_excerpt ? `<details class="stored-evidence"><summary>${escapeHtml(claim.evidence_title || 'View stored evidence')}</summary><blockquote class="evidence-quote">“${escapeHtml(claim.evidence_excerpt)}”</blockquote></details>` : ''}
  </div>`;
}

function renderProfile() {
  if (!state.bundle) return requireProduct('');
  const profile = state.bundle.profile;
  const groups = groupedStatements();
  return `<section class="page">
    ${pageHead('Living understanding', `${state.bundle.product.name} GTM Profile`, 'Facts, hypotheses, and open tests stay visibly separate. Earlier versions remain restorable.', `<div class="button-row" style="margin-top:16px"><button id="refresh-profile" class="button secondary small">New version from material</button><select id="profile-history" class="history-select"><option value="">Version ${profile?.version || 0}</option></select></div>`)}
    <div class="split">
      <article class="card">
        ${Object.entries(groups).map(([section, claims]) => `<section class="profile-section"><h3>${escapeHtml(section)}</h3><div>${claims.map((claim) => `<div class="claim"><span class="badge ${claim.knowledge_state}">${humanize(claim.knowledge_state)}</span><p>${escapeHtml(claim.statement)}</p>${claimEvidence(claim)}</div>`).join('')}</div></section>`).join('') || '<div class="empty"><h2>No profile yet</h2></div>'}
      </article>
      <aside class="stack">
        <form id="profile-statement-form" class="card stack">
          <div><span class="eyebrow">Versioned edit</span><h2>Add a profile statement</h2><p class="muted">The current profile is copied first, so earlier reasoning stays available.</p></div>
          <div class="field"><label>Section</label><select name="section">${['Product','Problem','Product maturity','ICP hypotheses','Jobs to be done','Strong intent signals','Weak signals','Disqualifiers','Alternatives / competitors','Acquisition channels','Activation event','Geography','Pricing / business model','Existing traction','Experiments attempted','Learnings','Open questions'].map((section) => `<option>${section}</option>`).join('')}</select></div>
          <div class="field"><label>Knowledge state</label><select name="knowledgeState"><option value="known">Known</option><option value="hypothesis">Hypothesis</option><option value="needs_testing">Needs testing</option></select></div>
          <div class="field"><label>Statement *</label><textarea name="statement" required></textarea></div>
          <div class="field"><label>Evidence excerpt</label><textarea name="evidenceExcerpt" placeholder="Required for a known statement"></textarea></div>
          <div class="field"><label>Evidence URL</label><input name="evidenceUrl" type="url" /></div>
          <button class="button" type="submit">Add as a new version</button>
        </form>
        <form id="material-form" class="card stack">
          <div><span class="eyebrow">Approved inputs</span><h2>Add source material</h2></div>
          <div class="field"><label>Type</label><select name="kind"><option value="readme">README / docs</option><option value="website">Website excerpt</option><option value="feedback">User feedback</option><option value="screenshot_note">Screenshot note</option><option value="owner_notes">Owner note</option></select></div>
          <div class="field"><label>Label *</label><input name="label" required placeholder="What is this?" /></div>
          <div class="field"><label>Source URL</label><input name="sourceUrl" type="url" placeholder="Optional public link" /></div>
          <div class="field"><label>Content or observation</label><textarea name="content" placeholder="Paste only what is needed…"></textarea></div>
          <button class="button" type="submit">Add material</button>
        </form>
        <div class="card subtle"><span class="eyebrow">Material library</span><div class="stack compact" style="margin-top:16px">${state.bundle.materials.map((item) => `<div><strong>${escapeHtml(item.label)}</strong><br><span class="fine-print">${humanize(item.kind)} · ${formatDate(item.created_at)}</span></div>`).join('') || '<span class="muted">No material added.</span>'}</div></div>
      </aside>
    </div>
  </section>`;
}

function renderDiscussion() {
  if (!state.bundle) return requireProduct('');
  return `<section class="page">
    ${pageHead('Research before questions', 'GTM Discussion', 'Challenge the thesis, correct an assumption, or add context. Corrections become a new profile version without erasing prior reasoning.')}
    <div class="split">
      <div class="timeline">${state.bundle.discussions.map((message) => `<article class="message ${message.role}"><div class="message-meta">${message.role === 'agent' ? 'GTM agent' : 'You'} · ${formatDate(message.created_at)}</div>${escapeHtml(message.body)}</article>`).join('') || '<div class="empty"><h2>No thesis yet</h2></div>'}</div>
      <form id="discussion-form" class="card stack detail-panel">
        <div><span class="eyebrow">Your evidence</span><h2>Correct the thesis</h2><p class="muted">Share something that could change the audience, signal, offer, channel, or activation event.</p></div>
        <div class="field"><label for="discussion-message">Context or correction</label><textarea id="discussion-message" name="message" required placeholder="For example: the strongest users are not founders; they are…"></textarea></div>
        <button class="button" type="submit">Add to the discussion</button>
        <p class="fine-print">This local V1 records and incorporates your correction. External model synthesis remains disabled until an approved provider is connected.</p>
      </form>
    </div>
  </section>`;
}

function sourceChooser() {
  return state.sources.map((source) => {
    const available = source.enabled && source.implementation_status === 'available';
    const status = source.source_kind === 'live' ? 'Live internet · deferred' : source.source_kind === 'simulation' ? 'Simulation' : 'Owner input';
    return `<label class="source-policy ${available ? '' : 'disabled'}">
    <input type="checkbox" name="allowedSourceIds" value="${source.id}" ${source.id === 'simulated_public' && available ? 'checked' : ''} ${available ? '' : 'disabled'} />
    <span><span class="badge ${source.source_kind === 'simulation' ? 'hypothesis' : ''}">${status}</span><br><strong>${escapeHtml(source.name)}</strong><br><small>${escapeHtml(source.description)} ${available ? '' : '— unavailable for new runs'}</small>
      <span class="policy-capabilities">Discover ${source.discover_allowed ? 'allowed' : 'denied'} · Read ${source.read_allowed ? 'allowed' : 'denied'} · Store ${source.store_allowed ? 'allowed' : 'denied'} · Contact ${source.contact_allowed ? 'allowed' : 'denied'} · Automate ${source.automate_allowed ? 'allowed' : 'denied'}</span>
      <small>${escapeHtml(source.policy_note)}</small>
    </span>
  </label>`;
  }).join('');
}

function renderExperiments() {
  if (!state.bundle) return requireProduct('');
  return `<section class="page">
    ${pageHead('One hypothesis at a time', 'Experiments', 'Define a narrow audience, a current observable problem, and what would make the test worth continuing.')}
    <div class="split">
      <div class="stack">
        ${state.bundle.experiments.map((experiment) => renderExperiment(experiment)).join('') || '<div class="empty"><h2>No experiment yet</h2><p>Create one focused test. Quality of evidence matters more than lead volume.</p></div>'}
      </div>
      <form id="experiment-form" class="card stack detail-panel">
        <div><span class="eyebrow">New experiment</span><h2>Choose the signal</h2></div>
        <div class="field"><label>Name *</label><input name="name" required placeholder="Prototype-to-production pain" /></div>
        <div class="field"><label>Hypothesis *</label><textarea name="hypothesis" required placeholder="We believe…"></textarea></div>
        <div class="field"><label>Narrow audience *</label><input name="audience" required placeholder="Who has this problem?" /></div>
        <div class="field"><label>Observable intent signal *</label><textarea name="signal" required placeholder="What did they do or say that shows need now?"></textarea></div>
        <div class="field"><label>Success criteria *</label><input name="successCriteria" required value="At least 3 of 10 are genuinely worth contacting" /></div>
        <div class="field"><label>Permitted sources</label><div class="stack compact">${sourceChooser()}</div></div>
        <button class="button" type="submit">Save experiment</button>
      </form>
    </div>
  </section>`;
}

function renderExperiment(experiment) {
  const candidates = state.candidateDrafts[experiment.id] || [];
  const hasSimulation = experiment.allowedSourceIds.some((id) => id.startsWith('simulated_'));
  const acceptsOwnerEvidence = experiment.allowedSourceIds.includes('manual_public');
  return `<article class="card experiment">
    <div class="experiment-top"><div><span class="eyebrow">${escapeHtml(experiment.status)} · ${experiment.run_count} run${experiment.run_count === 1 ? '' : 's'}</span><h2>${escapeHtml(experiment.name)}</h2></div><span class="badge">${experiment.opportunity_count} opportunities</span></div>
    <dl class="definition-list"><dt>Hypothesis</dt><dd>${escapeHtml(experiment.hypothesis)}</dd><dt>Audience</dt><dd>${escapeHtml(experiment.audience)}</dd><dt>Signal</dt><dd>${escapeHtml(experiment.signal)}</dd><dt>Success</dt><dd>${escapeHtml(experiment.success_criteria)}</dd><dt>Sources</dt><dd>${experiment.allowedSourceIds.map(humanize).join(', ')}</dd></dl>
    ${experiment.opportunity_count ? `<div class="experiment-results"><span><strong>${experiment.great_lead_count}</strong> great leads</span><span><strong>${experiment.replied_count}</strong> replied</span><span><strong>${experiment.signed_up_count}</strong> signed up</span><span><strong>${experiment.activated_count}</strong> activated</span></div>` : ''}
    ${hasSimulation ? `<div class="research-launch"><div><strong>Automatic simulated discovery</strong><p class="fine-print">Discovers and qualifies fictional public-style evidence. No internet or paid service is contacted.</p></div><button class="button small" data-run-experiment="${experiment.id}" type="button">Run research</button></div>` : ''}
    ${experiment.runs?.length ? `<details class="signal-builder" ${['queued','starting','running'].includes(experiment.runs[0].status) ? 'open' : ''}><summary><strong>Run history</strong> <span class="muted">(${experiment.runs.length})</span></summary><div class="stack compact run-history">${experiment.runs.map((run) => renderResearchRun(run)).join('')}</div></details>` : ''}
    ${acceptsOwnerEvidence ? `<details class="signal-builder" ${candidates.length ? 'open' : ''}>
      <summary><strong>Add an owner-supplied real excerpt</strong> <span class="muted">(${candidates.length} queued)</span></summary>
      <div class="candidate-list">${candidates.map((item, index) => `<div class="candidate-chip"><span>${escapeHtml(item.personName || item.companyName)} — ${escapeHtml(item.signal)}</span><button data-remove-candidate="${index}" data-experiment="${experiment.id}" aria-label="Remove candidate">×</button></div>`).join('')}</div>
      <form class="candidate-form stack" data-experiment="${experiment.id}">
        <div class="form-grid">
          <div class="field"><label>Person</label><input name="personName" placeholder="Publicly visible name" /></div>
          <div class="field"><label>Company</label><input name="companyName" placeholder="If relevant" /></div>
          <div class="field full"><label>Public source URL *</label><input name="sourceUrl" type="url" required placeholder="https://…" /></div>
          <div class="field full"><label>Exact evidence excerpt *</label><textarea name="evidenceExcerpt" required placeholder="The smallest relevant public excerpt…"></textarea></div>
          <div class="field full"><label>Observed signal *</label><input name="signal" required placeholder="What current problem is visible?" /></div>
          <div class="field full"><label>Why this signal matters</label><input name="whySignalMatters" placeholder="How does it indicate current need?" /></div>
          <div class="field full"><label>Product fit reasoning</label><input name="productFit" placeholder="Why could this product help?" /></div>
          <div class="field full"><label>Legitimate personalization context</label><textarea name="personalizationContext" placeholder="Only context relevant to the problem and visible in the approved source"></textarea></div>
          <div class="field full"><label>Concerns / disqualifiers</label><input name="disqualifiers" placeholder="Optional" /></div>
        </div>
        <div class="button-row"><button class="button secondary small" type="submit">Queue this excerpt</button><button class="button small" data-run-experiment="${experiment.id}" data-owner-evidence="true" type="button" ${candidates.length ? '' : 'disabled'}>Qualify ${candidates.length || ''} excerpt${candidates.length === 1 ? '' : 's'}</button></div>
        <p class="fine-print">Qualification is derived from the evidence and experiment context. This adapter does not scrape the page, ask you for scores, or contact anyone.</p>
      </form>
    </details>` : ''}
  </article>`;
}

function renderResearchRun(run) {
  const active = ['queued', 'starting', 'running'].includes(run.status);
  const percent = run.input_count ? Math.min(100, Math.round((run.processed_count / run.input_count) * 100)) : active ? 8 : 100;
  const sourceRows = (run.sources || []).map((source) => `<li><strong>${escapeHtml(source.source_name)}</strong> · ${humanize(source.status)} · ${source.processed_count}/${source.discovered_count || '?'} checked · ${source.accepted_count} saved${source.cost_cents ? ` · ${formatMoney(source.cost_cents)} simulated usage` : ''}${source.error_note ? `<br><span class="danger-note">${escapeHtml(source.error_note)}</span>` : ''}</li>`).join('');
  return `<div class="run-card ${active ? 'active-run' : ''}">
    <div class="run-status"><span class="badge ${run.status === 'failed' || run.status === 'completed_with_issues' ? 'wrong_signal' : active ? 'hypothesis' : 'known'}">${humanize(run.status)}</span><span class="fine-print">Stage: ${humanize(run.current_stage)}</span></div>
    <strong>${escapeHtml(run.progress_note)}</strong>
    <div class="progress-track" aria-label="Research progress"><span style="width:${percent}%"></span></div>
    <small>${formatDate(run.started_at)} · ${run.processed_count}/${run.input_count || '?'} evaluated · ${run.accepted_count} saved · ${run.rejected_count} rejected</small>
    ${sourceRows ? `<ul class="fine-print run-sources">${sourceRows}</ul>` : ''}
    ${run.error_note ? `<p class="danger-note fine-print">${escapeHtml(run.error_note)}</p>` : ''}
    ${run.events?.length ? `<details><summary class="fine-print">Completed work and activity</summary><ol class="fine-print run-events">${run.events.map((event) => `<li>${escapeHtml(event.message)}</li>`).join('')}</ol></details>` : ''}
    ${run.rejections?.length ? `<details><summary class="fine-print">Review rejection reasons</summary><ul class="fine-print">${run.rejections.map((item) => `<li>${escapeHtml(item.identity_label)} — ${escapeHtml(item.reason)}</li>`).join('')}</ul></details>` : ''}
  </div>`;
}

function opportunityIdentity(opportunity) {
  return opportunity.person_name || opportunity.company_name || 'Unidentified opportunity';
}

function renderOpportunities() {
  if (!state.bundle) return requireProduct('');
  const opportunities = state.bundle.opportunities;
  const selected = opportunities.find((item) => item.id === state.selectedOpportunityId) || opportunities[0];
  return `<section class="page">
    ${pageHead('Evidence, not a contact list', 'Opportunities', 'Ranked by current intent, fit, evidence quality, recency, source reliability, and disqualifiers.')}
    ${opportunities.length ? `<div class="split"><div class="opportunity-list">${opportunities.map((item) => `<button class="opportunity-row ${selected?.id === item.id ? 'active' : ''}" data-opportunity="${item.id}"><span class="rank-number">${item.rank}</span><span><h3>${escapeHtml(opportunityIdentity(item))}</h3><p>${escapeHtml(item.signal)}</p></span><span class="badge ${item.intent_strength}">${item.intent_strength} intent</span></button>`).join('')}</div>${renderOpportunityDetail(selected)}</div>` : '<div class="empty"><h2>No ranked opportunities yet</h2><p>Run a bounded experiment with specific public evidence. Demographic-only matches will be rejected.</p><button class="button" data-view="experiments">Open experiments</button></div>'}
  </section>`;
}

function renderOpportunityDetail(item) {
  const simulated = String(item.evidence_source_type || '').startsWith('simulated_');
  const evidenceUrl = simulated ? '' : safeExternalUrl(item.evidence_url);
  return `<aside class="card detail-panel">
    <div class="button-row"><span class="badge rank">Rank ${item.rank}</span><span class="badge ${item.intent_strength}">${item.intent_strength} intent</span><span class="badge">${item.confidence}% confidence</span>${simulated ? '<span class="badge hypothesis">Fictional simulation</span>' : ''}</div>
    <h2 style="margin-top:18px">${escapeHtml(opportunityIdentity(item))}</h2>
    <section class="detail-section"><h3>Observed signal</h3><p>${escapeHtml(item.signal)}</p><blockquote class="evidence-quote">“${escapeHtml(item.evidence_excerpt)}”</blockquote>${evidenceUrl ? `<a href="${escapeHtml(evidenceUrl)}" target="_blank" rel="noreferrer">Open source evidence ↗</a>` : simulated ? `<span class="fine-print">Fictional source reference: ${escapeHtml(item.evidence_url)}</span>` : '<span class="fine-print">No safe public source link is stored.</span>'}</section>
    <section class="detail-section"><h3>Why it matters</h3><p>${escapeHtml(item.why_signal_matters)}</p><h3>Product fit</h3><p>${escapeHtml(item.product_fit)}</p><h3>Intent reasoning</h3><p>${escapeHtml(item.intent_reason)}</p></section>
    <section class="detail-section"><h3>Concerns</h3><p>${escapeHtml(item.disqualifiers || 'No explicit disqualifier recorded.')}</p><h3>Recommendation</h3><p><strong>${humanize(item.recommended_action)}</strong> — ${escapeHtml(item.action_reason)}</p></section>
    <section class="detail-section"><h3>Personalization context</h3><p>${escapeHtml(item.personalization_context || 'No additional context stored.')}</p></section>
    <section class="detail-section"><h3>Ranking reasons</h3><p class="fine-print">${escapeHtml(item.original_reasoning)}</p></section>
    <section class="detail-section"><h3>Contextual draft</h3>${item.draft_body ? `<span class="badge awaiting_approval">Awaiting approval</span><div class="draft-box">${escapeHtml(item.draft_body)}</div><p class="fine-print">This draft cannot send a message.</p>` : ['public_reply','dm','email'].includes(item.recommended_action) ? `<button class="button small" data-create-draft="${item.id}" data-channel="${item.recommended_action}">Draft ${humanize(item.recommended_action)}</button>` : '<p class="muted">No outreach draft is appropriate for this recommendation.</p>'}</section>
    <section class="detail-section"><h3>Your feedback</h3><div class="button-row">${['great_lead','weak_lead','wrong_icp','wrong_signal'].map((rating) => `<button class="button secondary small" data-feedback="${rating}" data-id="${item.id}">${humanize(rating)}</button>`).join('')}</div>${item.feedback_rating ? `<p><span class="badge ${item.feedback_rating}">Latest: ${humanize(item.feedback_rating)}</span></p>` : ''}</section>
    <section class="detail-section"><h3>Outcome</h3><select data-outcome-id="${item.id}"><option value="">Record an outcome…</option>${['contacted','replied','signed_up','activated','not_interested'].map((outcome) => `<option value="${outcome}" ${item.latest_outcome === outcome ? 'selected' : ''}>${humanize(outcome)}</option>`).join('')}</select></section>
  </aside>`;
}

function renderLearnings() {
  if (!state.bundle) return requireProduct('');
  const opportunities = state.bundle.opportunities;
  const great = opportunities.filter((item) => item.feedback_rating === 'great_lead').length;
  const activated = opportunities.filter((item) => item.latest_outcome === 'activated').length;
  return `<section class="page">
    ${pageHead('Market memory', 'Learnings', 'Feedback and outcomes accumulate without rewriting what the agent originally recommended or why.')}
    <div class="metric-strip"><div class="metric"><strong>${opportunities.length}</strong><span>evidenced opportunities</span></div><div class="metric"><strong>${great}</strong><span>owner-rated great leads</span></div><div class="metric"><strong>${activated}</strong><span>activation outcomes</span></div></div>
    <div class="grid two" style="margin-top:22px">
      ${state.bundle.learnings.map((learning) => `<article class="card"><span class="eyebrow">${formatDate(learning.created_at)}</span><h2>${escapeHtml(learning.statement)}</h2><p class="fine-print">Basis: ${escapeHtml(learning.basis)}</p></article>`).join('') || '<div class="empty"><h2>No outcome evidence yet</h2><p>Rate opportunities and record outcomes. Learnings will build from those observations.</p></div>'}
      <aside class="card accent"><span class="eyebrow">How this learns</span><h2>Structured history, not a black box.</h2><p class="muted">This first version keeps the hypothesis, original ranking reason, your judgement, and the outcome together. It does not train a model or silently rewrite history.</p></aside>
    </div>
  </section>`;
}

function renderSettings() {
  const simulations = state.sources.filter((source) => source.source_kind === 'simulation');
  const live = state.sources.filter((source) => source.source_kind === 'live');
  return `<section class="page">
    ${pageHead('Explicit autonomy envelope', 'Research settings', 'Choose which fictional sources may run and test spending stops. Live internet sources stay unavailable in this build.')}
    <div class="split">
      <div class="stack">
        ${simulations.map((source) => `<form class="card source-setting-form" data-source-setting="${source.id}">
          <div class="setting-head"><div><span class="badge hypothesis">Simulation</span><h2>${escapeHtml(source.name)}</h2></div><label class="switch"><input name="enabled" type="checkbox" ${source.enabled ? 'checked' : ''} /><span>${source.enabled ? 'Enabled' : 'Disabled'}</span></label></div>
          <p class="muted">${escapeHtml(source.description)}</p>
          <p class="fine-print">${escapeHtml(source.policy_note)}</p>
          ${source.paid ? `<div class="budget-panel"><label class="approval-check"><input name="approved" type="checkbox" ${source.budget_enabled ? 'checked' : ''} /> I approve this fictional provider for testing</label><div class="field"><label>Simulated monthly limit</label><div class="money-field"><span>$</span><input name="monthlyLimit" type="number" min="0.01" step="0.01" value="${source.approved_monthly_cents ? (source.approved_monthly_cents / 100).toFixed(2) : ''}" placeholder="5.00" /></div></div><p class="fine-print">Used ${formatMoney(source.spent_monthly_cents)} of ${source.approved_monthly_cents ? formatMoney(source.approved_monthly_cents) : 'no approved limit'} · ${formatMoney(source.unit_cost_cents)} per fictional evaluation</p></div>` : ''}
          <button class="button secondary small" type="submit">Save source setting</button>
        </form>`).join('')}
      </div>
      <aside class="stack">
        <div class="card accent"><span class="eyebrow">Current boundary</span><h2>No live discovery.</h2><p class="muted">These controls only exercise the product loop with fictional evidence. They cannot turn on the internet, scrape a platform, spend real money, or send outreach.</p></div>
        ${live.map((source) => `<article class="card deferred-source"><span class="badge needs_testing">Deferred</span><h2>${escapeHtml(source.name)}</h2><p class="muted">${escapeHtml(source.description)}</p><p class="fine-print">${escapeHtml(source.policy_note)}</p><button class="button secondary small" disabled>Unavailable in this build</button></article>`).join('')}
      </aside>
    </div>
  </section>`;
}

function resumeRunPolling() {
  for (const experiment of state.bundle?.experiments || []) {
    for (const run of experiment.runs || []) {
      if (['queued', 'starting', 'running'].includes(run.status)) pollResearchRun(run.id);
    }
  }
}

async function pollResearchRun(runId) {
  if (state.pollingRunIds.has(runId)) return;
  state.pollingRunIds.add(runId);
  try {
    let active = true;
    while (active) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 180));
      const { run } = await request(`/api/runs/${runId}`);
      await loadProduct(state.productId, false);
      if (['experiments', 'opportunities'].includes(state.view)) renderPage();
      active = ['queued', 'starting', 'running'].includes(run.status);
    }
    state.sources = (await request('/api/sources')).sources;
    toast('Research run finished. Saved opportunities and source notes are ready to review.');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.pollingRunIds.delete(runId);
  }
}

function bindView() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.view; renderShell(); }));
  document.querySelectorAll('[data-open-product]').forEach((button) => button.addEventListener('click', async () => { await loadProduct(button.dataset.openProduct, false); state.view = 'profile'; renderShell(); }));

  document.querySelector('#product-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const bundle = await request('/api/products', { method: 'POST', body: JSON.stringify(form) });
      state.bundle = bundle;
      state.productId = bundle.product.id;
      sessionStorage.setItem('gtm_product_id', String(state.productId));
      state.products = (await request('/api/products')).products;
      state.view = 'profile';
      renderShell();
      toast('Product added with an evidence-labelled profile scaffold.');
    } catch (error) { toast(error.message, 'error'); }
  });

  document.querySelector('#material-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await request(`/api/products/${state.productId}/materials`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      await loadProduct(state.productId);
      toast('Source material added.');
    } catch (error) { toast(error.message, 'error'); }
  });

  document.querySelector('#profile-statement-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await request(`/api/products/${state.productId}/profile/statements`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      await loadProduct(state.productId);
      toast('Profile statement added in a new version.');
    } catch (error) { toast(error.message, 'error'); }
  });

  document.querySelector('#refresh-profile')?.addEventListener('click', async () => {
    try {
      await request(`/api/products/${state.productId}/profile`, { method: 'POST' });
      await loadProduct(state.productId);
      toast('A new profile version was created.');
    } catch (error) { toast(error.message, 'error'); }
  });

  const history = document.querySelector('#profile-history');
  if (history) {
    request(`/api/profile-versions?productId=${state.productId}`).then(({ versions }) => {
      history.innerHTML = versions.map((version) => `<option value="${version.id}">Version ${version.version} · ${escapeHtml(version.reason)}</option>`).join('');
      history.addEventListener('change', async () => {
        if (!history.value || Number(history.value) === state.bundle.profile.id) return;
        try {
          await request(`/api/products/${state.productId}/profile/restore/${history.value}`, { method: 'POST' });
          await loadProduct(state.productId);
          toast('Earlier profile content restored as a new version.');
        } catch (error) { toast(error.message, 'error'); }
      });
    });
  }

  document.querySelector('#discussion-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await request(`/api/products/${state.productId}/discussion`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      await loadProduct(state.productId);
      toast('Correction recorded and profile versioned.');
    } catch (error) { toast(error.message, 'error'); }
  });

  document.querySelector('#experiment-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    data.allowedSourceIds = new FormData(event.currentTarget).getAll('allowedSourceIds');
    try {
      await request(`/api/products/${state.productId}/experiments`, { method: 'POST', body: JSON.stringify(data) });
      await loadProduct(state.productId);
      toast('Experiment saved.');
    } catch (error) { toast(error.message, 'error'); }
  });

  document.querySelectorAll('.candidate-form').forEach((form) => form.addEventListener('submit', (event) => {
    event.preventDefault();
    const experimentId = Number(form.dataset.experiment);
    const data = Object.fromEntries(new FormData(form));
    (state.candidateDrafts[experimentId] ||= []).push(data);
    renderPage();
    toast('Evidence excerpt queued for automatic qualification.');
  }));

  document.querySelectorAll('[data-remove-candidate]').forEach((button) => button.addEventListener('click', () => {
    state.candidateDrafts[Number(button.dataset.experiment)].splice(Number(button.dataset.removeCandidate), 1);
    renderPage();
  }));

  document.querySelectorAll('[data-run-experiment]').forEach((button) => button.addEventListener('click', async () => {
    const experimentId = Number(button.dataset.runExperiment);
    button.disabled = true;
    try {
      const ownerEvidence = button.dataset.ownerEvidence === 'true';
      const result = await request(`/api/experiments/${experimentId}/runs`, { method: 'POST', body: JSON.stringify({ candidates: ownerEvidence ? state.candidateDrafts[experimentId] || [] : [] }) });
      if (ownerEvidence) state.candidateDrafts[experimentId] = [];
      await loadProduct(state.productId, false);
      if (result.asynchronous) {
        renderPage();
        pollResearchRun(result.runId);
        toast(result.status === 'queued' ? 'Research is queued behind two active runs.' : 'Automatic research started. Progress will update here.');
      } else {
        state.view = 'opportunities';
        renderShell();
        toast(`Qualification complete: ${result.accepted} ranked, ${result.rejected} rejected with reasons.`);
      }
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  }));

  document.querySelectorAll('[data-opportunity]').forEach((button) => button.addEventListener('click', () => {
    state.selectedOpportunityId = Number(button.dataset.opportunity);
    renderPage();
  }));

  document.querySelector('[data-create-draft]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    try {
      await request(`/api/opportunities/${button.dataset.createDraft}/drafts`, { method: 'POST', body: JSON.stringify({ channel: button.dataset.channel }) });
      await loadProduct(state.productId);
      toast('Contextual draft created. It remains unsent and awaits approval.');
    } catch (error) { toast(error.message, 'error'); }
  });

  document.querySelectorAll('[data-feedback]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await request(`/api/opportunities/${button.dataset.id}/feedback`, { method: 'POST', body: JSON.stringify({ rating: button.dataset.feedback }) });
      await loadProduct(state.productId);
      toast('Feedback recorded and added to learnings.');
    } catch (error) { toast(error.message, 'error'); }
  }));

  document.querySelector('[data-outcome-id]')?.addEventListener('change', async (event) => {
    if (!event.target.value) return;
    try {
      await request(`/api/opportunities/${event.target.dataset.outcomeId}/outcomes`, { method: 'POST', body: JSON.stringify({ outcome: event.target.value }) });
      await loadProduct(state.productId);
      toast('Outcome recorded and learning updated.');
    } catch (error) { toast(error.message, 'error'); }
  });

  document.querySelectorAll('[data-source-setting]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const monthlyLimit = Number(data.get('monthlyLimit'));
    try {
      const result = await request(`/api/sources/${form.dataset.sourceSetting}`, {
        method: 'PATCH',
        body: JSON.stringify({
          enabled: data.get('enabled') === 'on',
          approved: data.get('approved') === 'on',
          approvedMonthlyCents: Number.isFinite(monthlyLimit) ? Math.round(monthlyLimit * 100) : null,
        }),
      });
      state.sources = result.sources;
      renderPage();
      toast('Research source setting saved. Earlier results remain readable.');
    } catch (error) { toast(error.message, 'error'); }
  }));
}

boot().catch((error) => {
  app.innerHTML = `<main class="auth-shell"><section class="auth-card">${logo()}<h1>Couldn’t open the workspace.</h1><p class="lede">${escapeHtml(error.message)}</p></section></main>`;
});
