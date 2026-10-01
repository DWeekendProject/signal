import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('owner login protects records and product workspaces remain separate', { timeout: 30_000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'signalroom-test-'));
  const databasePath = join(directory, 'test.sqlite');
  const host = process.env.BUILDROOM_TEST_HOST;
  const port = Number(process.env.BUILDROOM_TEST_PORT);
  assert.ok(host, 'BUILDROOM_TEST_HOST is required for the local integration server.');
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535, 'BUILDROOM_TEST_PORT must be a valid port.');
  const urlHost = host.includes(':') ? `[${host}]` : host;
  const baseUrl = `http://${urlHost}:${port}`;

  const previousDatabasePath = process.env.GTM_DATABASE_PATH;
  process.env.GTM_DATABASE_PATH = databasePath;
  const [{ db }, { hashPassword }, { server, startServer }] = await Promise.all([
    import('../src/db.js'),
    import('../src/auth.js'),
    import('../src/server.js'),
  ]);
  db.prepare('INSERT INTO owners (email, password_hash, created_at) VALUES (?, ?, ?)')
    .run('owner@example.com', hashPassword('a-long-test-password'), new Date().toISOString());
  await startServer({ host, port });
  context.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    db.close();
    if (previousDatabasePath === undefined) delete process.env.GTM_DATABASE_PATH;
    else process.env.GTM_DATABASE_PATH = previousDatabasePath;
  });

  const unsigned = await fetch(`${baseUrl}/api/products`);
  assert.equal(unsigned.status, 401);

  const loginResponse = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', password: 'a-long-test-password' }),
  });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];

  async function ownerRequest(path, options = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(options.headers || {}) },
    });
  }

  async function createProduct(name, notes) {
    const response = await ownerRequest('/api/products', {
      method: 'POST',
      body: JSON.stringify({ name, notes }),
    });
    assert.equal(response.status, 201);
    return response.json();
  }

  async function createSimulatedExperiment(productId, name, sourceId) {
    const response = await ownerRequest(`/api/products/${productId}/experiments`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        hypothesis: 'People describing a current workflow failure are worth reviewing.',
        audience: 'Builders trying to move a working prototype into real use',
        signal: 'A current public statement that production workflow failures are blocking progress',
        successCriteria: 'At least 3 of 10 are genuinely worth contacting',
        allowedSourceIds: [sourceId],
      }),
    });
    assert.equal(response.status, 201);
    const bundle = await response.json();
    return bundle.experiments.find((item) => item.name === name);
  }

  async function setSimulatedSource(sourceId, settings) {
    return ownerRequest(`/api/sources/${sourceId}`, {
      method: 'PATCH',
      body: JSON.stringify(settings),
    });
  }

  async function startAutomatedRun(experimentId) {
    const response = await ownerRequest(`/api/experiments/${experimentId}/runs`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 202);
    const result = await response.json();
    assert.equal(result.asynchronous, true);
    return result.runId;
  }

  async function waitForAutomatedRun(runId) {
    const snapshots = [];
    let detail;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const response = await ownerRequest(`/api/runs/${runId}`);
      assert.equal(response.status, 200);
      detail = await response.json();
      snapshots.push(detail.run);
      if (!['queued', 'starting', 'running'].includes(detail.run.status)) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    assert.ok(detail, 'Expected the research run to be readable.');
    assert.ok(!['queued', 'starting', 'running'].includes(detail.run.status), 'Research run did not reach a final status.');
    return { detail, snapshots };
  }

  const first = await createProduct('Product One', 'Only first-product evidence.');
  const second = await createProduct('Product Two', 'Only second-product evidence.');
  const firstResponse = await ownerRequest(`/api/products/${first.product.id}`);
  const firstAgain = await firstResponse.json();

  assert.equal(firstAgain.product.name, 'Product One');
  assert.match(JSON.stringify(firstAgain), /Only first-product evidence/);
  assert.doesNotMatch(JSON.stringify(firstAgain), /Only second-product evidence/);
  assert.notEqual(first.product.id, second.product.id);

  const invalidUrl = await ownerRequest('/api/products', {
    method: 'POST',
    body: JSON.stringify({ name: 'Unsafe link', websiteUrl: 'javascript:alert(1)' }),
  });
  assert.equal(invalidUrl.status, 400);

  const materialResponse = await ownerRequest(`/api/products/${first.product.id}/materials`, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'feedback',
      label: 'Owner interview note',
      sourceUrl: 'https://example.com/interview',
      content: 'A user can complete the first useful workflow today and recognizes the resulting saved evidence as the activation moment.',
    }),
  });
  assert.equal(materialResponse.status, 201);
  const refreshedProfile = await ownerRequest(`/api/products/${first.product.id}/profile`, { method: 'POST' });
  assert.equal(refreshedProfile.status, 201);
  const refreshedBundle = await refreshedProfile.json();
  const supportedClaim = refreshedBundle.profile.statements.find((item) => item.statement.includes('activation moment'));
  assert.equal(supportedClaim.knowledge_state, 'known');
  assert.match(supportedClaim.evidence_url, /^https:\/\//);

  const experimentResponse = await ownerRequest(`/api/products/${first.product.id}/experiments`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Specific current pain',
      hypothesis: 'People describing a current workflow failure are worth reviewing.',
      audience: 'People currently blocked by the workflow',
      signal: 'A recent public description of the exact workflow failure',
      successCriteria: 'At least one result is genuinely worth contacting',
      allowedSourceIds: ['manual_public'],
    }),
  });
  assert.equal(experimentResponse.status, 201);
  const experimentBundle = await experimentResponse.json();
  const experimentId = experimentBundle.experiments[0].id;
  const candidate = {
    personName: 'Evidence Author',
    sourceUrl: 'https://example.com/public-problem',
    sourceTitle: 'Public problem discussion',
    evidenceExcerpt: 'I am blocked right now because the workflow keeps losing the evidence I need to make the next decision.',
    signal: 'The person is currently blocked and trying to preserve decision evidence.',
    signalSpecificity: 5,
    recency: 3,
    productFitScore: 5,
    evidenceQuality: 4,
    sourceReliability: 3,
    recommendedAction: 'public_reply',
  };
  const runResponse = await ownerRequest(`/api/experiments/${experimentId}/runs`, {
    method: 'POST',
    body: JSON.stringify({ candidates: [candidate] }),
  });
  assert.equal(runResponse.status, 201);
  assert.equal((await runResponse.json()).accepted, 1);

  let researchedBundle = await (await ownerRequest(`/api/products/${first.product.id}`)).json();
  const opportunity = researchedBundle.opportunities[0];
  assert.equal(opportunity.person_name, 'Evidence Author');
  assert.equal(opportunity.intent_strength, 'high');

  const duplicateRun = await ownerRequest(`/api/experiments/${experimentId}/runs`, {
    method: 'POST',
    body: JSON.stringify({ candidates: [candidate] }),
  });
  assert.equal(duplicateRun.status, 201);
  const duplicateResult = await duplicateRun.json();
  assert.equal(duplicateResult.accepted, 0);
  assert.equal(duplicateResult.rejected, 1);
  researchedBundle = await (await ownerRequest(`/api/products/${first.product.id}`)).json();
  const recordedDuplicateRun = researchedBundle.experiments[0].runs.find((run) => run.id === duplicateResult.runId);
  assert.match(recordedDuplicateRun.rejections[0].reason, /Duplicate person, company, or conversation/);

  const automaticExperimentResponse = await ownerRequest(`/api/products/${first.product.id}/experiments`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Automatic simulated intent research',
      hypothesis: 'Current first-person workflow blockers are worth reviewing.',
      audience: 'Builders trying to move a working prototype into real use',
      signal: 'A current public statement that production workflow failures are blocking progress',
      successCriteria: 'At least 3 of 10 are genuinely worth contacting',
      allowedSourceIds: ['simulated_public'],
    }),
  });
  assert.equal(automaticExperimentResponse.status, 201);
  const automaticBundle = await automaticExperimentResponse.json();
  const automaticExperiment = automaticBundle.experiments.find((item) => item.name === 'Automatic simulated intent research');
  const automaticRunResponse = await ownerRequest(`/api/experiments/${automaticExperiment.id}/runs`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(automaticRunResponse.status, 202);
  const automaticRunId = (await automaticRunResponse.json()).runId;
  let automaticRun;
  let sawPartialResult = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const detail = await (await ownerRequest(`/api/runs/${automaticRunId}`)).json();
    automaticRun = detail.run;
    if (['queued', 'starting', 'running'].includes(automaticRun.status) && automaticRun.opportunity_count > 0) sawPartialResult = true;
    if (!['queued', 'starting', 'running'].includes(automaticRun.status)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.equal(automaticRun.status, 'completed');
  assert.equal(automaticRun.accepted_count, 10);
  assert.equal(automaticRun.rejected_count, 2);
  assert.equal(sawPartialResult, true);

  researchedBundle = await (await ownerRequest(`/api/products/${first.product.id}`)).json();
  const automaticOpportunities = researchedBundle.opportunities.filter((item) => item.run_id === automaticRunId);
  assert.equal(automaticOpportunities.length, 10);
  assert.ok(automaticOpportunities.every((item) => item.evidence_source_type === 'simulated_public'));
  assert.ok(automaticOpportunities.every((item) => item.draft_status === 'awaiting_approval'));

  const disableSimulation = await ownerRequest('/api/sources/simulated_public', {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disableSimulation.status, 200);
  const blockedRun = await ownerRequest(`/api/experiments/${automaticExperiment.id}/runs`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(blockedRun.status, 409);
  researchedBundle = await (await ownerRequest(`/api/products/${first.product.id}`)).json();
  assert.equal(researchedBundle.opportunities.filter((item) => item.run_id === automaticRunId).length, 10);

  const liveSourceChange = await ownerRequest('/api/sources/public_web', {
    method: 'PATCH',
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(liveSourceChange.status, 409);

  await context.test('slow simulated research saves visible progress before completion', async () => {
  const slowProduct = await createProduct('Slow Safety Proof', 'Isolated product for slow simulated research checks.');
  const enableSlow = await setSimulatedSource('simulated_slow', { enabled: true });
  assert.equal(enableSlow.status, 200);
  const slowExperiment = await createSimulatedExperiment(slowProduct.product.id, 'Slow progress proof', 'simulated_slow');
  const slowRunId = await startAutomatedRun(slowExperiment.id);
  const slowResult = await waitForAutomatedRun(slowRunId);
  const visibleSlowProgress = slowResult.snapshots.find((run) =>
    run.status === 'running'
      && run.current_stage === 'qualification'
      && run.processed_count > 0
      && run.opportunity_count > 0
      && run.processed_count < run.input_count
      && /evaluated/i.test(run.progress_note));
  assert.ok(visibleSlowProgress, 'Slow research should expose saved progress and a partial opportunity before completion.');
  assert.equal(slowResult.detail.run.status, 'completed');
  assert.equal(slowResult.detail.run.accepted_count, 10);
  assert.equal(slowResult.detail.run.rejected_count, 2);
  assert.equal(slowResult.detail.sources[0].status, 'completed');
  const slowBundle = await (await ownerRequest(`/api/products/${slowProduct.product.id}`)).json();
  assert.equal(slowBundle.opportunities.filter((item) => item.run_id === slowRunId).length, 10);
  assert.ok(slowBundle.opportunities.filter((item) => item.run_id === slowRunId).every((item) => item.draft_status === 'awaiting_approval'));
  const disableSlow = await setSimulatedSource('simulated_slow', { enabled: false });
  assert.equal(disableSlow.status, 200);
  const blockedSlow = await ownerRequest(`/api/experiments/${slowExperiment.id}/runs`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(blockedSlow.status, 409);
  const slowAfterDisable = await (await ownerRequest(`/api/products/${slowProduct.product.id}`)).json();
  assert.equal(slowAfterDisable.opportunities.filter((item) => item.run_id === slowRunId).length, 10);
  });

  await context.test('planned source failure preserves partial results and ends recoverably', async () => {
  const failureProduct = await createProduct('Failure Safety Proof', 'Isolated product for recoverable simulated failure checks.');
  const enableFailure = await setSimulatedSource('simulated_failure', { enabled: true });
  assert.equal(enableFailure.status, 200);
  const failureExperiment = await createSimulatedExperiment(failureProduct.product.id, 'Recoverable failure proof', 'simulated_failure');
  const failureRunId = await startAutomatedRun(failureExperiment.id);
  const failureResult = await waitForAutomatedRun(failureRunId);
  assert.equal(failureResult.detail.run.status, 'completed_with_issues');
  assert.equal(failureResult.detail.run.accepted_count, 2);
  assert.equal(failureResult.detail.run.processed_count, 2);
  assert.match(failureResult.detail.run.progress_note, /saved opportunities.*source issues/i);
  assert.match(failureResult.detail.run.error_note, /planned simulated source failure/i);
  assert.equal(failureResult.detail.sources[0].status, 'failed');
  assert.match(failureResult.detail.sources[0].error_note, /partial evidence was saved/i);
  const failureBundle = await (await ownerRequest(`/api/products/${failureProduct.product.id}`)).json();
  assert.equal(failureBundle.opportunities.filter((item) => item.run_id === failureRunId).length, 2);
  assert.ok(failureBundle.opportunities.filter((item) => item.run_id === failureRunId).every((item) => item.draft_status === 'awaiting_approval'));
  const disableFailure = await setSimulatedSource('simulated_failure', { enabled: false });
  assert.equal(disableFailure.status, 200);
  const blockedFailure = await ownerRequest(`/api/experiments/${failureExperiment.id}/runs`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(blockedFailure.status, 409);
  const failureAfterDisable = await (await ownerRequest(`/api/products/${failureProduct.product.id}`)).json();
  assert.equal(failureAfterDisable.opportunities.filter((item) => item.run_id === failureRunId).length, 2);
  });

  await context.test('disabled simulated source blocks new work without hiding saved results', async () => {
  const disabledProduct = await createProduct('Disabled Source Proof', 'Isolated product for source enable and disable checks.');
  const disabledExperiment = await createSimulatedExperiment(disabledProduct.product.id, 'Disabled source proof', 'simulated_disabled');
  const initiallyBlocked = await ownerRequest(`/api/experiments/${disabledExperiment.id}/runs`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(initiallyBlocked.status, 409);
  const enableDisabledSource = await setSimulatedSource('simulated_disabled', { enabled: true });
  assert.equal(enableDisabledSource.status, 200);
  const enabledRunId = await startAutomatedRun(disabledExperiment.id);
  const enabledResult = await waitForAutomatedRun(enabledRunId);
  assert.equal(enabledResult.detail.run.status, 'completed');
  assert.equal(enabledResult.detail.run.accepted_count, 10);
  const turnDisabledOff = await setSimulatedSource('simulated_disabled', { enabled: false });
  assert.equal(turnDisabledOff.status, 200);
  const disabledAgain = await ownerRequest(`/api/experiments/${disabledExperiment.id}/runs`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(disabledAgain.status, 409);
  const disabledBundle = await (await ownerRequest(`/api/products/${disabledProduct.product.id}`)).json();
  assert.equal(disabledBundle.opportunities.filter((item) => item.run_id === enabledRunId).length, 10);
  });

  await context.test('paid simulation requires approval and stops exactly at its monthly limit', async () => {
  const paidProduct = await createProduct('Spending Cap Proof', 'Isolated product for fictional paid-provider checks.');
  const paidExperiment = await createSimulatedExperiment(paidProduct.product.id, 'Fictional spending cap proof', 'simulated_paid');
  const unapprovedPaidRun = await ownerRequest(`/api/experiments/${paidExperiment.id}/runs`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(unapprovedPaidRun.status, 409);
  assert.match((await unapprovedPaidRun.json()).error, /source policy.*disabled/i);
  const paidWithoutApproval = await setSimulatedSource('simulated_paid', {
    enabled: true,
    approved: false,
    approvedMonthlyCents: 50,
  });
  assert.equal(paidWithoutApproval.status, 400);
  const paidWithoutLimit = await setSimulatedSource('simulated_paid', {
    enabled: true,
    approved: true,
    approvedMonthlyCents: 0,
  });
  assert.equal(paidWithoutLimit.status, 400);
  const enablePaid = await setSimulatedSource('simulated_paid', {
    enabled: true,
    approved: true,
    approvedMonthlyCents: 50,
  });
  assert.equal(enablePaid.status, 200);
  const paidRunId = await startAutomatedRun(paidExperiment.id);
  const paidResult = await waitForAutomatedRun(paidRunId);
  assert.equal(paidResult.detail.run.status, 'completed_with_issues');
  assert.equal(paidResult.detail.run.accepted_count, 2);
  assert.equal(paidResult.detail.run.processed_count, 2);
  assert.match(paidResult.detail.run.error_note, /monthly limit was reached/i);
  assert.equal(paidResult.detail.sources[0].status, 'budget_stopped');
  assert.equal(paidResult.detail.sources[0].cost_cents, 50);
  const usage = db.prepare(`SELECT COUNT(*) AS entries, COALESCE(SUM(amount_cents), 0) AS total
    FROM provider_usage WHERE provider_id = 'simulated_paid' AND run_id = ?`).get(paidRunId);
  assert.equal(usage.entries, 2);
  assert.equal(usage.total, 50);
  const sourceState = await (await ownerRequest('/api/sources')).json();
  const paidSource = sourceState.sources.find((source) => source.id === 'simulated_paid');
  assert.equal(paidSource.budget_enabled, 1);
  assert.equal(paidSource.approved_monthly_cents, 50);
  assert.equal(paidSource.spent_monthly_cents, 50);
  const overBudgetRun = await ownerRequest(`/api/experiments/${paidExperiment.id}/runs`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(overBudgetRun.status, 409);
  assert.match((await overBudgetRun.json()).error, /monthly cap.*reached/i);
  const disablePaid = await setSimulatedSource('simulated_paid', { enabled: false, approved: false, approvedMonthlyCents: null });
  assert.equal(disablePaid.status, 200);
  const paidWhileDisabled = await ownerRequest(`/api/experiments/${paidExperiment.id}/runs`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(paidWhileDisabled.status, 409);
  const paidBundle = await (await ownerRequest(`/api/products/${paidProduct.product.id}`)).json();
  assert.equal(paidBundle.opportunities.filter((item) => item.run_id === paidRunId).length, 2);
  assert.ok(paidBundle.opportunities.filter((item) => item.run_id === paidRunId).every((item) => item.draft_status === 'awaiting_approval'));
  });

  const draftResponse = await ownerRequest(`/api/opportunities/${opportunity.id}/drafts`, {
    method: 'POST',
    body: JSON.stringify({ channel: 'public_reply' }),
  });
  assert.equal(draftResponse.status, 201);
  assert.equal((await draftResponse.json()).status, 'awaiting_approval');

  const versionBeforeFeedback = researchedBundle.profile.version;
  const feedbackResponse = await ownerRequest(`/api/opportunities/${opportunity.id}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ rating: 'great_lead' }),
  });
  assert.equal(feedbackResponse.status, 201);
  const outcomeResponse = await ownerRequest(`/api/opportunities/${opportunity.id}/outcomes`, {
    method: 'POST',
    body: JSON.stringify({ outcome: 'activated' }),
  });
  assert.equal(outcomeResponse.status, 201);
  researchedBundle = await (await ownerRequest(`/api/products/${first.product.id}`)).json();
  assert.ok(researchedBundle.profile.version > versionBeforeFeedback);
  assert.ok(researchedBundle.profile.statements.some((item) => item.section === 'Learnings' && item.statement.includes('Prioritize similar evidence patterns')));
  const manualExperiment = researchedBundle.experiments.find((item) => item.id === experimentId);
  assert.equal(manualExperiment.great_lead_count, 1);
  assert.equal(manualExperiment.activated_count, 1);

  const profileAfterRefresh = await (await ownerRequest(`/api/products/${first.product.id}/profile`, { method: 'POST' })).json();
  assert.ok(profileAfterRefresh.profile.statements.some((item) => item.section === 'Learnings' && item.statement.includes('Prioritize similar evidence patterns')));
  assert.ok(profileAfterRefresh.profile.statements.some((item) => item.section === 'Experiments attempted' && item.statement.includes('recorded GTM experiment')));
});
