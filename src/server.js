import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now, transaction } from './db.js';
import { clearSessionCookie, createSession, hashPassword, readSession, sessionCookie, verifyPassword } from './auth.js';
import { manualPublicSource } from './sources/manual-public.js';
import { simulatedSource } from './sources/simulated.js';
import { qualifyEvidence } from './qualification.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = 1_000_000;
const MAX_ACTIVE_RUNS = 2;
const activeAutomatedRuns = new Set();
const queuedAutomatedRuns = [];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(value));
}

function fail(response, status, message, details) {
  json(response, status, { error: message, ...(details ? { details } : {}) });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 });
  }
}

function secureRequest(request) {
  return request.headers['x-forwarded-proto'] === 'https' || !isLoopback(request);
}

function isLoopback(request) {
  const address = request.socket.remoteAddress || '';
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

function cleanText(value, max = 10_000) {
  return String(value || '').trim().slice(0, max);
}

function cleanHttpUrl(value, max = 1000) {
  const cleaned = cleanText(value, max);
  if (!cleaned) return null;
  try {
    const parsed = new URL(cleaned);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported protocol.');
    return parsed.toString();
  } catch {
    throw Object.assign(new Error('Links must use a valid public http(s) URL.'), { status: 400 });
  }
}

function requireFields(body, fields) {
  const missing = fields.filter((field) => !cleanText(body[field]));
  if (missing.length) throw Object.assign(new Error(`Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`), { status: 400 });
}

function idFrom(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw Object.assign(new Error('Invalid record identifier.'), { status: 400 });
  return id;
}

function parseSources(value) {
  try {
    return JSON.parse(value || '[]');
  } catch {
    return [];
  }
}

function getProduct(productId) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw Object.assign(new Error('Product not found.'), { status: 404 });
  return product;
}

function getExperiment(experimentId) {
  const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(experimentId);
  if (!experiment) throw Object.assign(new Error('Experiment not found.'), { status: 404 });
  return { ...experiment, allowedSourceIds: parseSources(experiment.allowed_source_ids) };
}

function latestProfile(productId) {
  const version = db.prepare('SELECT * FROM profile_versions WHERE product_id = ? ORDER BY version DESC LIMIT 1').get(productId);
  if (!version) return null;
  const statements = db.prepare(`
    SELECT ps.*, e.title AS evidence_title, e.source_url AS evidence_url, e.excerpt AS evidence_excerpt
    FROM profile_statements ps LEFT JOIN evidence e ON e.id = ps.evidence_id
    WHERE ps.profile_version_id = ? ORDER BY ps.section, ps.id
  `).all(version.id);
  return { ...version, statements };
}

function productBundle(productId) {
  const product = getProduct(productId);
  const materials = db.prepare('SELECT * FROM materials WHERE product_id = ? ORDER BY created_at DESC').all(productId);
  const profile = latestProfile(productId);
  const discussions = db.prepare('SELECT * FROM discussion_messages WHERE product_id = ? ORDER BY created_at').all(productId);
  const experiments = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM research_runs r WHERE r.experiment_id = e.id) AS run_count,
      (SELECT COUNT(*) FROM opportunities o JOIN research_runs r ON r.id = o.run_id WHERE r.experiment_id = e.id) AS opportunity_count,
      (SELECT COUNT(*) FROM opportunities o JOIN research_runs r ON r.id = o.run_id
        WHERE r.experiment_id = e.id AND (SELECT rating FROM feedback WHERE opportunity_id = o.id ORDER BY created_at DESC, id DESC LIMIT 1) = 'great_lead') AS great_lead_count,
      (SELECT COUNT(*) FROM opportunities o JOIN research_runs r ON r.id = o.run_id
        WHERE r.experiment_id = e.id AND (SELECT outcome FROM outcomes WHERE opportunity_id = o.id ORDER BY created_at DESC, id DESC LIMIT 1) = 'replied') AS replied_count,
      (SELECT COUNT(*) FROM opportunities o JOIN research_runs r ON r.id = o.run_id
        WHERE r.experiment_id = e.id AND (SELECT outcome FROM outcomes WHERE opportunity_id = o.id ORDER BY created_at DESC, id DESC LIMIT 1) = 'signed_up') AS signed_up_count,
      (SELECT COUNT(*) FROM opportunities o JOIN research_runs r ON r.id = o.run_id
        WHERE r.experiment_id = e.id AND (SELECT outcome FROM outcomes WHERE opportunity_id = o.id ORDER BY created_at DESC, id DESC LIMIT 1) = 'activated') AS activated_count
    FROM experiments e WHERE e.product_id = ? ORDER BY e.created_at DESC
  `).all(productId).map((item) => {
    const runs = db.prepare('SELECT * FROM research_runs WHERE experiment_id = ? ORDER BY started_at DESC').all(item.id).map((run) => ({
      ...run,
      events: db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at').all(run.id),
      rejections: db.prepare('SELECT * FROM rejected_candidates WHERE run_id = ? ORDER BY id').all(run.id),
      sources: db.prepare(`SELECT rs.*, sp.name AS source_name, sp.source_kind
        FROM run_sources rs JOIN source_policies sp ON sp.id = rs.source_id
        WHERE rs.run_id = ? ORDER BY rs.id`).all(run.id),
    }));
    return { ...item, allowedSourceIds: parseSources(item.allowed_source_ids), runs };
  });
  const opportunities = db.prepare(`
    SELECT o.*, e.title AS evidence_title, e.source_url AS evidence_url, e.excerpt AS evidence_excerpt, e.source_type AS evidence_source_type,
      d.id AS draft_id, d.channel AS draft_channel, d.body AS draft_body, d.status AS draft_status,
      (SELECT rating FROM feedback WHERE opportunity_id = o.id ORDER BY created_at DESC, id DESC LIMIT 1) AS feedback_rating,
      (SELECT outcome FROM outcomes WHERE opportunity_id = o.id ORDER BY created_at DESC, id DESC LIMIT 1) AS latest_outcome
    FROM opportunities o JOIN evidence e ON e.id = o.evidence_id
    LEFT JOIN drafts d ON d.id = (SELECT id FROM drafts WHERE opportunity_id = o.id ORDER BY created_at DESC, id DESC LIMIT 1)
    WHERE o.product_id = ? ORDER BY o.score DESC, o.rank ASC
  `).all(productId);
  const learnings = db.prepare('SELECT * FROM learnings WHERE product_id = ? ORDER BY created_at DESC').all(productId);
  return { product, materials, profile, discussions, experiments, opportunities, learnings };
}

function sourceSettings() {
  return db.prepare(`
    SELECT sp.*, pb.approved_monthly_cents, pb.spent_monthly_cents, pb.enabled AS budget_enabled
    FROM source_policies sp LEFT JOIN provider_budgets pb ON pb.provider_id = sp.id
    ORDER BY CASE sp.source_kind WHEN 'simulation' THEN 0 WHEN 'owner_input' THEN 1 ELSE 2 END, sp.name
  `).all();
}

function createInitialProfile(productId) {
  const product = getProduct(productId);
  const materials = db.prepare('SELECT * FROM materials WHERE product_id = ? AND content IS NOT NULL AND TRIM(content) <> ? ORDER BY id').all(productId, '');
  const supportedMaterials = materials.slice(-8).map((material) => {
    const result = db.prepare(`INSERT INTO evidence
      (product_id, material_id, source_type, source_url, title, excerpt, captured_at)
      VALUES (?, ?, 'owner_material', ?, ?, ?, ?)`) 
      .run(productId, material.id, cleanHttpUrl(material.source_url), material.label, material.content.slice(0, 1200), now());
    return { material, evidenceId: Number(result.lastInsertRowid) };
  });
  const experimentStats = db.prepare(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed
    FROM experiments WHERE product_id = ?
  `).get(productId);
  const experimentSummary = experimentStats.completed
    ? `${experimentStats.completed} of ${experimentStats.total} recorded GTM experiment${experimentStats.total === 1 ? '' : 's'} ${experimentStats.completed === 1 ? 'has' : 'have'} completed.`
    : 'No completed GTM experiment existed when this profile version was created.';
  const systemEvidenceId = Number(db.prepare(`INSERT INTO evidence
    (product_id, source_type, source_url, title, excerpt, captured_at)
    VALUES (?, 'system_state', NULL, 'Experiment history at profile creation', ?, ?)`) 
    .run(productId, experimentSummary, now()).lastInsertRowid);
  const storedLearnings = db.prepare('SELECT * FROM learnings WHERE product_id = ? ORDER BY created_at DESC LIMIT 8').all(productId);
  const learningStatements = storedLearnings.map((learning) => {
    const evidenceId = Number(db.prepare(`INSERT INTO evidence
      (product_id, source_type, source_url, title, excerpt, captured_at)
      VALUES (?, 'learning_history', NULL, 'Recorded experiment learning', ?, ?)`) 
      .run(productId, learning.basis, now()).lastInsertRowid);
    return ['Learnings', learning.statement, 'known', evidenceId];
  });

  const previous = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM profile_versions WHERE product_id = ?').get(productId).version;
  const version = previous + 1;
  const versionId = Number(db.prepare('INSERT INTO profile_versions (product_id, version, reason, created_at) VALUES (?, ?, ?, ?)')
    .run(productId, version, version === 1 ? 'Initial evidence-first profile scaffold' : 'Profile regenerated from current approved material', now()).lastInsertRowid);

  const productStatements = supportedMaterials.length
    ? supportedMaterials.map(({ material, evidenceId }) => [
      'Product',
      `${material.label}: ${cleanText(material.content, 500)}`,
      'known',
      evidenceId,
    ])
    : [['Product', `${product.name} has been added, but its current capability still needs evidence.`, 'needs_testing', null]];
  const statements = [
    ...productStatements,
    ['Problem', 'Which urgent problem is painful enough that someone would act now?', 'needs_testing', null],
    ['Product maturity', 'Confirm what a new user can successfully use or buy today.', 'needs_testing', null],
    ['ICP hypotheses', 'Identify the narrowest group with observable current pain rather than relying on job title or company size.', 'hypothesis', null],
    ['Jobs to be done', 'Describe the progress a user is trying to make when the problem occurs.', 'needs_testing', null],
    ['Strong intent signals', 'Look for a specific, recent statement of the problem plus evidence the person is trying to solve it.', 'hypothesis', null],
    ['Weak signals', 'Demographic fit, tool usage, or a broad interest without a current problem should be treated as weak signals.', 'hypothesis', null],
    ['Disqualifiers', 'Exclude people whose problem is already solved, whose situation cannot use the product, or where contact would be inappropriate.', 'hypothesis', null],
    ['Alternatives / competitors', 'Research what people currently do instead before naming competitors.', 'needs_testing', null],
    ['Acquisition channels', 'Prefer public places where the problem is naturally discussed and contact is permitted.', 'hypothesis', null],
    ['Activation event', 'Define the first observable moment when a user genuinely receives value.', 'needs_testing', null],
    ['Geography', 'No geographic constraint is known yet.', 'needs_testing', null],
    ['Pricing / business model', 'Pricing and buying motion are not yet evidenced.', 'needs_testing', null],
    ['Existing traction', 'No traction evidence has been recorded yet.', 'needs_testing', null],
    ['Experiments attempted', experimentSummary, 'known', systemEvidenceId],
    ...(learningStatements.length ? learningStatements : [['Learnings', 'Begin with one narrow ICP and one observable intent signal.', 'hypothesis', null]]),
    ['Open questions', 'What answer would most change the first ICP, signal, or activation strategy?', 'needs_testing', null],
  ];
  const insert = db.prepare(`INSERT INTO profile_statements
    (profile_version_id, section, knowledge_state, statement, evidence_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const [section, statement, state, statementEvidence] of statements) {
    insert.run(versionId, section, state, statement, statementEvidence, now());
  }

  const thesis = supportedMaterials.length
    ? `I used the approved material to establish what ${product.name} says it does, but the customer and urgency claims are still hypotheses. The strongest first experiment should pair one narrow audience with a recent, observable problem statement. Before changing strategy, the material gap most likely to matter is: what can a user complete successfully today, and what outcome proves they received value?`
    : `There is not enough product evidence to form a responsible GTM thesis yet. Add a README, website excerpt, product note, or feedback sample. I will use it before asking strategy questions.`;
  db.prepare('INSERT INTO discussion_messages (product_id, role, body, created_at) VALUES (?, ?, ?, ?)')
    .run(productId, 'agent', thesis, now());
}

function addCorrection(productId, body) {
  requireFields(body, ['message']);
  const message = cleanText(body.message, 4000);
  db.prepare('INSERT INTO discussion_messages (product_id, role, body, created_at) VALUES (?, ?, ?, ?)')
    .run(productId, 'owner', message, now());

  const current = latestProfile(productId);
  if (current) {
    const correctionEvidenceId = Number(db.prepare(`INSERT INTO evidence
      (product_id, source_type, source_url, title, excerpt, captured_at)
      VALUES (?, 'owner_discussion', NULL, 'Owner correction in GTM discussion', ?, ?)`)
      .run(productId, message, now()).lastInsertRowid);
    const nextVersion = current.version + 1;
    const nextId = Number(db.prepare('INSERT INTO profile_versions (product_id, version, reason, created_at) VALUES (?, ?, ?, ?)')
      .run(productId, nextVersion, 'Owner correction recorded in GTM discussion', now()).lastInsertRowid);
    const insert = db.prepare(`INSERT INTO profile_statements
      (profile_version_id, section, knowledge_state, statement, evidence_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const statement of current.statements) {
      insert.run(nextId, statement.section, statement.knowledge_state, statement.statement, statement.evidence_id || null, now());
    }
    insert.run(nextId, 'Learnings', 'known', `Owner context: ${message}`, correctionEvidenceId, now());
  }

  const response = `I’ve treated that as owner evidence and preserved the earlier thesis in history. I would now test whether it changes the audience, the observable signal, or the activation event before broadening the strategy. The next useful question is: what real-world behaviour would prove this correction is true?`;
  db.prepare('INSERT INTO discussion_messages (product_id, role, body, created_at) VALUES (?, ?, ?, ?)')
    .run(productId, 'agent', response, now());
}

function addProfileStatement(productId, body) {
  requireFields(body, ['section', 'knowledgeState', 'statement']);
  if (!['known', 'hypothesis', 'needs_testing'].includes(body.knowledgeState)) {
    throw Object.assign(new Error('Choose known, hypothesis, or needs testing.'), { status: 400 });
  }
  const current = latestProfile(productId);
  if (!current) throw Object.assign(new Error('Create the first profile before adding a statement.'), { status: 409 });
  if (body.knowledgeState === 'known' && !cleanText(body.evidenceExcerpt, 2000)) {
    throw Object.assign(new Error('A known statement needs an evidence excerpt. Use hypothesis or needs testing when support is not available yet.'), { status: 400 });
  }
  return transaction(() => {
    const nextId = Number(db.prepare('INSERT INTO profile_versions (product_id, version, reason, created_at) VALUES (?, ?, ?, ?)')
      .run(productId, current.version + 1, 'Owner edited the structured GTM profile', now()).lastInsertRowid);
    const insert = db.prepare(`INSERT INTO profile_statements
      (profile_version_id, section, knowledge_state, statement, evidence_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const item of current.statements) {
      insert.run(nextId, item.section, item.knowledge_state, item.statement, item.evidence_id || null, now());
    }
    let evidenceId = null;
    const evidenceExcerpt = cleanText(body.evidenceExcerpt, 2000);
    if (evidenceExcerpt) {
      evidenceId = Number(db.prepare(`INSERT INTO evidence
        (product_id, source_type, source_url, title, excerpt, captured_at) VALUES (?, 'owner_profile_edit', ?, ?, ?, ?)`) 
        .run(productId, cleanHttpUrl(body.evidenceUrl), cleanText(body.evidenceTitle, 240) || 'Owner-provided profile evidence', evidenceExcerpt, now()).lastInsertRowid);
    }
    insert.run(nextId, cleanText(body.section, 100), body.knowledgeState, cleanText(body.statement, 4000), evidenceId, now());
  });
}

function recordFailedRun(experimentId, inputCount, message) {
  const stamp = now();
  const runId = Number(db.prepare(`INSERT INTO research_runs
    (experiment_id, status, input_count, accepted_count, rejected_count, progress_note, error_note, current_stage, started_at, completed_at)
    VALUES (?, 'failed', ?, 0, 0, 'Stopped before evidence collection', ?, 'blocked', ?, ?)`) 
    .run(experimentId, inputCount, message, stamp, stamp).lastInsertRowid);
  db.prepare('INSERT INTO run_events (run_id, level, message, created_at) VALUES (?, ?, ?, ?)')
    .run(runId, 'error', message, stamp);
  return runId;
}

function policiesForExperiment(experiment) {
  return db.prepare(`SELECT * FROM source_policies WHERE id IN (${experiment.allowedSourceIds.map(() => '?').join(',') || "''"})`).all(...experiment.allowedSourceIds);
}

function validateRunPolicies(experiment, policies, inputCount) {
  const blocked = policies.filter((policy) => !policy.enabled || !policy.discover_allowed || !policy.read_allowed || !policy.store_allowed || policy.implementation_status !== 'available');
  if (blocked.length) {
    const message = `Run blocked by source policy: ${blocked.map((item) => `${item.name} (${item.enabled ? item.implementation_status : 'disabled'})`).join(', ')}`;
    recordFailedRun(experiment.id, inputCount, message);
    throw Object.assign(new Error(message), { status: 409 });
  }
  for (const policy of policies.filter((item) => item.paid)) {
    const budget = db.prepare('SELECT * FROM provider_budgets WHERE provider_id = ?').get(policy.id);
    if (!budget?.enabled || !Number.isInteger(budget.approved_monthly_cents) || budget.approved_monthly_cents <= 0) {
      const message = `Paid research is disabled for ${policy.name} until an approved monthly cap is recorded.`;
      recordFailedRun(experiment.id, inputCount, message);
      throw Object.assign(new Error(message), { status: 409 });
    }
    if (budget.spent_monthly_cents >= budget.approved_monthly_cents) {
      const message = `The approved monthly cap for ${policy.name} has been reached.`;
      recordFailedRun(experiment.id, inputCount, message);
      throw Object.assign(new Error(message), { status: 409 });
    }
  }
  return policies;
}

function priorIdentityState(productId) {
  const prior = db.prepare(`
    SELECT o.person_name, o.company_name, e.source_url
    FROM opportunities o JOIN evidence e ON e.id = o.evidence_id
    WHERE o.product_id = ?
  `).all(productId);
  const keysFor = (item) => [
    item.personName || item.person_name ? `person:${String(item.personName || item.person_name).trim().toLowerCase()}` : '',
    item.companyName || item.company_name ? `company:${String(item.companyName || item.company_name).trim().toLowerCase()}` : '',
  ].filter(Boolean);
  return {
    keysFor,
    identities: new Set(prior.flatMap(keysFor)),
    urls: new Set(prior.map((item) => String(item.source_url || '').trim().toLowerCase()).filter(Boolean)),
  };
}

function duplicateReason(candidate, identityState) {
  const keys = identityState.keysFor(candidate);
  const url = String(candidate.sourceUrl || '').trim().toLowerCase();
  if (keys.some((key) => identityState.identities.has(key)) || (url && identityState.urls.has(url))) {
    return 'Duplicate person, company, or conversation already recorded for this product.';
  }
  keys.forEach((key) => identityState.identities.add(key));
  if (url) identityState.urls.add(url);
  return null;
}

function insertRejected(runId, candidate, reason) {
  db.prepare('INSERT INTO rejected_candidates (run_id, identity_label, source_url, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(runId, candidate.personName || candidate.companyName || 'Unidentified candidate', candidate.sourceUrl || null, reason, now());
}

function insertOpportunity(runId, experiment, source, candidate, qualification, rank) {
  const evidenceId = Number(db.prepare(`INSERT INTO evidence
    (product_id, source_type, source_url, title, excerpt, captured_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    experiment.product_id,
    source.id,
    candidate.sourceUrl,
    candidate.sourceTitle,
    candidate.evidenceExcerpt,
    candidate.capturedAt || now(),
  ).lastInsertRowid);
  const opportunityId = Number(db.prepare(`INSERT INTO opportunities
    (run_id, product_id, person_name, company_name, signal, evidence_id, why_signal_matters, product_fit,
     intent_strength, intent_reason, disqualifiers, recommended_action, action_reason, personalization_context,
     confidence, score, rank, original_reasoning, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    runId,
    experiment.product_id,
    candidate.personName || null,
    candidate.companyName || null,
    candidate.signal,
    evidenceId,
    qualification.whySignalMatters,
    qualification.productFit,
    qualification.intentStrength,
    qualification.intentReason,
    cleanText(candidate.disqualifiers, 1000) || null,
    qualification.recommendedAction,
    qualification.actionReason,
    cleanText(candidate.personalizationContext, 1200) || null,
    qualification.confidence,
    qualification.score,
    rank,
    qualification.originalReasoning,
    now(),
  ).lastInsertRowid);
  if (['public_reply', 'dm', 'email'].includes(qualification.recommendedAction)) draftForOpportunity(opportunityId, {});
  return opportunityId;
}

function runOwnerEvidenceExperiment(experiment, candidates, policies) {
  if (!experiment.allowedSourceIds.includes('manual_public')) {
    const message = 'Owner-supplied excerpts require the owner-provided public evidence source.';
    recordFailedRun(experiment.id, candidates.length, message);
    throw Object.assign(new Error(message), { status: 409 });
  }
  if (!candidates.length) throw Object.assign(new Error('Add at least one public evidence excerpt before running this source.'), { status: 400 });
  const source = policies.find((item) => item.id === 'manual_public');

  return transaction(() => {
    const startedAt = now();
    const runId = Number(db.prepare(`INSERT INTO research_runs
      (experiment_id, status, input_count, accepted_count, rejected_count, progress_note, current_stage, started_at)
      VALUES (?, 'running', ?, 0, 0, ?, 'qualification', ?)`) 
      .run(experiment.id, candidates.length, 'Deriving qualification from owner-supplied evidence', startedAt).lastInsertRowid);
    const event = db.prepare('INSERT INTO run_events (run_id, level, message, created_at) VALUES (?, ?, ?, ?)');
    event.run(runId, 'info', `Run started with ${candidates.length} owner-supplied excerpt${candidates.length === 1 ? '' : 's'}; no numeric scoring is required.`, now());
    db.prepare(`INSERT INTO run_sources (run_id, source_id, status, discovered_count, started_at)
      VALUES (?, 'manual_public', 'running', ?, ?)`).run(runId, candidates.length, now());
    const identityState = priorIdentityState(experiment.product_id);
    const accepted = [];
    const rejected = [];
    for (const raw of candidates) {
      const candidate = manualPublicSource.normalize(raw);
      const validation = manualPublicSource.validate(candidate);
      const identity = candidate.personName || candidate.companyName || 'Unidentified candidate';
      if (validation.length) {
        rejected.push({ identity, sourceUrl: candidate.sourceUrl, reason: validation.join(' ') });
        continue;
      }
      const duplicate = duplicateReason(candidate, identityState);
      if (duplicate) {
        rejected.push({ identity, sourceUrl: candidate.sourceUrl, reason: duplicate });
        continue;
      }
      const qualification = qualifyEvidence(candidate, experiment, source);
      if (!qualification.accepted) {
        rejected.push({ identity, sourceUrl: candidate.sourceUrl, reason: qualification.reason });
        continue;
      }
      accepted.push({ candidate, qualification });
    }

    accepted.sort((a, b) => b.qualification.score - a.qualification.score);
    const selected = accepted.slice(0, 10);
    for (const overflow of accepted.slice(10)) {
      rejected.push({
        identity: overflow.candidate.personName || overflow.candidate.companyName,
        sourceUrl: overflow.candidate.sourceUrl,
        reason: 'Qualified but held outside the bounded top ten for this run.',
      });
    }

    selected.forEach(({ candidate, qualification }, index) => {
      insertOpportunity(runId, experiment, source, candidate, qualification, index + 1);
    });
    const insertRejected = db.prepare('INSERT INTO rejected_candidates (run_id, identity_label, source_url, reason, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const item of rejected) insertRejected.run(runId, item.identity, item.sourceUrl || null, item.reason, now());

    db.prepare(`UPDATE research_runs SET status = 'completed', accepted_count = ?, rejected_count = ?,
      processed_count = ?, progress_note = ?, current_stage = 'complete', completed_at = ? WHERE id = ?`)
      .run(selected.length, rejected.length, candidates.length, `Completed with ${selected.length} ranked opportunities and ${rejected.length} recorded rejections.`, now(), runId);
    db.prepare(`UPDATE run_sources SET status = 'completed', processed_count = ?, accepted_count = ?, completed_at = ? WHERE run_id = ? AND source_id = 'manual_public'`)
      .run(candidates.length, selected.length, now(), runId);
    db.prepare(`UPDATE experiments SET status = 'completed', updated_at = ? WHERE id = ?`).run(now(), experiment.id);
    event.run(runId, 'info', `Qualification completed. ${selected.length} opportunities retained.`, now());
    return { runId, accepted: selected.length, rejected: rejected.length };
  });
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function appendRunError(runId, message) {
  const current = db.prepare('SELECT error_note FROM research_runs WHERE id = ?').get(runId)?.error_note;
  db.prepare('UPDATE research_runs SET error_note = ? WHERE id = ?').run([current, message].filter(Boolean).join(' '), runId);
}

function chargeSimulatedUsage(source, runId) {
  if (!source.paid || source.unit_cost_cents <= 0) return true;
  const budget = db.prepare('SELECT * FROM provider_budgets WHERE provider_id = ?').get(source.id);
  if (!budget?.enabled || budget.approved_monthly_cents == null || budget.spent_monthly_cents + source.unit_cost_cents > budget.approved_monthly_cents) return false;
  transaction(() => {
    db.prepare('UPDATE provider_budgets SET spent_monthly_cents = spent_monthly_cents + ?, updated_at = ? WHERE provider_id = ?')
      .run(source.unit_cost_cents, now(), source.id);
    db.prepare('INSERT INTO provider_usage (provider_id, run_id, amount_cents, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(source.id, runId, source.unit_cost_cents, 'Simulated candidate evaluation', now());
    db.prepare('UPDATE run_sources SET cost_cents = cost_cents + ? WHERE run_id = ? AND source_id = ?')
      .run(source.unit_cost_cents, runId, source.id);
  });
  return true;
}

async function processAutomatedRun(runId) {
  const run = db.prepare('SELECT * FROM research_runs WHERE id = ?').get(runId);
  const experiment = getExperiment(run.experiment_id);
  const sources = policiesForExperiment(experiment).filter((source) => source.source_kind === 'simulation');
  const event = db.prepare('INSERT INTO run_events (run_id, level, message, created_at) VALUES (?, ?, ?, ?)');
  const identityState = priorIdentityState(experiment.product_id);
  let acceptedCount = 0;
  let rejectedCount = 0;
  let processedCount = 0;
  let hadIssue = false;

  db.prepare("UPDATE research_runs SET status = 'running', current_stage = 'permission_check', progress_note = ? WHERE id = ?")
    .run('Permissions confirmed; beginning simulated discovery.', runId);
  event.run(runId, 'info', 'Source permissions and availability were confirmed.', now());

  for (const source of sources) {
    db.prepare(`UPDATE run_sources SET status = 'running', started_at = ? WHERE run_id = ? AND source_id = ?`).run(now(), runId, source.id);
    db.prepare("UPDATE research_runs SET current_stage = 'discovery', progress_note = ? WHERE id = ?")
      .run(`Discovering fictional evidence in ${source.name}.`, runId);
    event.run(runId, 'info', `${source.name}: discovery started.`, now());
    try {
      const candidates = simulatedSource.discover(experiment, source);
      db.prepare('UPDATE run_sources SET discovered_count = ? WHERE run_id = ? AND source_id = ?').run(candidates.length, runId, source.id);
      db.prepare('UPDATE research_runs SET input_count = input_count + ? WHERE id = ?').run(candidates.length, runId);
      event.run(runId, 'info', `${source.name}: ${candidates.length} fictional candidates discovered.`, now());

      let sourceAccepted = 0;
      for (let index = 0; index < candidates.length; index += 1) {
        if (source.simulation_behavior === 'failure' && index === 2) throw new Error('Planned simulated source failure after partial evidence was saved.');
        if (!chargeSimulatedUsage(source, runId)) {
          hadIssue = true;
          const message = `${source.name} stopped before the next candidate because its approved simulated monthly limit was reached.`;
          db.prepare(`UPDATE run_sources SET status = 'budget_stopped', error_note = ?, completed_at = ? WHERE run_id = ? AND source_id = ?`)
            .run(message, now(), runId, source.id);
          appendRunError(runId, message);
          event.run(runId, 'warning', message, now());
          break;
        }
        const candidate = candidates[index];
        processedCount += 1;
        const duplicate = duplicateReason(candidate, identityState);
        const qualification = duplicate ? null : qualifyEvidence(candidate, experiment, source);
        let rejection = duplicate || (!qualification?.accepted ? qualification?.reason : null);
        if (!rejection && acceptedCount >= 10) rejection = 'Qualified but held outside the bounded top ten for this run.';
        if (rejection) {
          rejectedCount += 1;
          insertRejected(runId, candidate, rejection);
        } else {
          acceptedCount += 1;
          sourceAccepted += 1;
          insertOpportunity(runId, experiment, source, candidate, qualification, acceptedCount);
        }
        db.prepare(`UPDATE run_sources SET processed_count = processed_count + 1, accepted_count = ? WHERE run_id = ? AND source_id = ?`)
          .run(sourceAccepted, runId, source.id);
        db.prepare(`UPDATE research_runs SET processed_count = ?, accepted_count = ?, rejected_count = ?, current_stage = 'qualification', progress_note = ? WHERE id = ?`)
          .run(processedCount, acceptedCount, rejectedCount, `${source.name}: evaluated ${index + 1} of ${candidates.length}; ${acceptedCount} opportunities saved so far.`, runId);
        await sleep(source.simulation_behavior === 'slow' ? 250 : 35);
      }
      const sourceState = db.prepare('SELECT status FROM run_sources WHERE run_id = ? AND source_id = ?').get(runId, source.id)?.status;
      if (sourceState === 'running') {
        db.prepare(`UPDATE run_sources SET status = 'completed', completed_at = ? WHERE run_id = ? AND source_id = ?`).run(now(), runId, source.id);
        event.run(runId, 'info', `${source.name}: source work completed.`, now());
      }
    } catch (error) {
      hadIssue = true;
      db.prepare(`UPDATE run_sources SET status = 'failed', error_note = ?, completed_at = ? WHERE run_id = ? AND source_id = ?`)
        .run(error.message, now(), runId, source.id);
      appendRunError(runId, `${source.name}: ${error.message}`);
      event.run(runId, 'error', `${source.name}: ${error.message}`, now());
    }
  }

  const finalStatus = hadIssue ? 'completed_with_issues' : 'completed';
  db.prepare(`UPDATE research_runs SET status = ?, current_stage = 'complete', progress_note = ?, accepted_count = ?, rejected_count = ?, processed_count = ?, completed_at = ? WHERE id = ?`)
    .run(finalStatus, `Finished with ${acceptedCount} saved opportunities${hadIssue ? ' and source issues to review' : ''}.`, acceptedCount, rejectedCount, processedCount, now(), runId);
  db.prepare(`UPDATE experiments SET status = 'completed', updated_at = ? WHERE id = ?`).run(now(), experiment.id);
  event.run(runId, hadIssue ? 'warning' : 'info', `Run ${finalStatus === 'completed' ? 'completed' : 'completed with recoverable issues'}.`, now());
}

function startNextAutomatedRun() {
  while (activeAutomatedRuns.size < MAX_ACTIVE_RUNS && queuedAutomatedRuns.length) {
    const runId = queuedAutomatedRuns.shift();
    activeAutomatedRuns.add(runId);
    setTimeout(() => {
      processAutomatedRun(runId).catch((error) => {
        appendRunError(runId, error.message);
        db.prepare(`UPDATE research_runs SET status = 'failed', current_stage = 'failed', progress_note = 'Research stopped unexpectedly.', completed_at = ? WHERE id = ?`).run(now(), runId);
        db.prepare('INSERT INTO run_events (run_id, level, message, created_at) VALUES (?, ?, ?, ?)').run(runId, 'error', error.message, now());
      }).finally(() => {
        activeAutomatedRuns.delete(runId);
        startNextAutomatedRun();
      });
    }, 0);
  }
}

function createAutomatedRun(experiment, policies) {
  const startedAt = now();
  const queued = activeAutomatedRuns.size >= MAX_ACTIVE_RUNS;
  const runId = transaction(() => {
    const id = Number(db.prepare(`INSERT INTO research_runs
      (experiment_id, status, input_count, accepted_count, rejected_count, progress_note, current_stage, started_at)
      VALUES (?, ?, 0, 0, 0, ?, ?, ?)`).run(
      experiment.id,
      queued ? 'queued' : 'starting',
      queued ? 'Waiting for one of two bounded research slots.' : 'Preparing source permissions.',
      queued ? 'queued' : 'created',
      startedAt,
    ).lastInsertRowid);
    const insertSource = db.prepare('INSERT INTO run_sources (run_id, source_id, status) VALUES (?, ?, ?)');
    for (const source of policies.filter((item) => item.source_kind === 'simulation')) insertSource.run(id, source.id, 'queued');
    db.prepare('INSERT INTO run_events (run_id, level, message, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'info', queued ? 'Run queued because two bounded runs are already active.' : 'Run created; simulated research will start.', startedAt);
    db.prepare("UPDATE experiments SET status = 'running', updated_at = ? WHERE id = ?").run(startedAt, experiment.id);
    return id;
  });
  queuedAutomatedRuns.push(runId);
  startNextAutomatedRun();
  return { runId, status: queued ? 'queued' : 'starting' };
}

function runExperiment(experimentId, body) {
  const experiment = getExperiment(experimentId);
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 50) : [];
  const policies = validateRunPolicies(experiment, policiesForExperiment(experiment), candidates.length);
  const simulations = policies.filter((source) => simulatedSource.supports(source));
  if (simulations.length && candidates.length) {
    throw Object.assign(new Error('Run simulated discovery and owner-supplied excerpts separately so each source remains traceable.'), { status: 409 });
  }
  if (simulations.length) return { ...createAutomatedRun(experiment, simulations), asynchronous: true };
  return { ...runOwnerEvidenceExperiment(experiment, candidates, policies), asynchronous: false };
}

function draftForOpportunity(opportunityId, body) {
  const opportunity = db.prepare(`
    SELECT o.*, e.excerpt AS evidence_excerpt, e.source_url AS evidence_url, p.name AS product_name
    FROM opportunities o JOIN evidence e ON e.id = o.evidence_id JOIN products p ON p.id = o.product_id
    WHERE o.id = ?
  `).get(opportunityId);
  if (!opportunity) throw Object.assign(new Error('Opportunity not found.'), { status: 404 });
  const channel = cleanText(body.channel || opportunity.recommended_action, 30);
  if (!['public_reply', 'dm', 'email'].includes(channel)) {
    throw Object.assign(new Error('A draft is only appropriate for public reply, DM, or email.'), { status: 409 });
  }
  const quote = opportunity.evidence_excerpt.replace(/\s+/g, ' ').slice(0, 180);
  const identity = opportunity.person_name || opportunity.company_name || 'there';
  const intro = channel === 'public_reply' ? `${identity} — your point about “${quote}” stood out.` : `Hi ${identity}, I saw your note about “${quote}”.`;
  const message = `${intro}\n\nThat sounds close to the problem ${opportunity.product_name} is trying to solve: ${opportunity.signal}\n\nIf it would be useful, I can share how we approach it. No pressure if the timing or fit is off.`;
  const result = db.prepare(`INSERT INTO drafts (opportunity_id, channel, body, status, created_at, updated_at)
    VALUES (?, ?, ?, 'awaiting_approval', ?, ?)`)
    .run(opportunityId, channel, cleanText(body.body || message, 5000), now(), now());
  return db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(result.lastInsertRowid));
}

function updateLearning(opportunityId) {
  const opportunity = db.prepare(`
    SELECT o.*, r.experiment_id, e.hypothesis,
      (SELECT rating FROM feedback WHERE opportunity_id = o.id ORDER BY created_at DESC, id DESC LIMIT 1) AS rating,
      (SELECT outcome FROM outcomes WHERE opportunity_id = o.id ORDER BY created_at DESC, id DESC LIMIT 1) AS outcome
    FROM opportunities o JOIN research_runs r ON r.id = o.run_id JOIN experiments e ON e.id = r.experiment_id
    WHERE o.id = ?
  `).get(opportunityId);
  if (!opportunity) return;
  const pieces = [];
  if (opportunity.rating) pieces.push(`owner rated this ${opportunity.rating.replaceAll('_', ' ')}`);
  if (opportunity.outcome) pieces.push(`outcome: ${opportunity.outcome.replaceAll('_', ' ')}`);
  if (!pieces.length) return;
  const positive = opportunity.rating === 'great_lead' || ['replied', 'signed_up', 'activated'].includes(opportunity.outcome);
  const negative = ['wrong_icp', 'wrong_signal', 'weak_lead'].includes(opportunity.rating) || opportunity.outcome === 'not_interested';
  const recommendation = positive
    ? `Prioritize similar evidence patterns while checking whether the result repeats.`
    : negative
      ? `Tighten the audience or signal before finding more opportunities like this.`
      : 'Wait for a response before treating this as positive or negative evidence.';
  const statement = `${pieces.join('; ')}. ${recommendation}`;
  const basis = `Opportunity ${opportunity.id}; hypothesis “${opportunity.hypothesis}”; original score ${opportunity.score}; original reasoning preserved: ${opportunity.original_reasoning}`;
  db.prepare('INSERT INTO learnings (product_id, experiment_id, statement, basis, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(opportunity.product_id, opportunity.experiment_id, statement, basis, now());

  const current = latestProfile(opportunity.product_id);
  if (!current) return;
  const evidenceId = Number(db.prepare(`INSERT INTO evidence
    (product_id, source_type, source_url, title, excerpt, captured_at)
    VALUES (?, 'owner_outcome', NULL, ?, ?, ?)`) 
    .run(opportunity.product_id, `Feedback and outcome for opportunity ${opportunity.id}`, `${pieces.join('; ')}.`, now()).lastInsertRowid);
  const nextId = Number(db.prepare('INSERT INTO profile_versions (product_id, version, reason, created_at) VALUES (?, ?, ?, ?)')
    .run(opportunity.product_id, current.version + 1, `Learning updated from opportunity ${opportunity.id}`, now()).lastInsertRowid);
  const insert = db.prepare(`INSERT INTO profile_statements
    (profile_version_id, section, knowledge_state, statement, evidence_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const item of current.statements) {
    insert.run(nextId, item.section, item.knowledge_state, item.statement, item.evidence_id || null, now());
  }
  insert.run(nextId, 'Learnings', 'known', statement, evidenceId, now());
}

async function api(request, response, url) {
  const ownerCount = db.prepare('SELECT COUNT(*) AS count FROM owners').get().count;
  const session = readSession(request);
  const method = request.method || 'GET';
  const path = url.pathname;

  if (method === 'GET' && path === '/api/session') {
    return json(response, 200, {
      authenticated: Boolean(session),
      setupNeeded: ownerCount === 0,
      setupAllowed: ownerCount === 0 && isLoopback(request),
      owner: session ? { email: session.email } : null,
      deploymentLocked: ownerCount === 0 && !isLoopback(request),
    });
  }

  if (method === 'POST' && path === '/api/setup') {
    if (ownerCount > 0) return fail(response, 409, 'Owner setup is already complete.');
    if (!isLoopback(request)) return fail(response, 403, 'First-run owner setup is allowed only from this machine.');
    const body = await readJson(request);
    requireFields(body, ['email', 'password']);
    if (String(body.password).length < 12) return fail(response, 400, 'Use at least 12 characters for the owner password.');
    const ownerId = Number(db.prepare('INSERT INTO owners (email, password_hash, created_at) VALUES (?, ?, ?)')
      .run(cleanText(body.email, 320).toLowerCase(), hashPassword(String(body.password)), now()).lastInsertRowid);
    const created = createSession(ownerId);
    return json(response, 201, { ok: true }, { 'Set-Cookie': sessionCookie(created, secureRequest(request)) });
  }

  if (method === 'POST' && path === '/api/login') {
    const body = await readJson(request);
    const owner = db.prepare('SELECT * FROM owners WHERE email = ?').get(cleanText(body.email, 320).toLowerCase());
    if (!owner || !verifyPassword(String(body.password || ''), owner.password_hash)) {
      return fail(response, 401, 'Email or password is incorrect.');
    }
    const created = createSession(owner.id);
    return json(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie(created, secureRequest(request)) });
  }

  if (method === 'POST' && path === '/api/logout') {
    if (session) db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    return json(response, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(secureRequest(request)) });
  }

  if (!session) return fail(response, 401, 'Sign in is required.');

  if (method === 'GET' && path === '/api/products') {
    return json(response, 200, { products: db.prepare('SELECT * FROM products ORDER BY updated_at DESC').all() });
  }

  if (method === 'POST' && path === '/api/products') {
    const body = await readJson(request);
    requireFields(body, ['name']);
    const createdAt = now();
    const productId = transaction(() => {
      const result = db.prepare(`INSERT INTO products (name, website_url, repository_url, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`) 
        .run(cleanText(body.name, 160), cleanHttpUrl(body.websiteUrl), cleanHttpUrl(body.repositoryUrl), cleanText(body.notes, 10_000) || null, createdAt, createdAt);
      const id = Number(result.lastInsertRowid);
      const insert = db.prepare(`INSERT INTO materials (product_id, kind, label, source_url, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
      if (cleanText(body.readme)) insert.run(id, 'readme', 'README', cleanHttpUrl(body.repositoryUrl), cleanText(body.readme, 100_000), createdAt);
      if (cleanText(body.notes)) insert.run(id, 'owner_notes', 'Owner notes', null, cleanText(body.notes, 10_000), createdAt);
      return id;
    });
    createInitialProfile(productId);
    return json(response, 201, productBundle(productId));
  }

  const productMatch = path.match(/^\/api\/products\/(\d+)$/);
  if (method === 'GET' && productMatch) return json(response, 200, productBundle(idFrom(productMatch[1])));

  const materialMatch = path.match(/^\/api\/products\/(\d+)\/materials$/);
  if (method === 'POST' && materialMatch) {
    const productId = idFrom(materialMatch[1]);
    getProduct(productId);
    const body = await readJson(request);
    requireFields(body, ['kind', 'label']);
    db.prepare(`INSERT INTO materials (product_id, kind, label, source_url, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`) 
      .run(productId, cleanText(body.kind, 40), cleanText(body.label, 180), cleanHttpUrl(body.sourceUrl), cleanText(body.content, 100_000) || null, now());
    db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').run(now(), productId);
    return json(response, 201, productBundle(productId));
  }

  const generateProfileMatch = path.match(/^\/api\/products\/(\d+)\/profile$/);
  if (method === 'POST' && generateProfileMatch) {
    const productId = idFrom(generateProfileMatch[1]);
    createInitialProfile(productId);
    return json(response, 201, productBundle(productId));
  }

  const restoreProfileMatch = path.match(/^\/api\/products\/(\d+)\/profile\/restore\/(\d+)$/);
  if (method === 'POST' && restoreProfileMatch) {
    const productId = idFrom(restoreProfileMatch[1]);
    const versionId = idFrom(restoreProfileMatch[2]);
    const source = db.prepare('SELECT * FROM profile_versions WHERE id = ? AND product_id = ?').get(versionId, productId);
    if (!source) return fail(response, 404, 'Profile version not found.');
    transaction(() => {
      const number = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM profile_versions WHERE product_id = ?').get(productId).next;
      const nextId = Number(db.prepare('INSERT INTO profile_versions (product_id, version, reason, created_at) VALUES (?, ?, ?, ?)')
        .run(productId, number, `Restored from version ${source.version}`, now()).lastInsertRowid);
      const statements = db.prepare('SELECT * FROM profile_statements WHERE profile_version_id = ?').all(source.id);
      const insert = db.prepare(`INSERT INTO profile_statements
        (profile_version_id, section, knowledge_state, statement, evidence_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const item of statements) insert.run(nextId, item.section, item.knowledge_state, item.statement, item.evidence_id || null, now());
    });
    return json(response, 200, productBundle(productId));
  }

  const profileStatementMatch = path.match(/^\/api\/products\/(\d+)\/profile\/statements$/);
  if (method === 'POST' && profileStatementMatch) {
    const productId = idFrom(profileStatementMatch[1]);
    getProduct(productId);
    addProfileStatement(productId, await readJson(request));
    return json(response, 201, productBundle(productId));
  }

  const discussionMatch = path.match(/^\/api\/products\/(\d+)\/discussion$/);
  if (method === 'POST' && discussionMatch) {
    const productId = idFrom(discussionMatch[1]);
    getProduct(productId);
    addCorrection(productId, await readJson(request));
    return json(response, 201, productBundle(productId));
  }

  const experimentProductMatch = path.match(/^\/api\/products\/(\d+)\/experiments$/);
  if (method === 'POST' && experimentProductMatch) {
    const productId = idFrom(experimentProductMatch[1]);
    getProduct(productId);
    const body = await readJson(request);
    requireFields(body, ['name', 'hypothesis', 'audience', 'signal', 'successCriteria']);
    const sourceIds = Array.isArray(body.allowedSourceIds) ? body.allowedSourceIds.filter((id) => typeof id === 'string') : [];
    if (!sourceIds.length) return fail(response, 400, 'Choose at least one permitted source.');
    const known = db.prepare(`SELECT id FROM source_policies WHERE id IN (${sourceIds.map(() => '?').join(',')})`).all(...sourceIds).map((item) => item.id);
    if (known.length !== sourceIds.length) return fail(response, 400, 'One or more selected sources are unknown.');
    db.prepare(`INSERT INTO experiments
      (product_id, name, hypothesis, audience, signal, success_criteria, allowed_source_ids, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
      .run(productId, cleanText(body.name, 200), cleanText(body.hypothesis, 3000), cleanText(body.audience, 1000), cleanText(body.signal, 2000), cleanText(body.successCriteria, 1000), JSON.stringify(sourceIds), now(), now());
    return json(response, 201, productBundle(productId));
  }

  const runMatch = path.match(/^\/api\/experiments\/(\d+)\/runs$/);
  if (method === 'POST' && runMatch) {
    const result = runExperiment(idFrom(runMatch[1]), await readJson(request));
    return json(response, result.asynchronous ? 202 : 201, result);
  }

  const runsMatch = path.match(/^\/api\/experiments\/(\d+)\/runs$/);
  if (method === 'GET' && runsMatch) {
    const experiment = getExperiment(idFrom(runsMatch[1]));
    const runs = db.prepare('SELECT * FROM research_runs WHERE experiment_id = ? ORDER BY started_at DESC').all(experiment.id);
    return json(response, 200, { runs });
  }

  const runDetailMatch = path.match(/^\/api\/runs\/(\d+)$/);
  if (method === 'GET' && runDetailMatch) {
    const runId = idFrom(runDetailMatch[1]);
    const run = db.prepare(`SELECT r.*,
      (SELECT COUNT(*) FROM opportunities WHERE run_id = r.id) AS opportunity_count
      FROM research_runs r WHERE r.id = ?`).get(runId);
    if (!run) return fail(response, 404, 'Research run not found.');
    return json(response, 200, {
      run,
      events: db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at').all(runId),
      sources: db.prepare(`SELECT rs.*, sp.name AS source_name, sp.source_kind FROM run_sources rs
        JOIN source_policies sp ON sp.id = rs.source_id WHERE rs.run_id = ? ORDER BY rs.id`).all(runId),
    });
  }

  const draftMatch = path.match(/^\/api\/opportunities\/(\d+)\/drafts$/);
  if (method === 'POST' && draftMatch) return json(response, 201, draftForOpportunity(idFrom(draftMatch[1]), await readJson(request)));

  const feedbackMatch = path.match(/^\/api\/opportunities\/(\d+)\/feedback$/);
  if (method === 'POST' && feedbackMatch) {
    const opportunityId = idFrom(feedbackMatch[1]);
    const body = await readJson(request);
    const allowed = ['great_lead', 'weak_lead', 'wrong_icp', 'wrong_signal'];
    if (!allowed.includes(body.rating)) return fail(response, 400, 'Choose a supported feedback rating.');
    transaction(() => {
      db.prepare('INSERT INTO feedback (opportunity_id, rating, note, created_at) VALUES (?, ?, ?, ?)')
        .run(opportunityId, body.rating, cleanText(body.note, 2000) || null, now());
      updateLearning(opportunityId);
    });
    return json(response, 201, { ok: true });
  }

  const outcomeMatch = path.match(/^\/api\/opportunities\/(\d+)\/outcomes$/);
  if (method === 'POST' && outcomeMatch) {
    const opportunityId = idFrom(outcomeMatch[1]);
    const body = await readJson(request);
    const allowed = ['contacted', 'replied', 'signed_up', 'activated', 'not_interested'];
    if (!allowed.includes(body.outcome)) return fail(response, 400, 'Choose a supported outcome.');
    transaction(() => {
      db.prepare('INSERT INTO outcomes (opportunity_id, outcome, note, created_at) VALUES (?, ?, ?, ?)')
        .run(opportunityId, body.outcome, cleanText(body.note, 2000) || null, now());
      updateLearning(opportunityId);
    });
    return json(response, 201, { ok: true });
  }

  if (method === 'GET' && path === '/api/sources') {
    return json(response, 200, { sources: sourceSettings() });
  }

  const sourceSettingsMatch = path.match(/^\/api\/sources\/([a-z0-9_-]+)$/);
  if (method === 'PATCH' && sourceSettingsMatch) {
    const sourceId = sourceSettingsMatch[1];
    const source = db.prepare('SELECT * FROM source_policies WHERE id = ?').get(sourceId);
    if (!source) return fail(response, 404, 'Source not found.');
    if (source.source_kind !== 'simulation' || !source.settings_mutable || source.implementation_status !== 'available') {
      return fail(response, 409, 'Only available simulated sources can be changed in this build. Live sources remain deferred.');
    }
    const body = await readJson(request);
    const enabled = body.enabled === true;
    if (source.paid) {
      const approvedMonthlyCents = Number(body.approvedMonthlyCents);
      const approved = body.approved === true;
      if (enabled && (!approved || !Number.isInteger(approvedMonthlyCents) || approvedMonthlyCents <= 0)) {
        return fail(response, 400, 'Approve a positive simulated monthly limit before enabling this paid simulation.');
      }
      db.prepare(`UPDATE provider_budgets SET approved_monthly_cents = ?, enabled = ?, updated_at = ? WHERE provider_id = ?`)
        .run(Number.isInteger(approvedMonthlyCents) && approvedMonthlyCents > 0 ? approvedMonthlyCents : null, enabled && approved ? 1 : 0, now(), sourceId);
    }
    db.prepare('UPDATE source_policies SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now(), sourceId);
    return json(response, 200, { sources: sourceSettings() });
  }

  if (method === 'GET' && path === '/api/profile-versions') {
    const productId = idFrom(url.searchParams.get('productId'));
    return json(response, 200, { versions: db.prepare('SELECT * FROM profile_versions WHERE product_id = ? ORDER BY version DESC').all(productId) });
  }

  return fail(response, 404, 'Route not found.');
}

function serveStatic(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = normalize(join(PUBLIC_DIR, requested));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${sep}`)) return fail(response, 403, 'Not allowed.');
  try {
    const content = readFileSync(filePath);
    response.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    response.end(content);
  } catch {
    if (!extname(pathname)) {
      const content = readFileSync(join(PUBLIC_DIR, 'index.html'));
      response.writeHead(200, { 'Content-Type': MIME['.html'] });
      response.end(content);
    } else {
      fail(response, 404, 'File not found.');
    }
  }
}

export const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await api(request, response, url);
    else serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    fail(response, error.status || 500, error.status ? error.message : 'Something went wrong.');
  }
});

export function startServer({ host = HOST, port = PORT } = {}) {
  return new Promise((resolveStart, rejectStart) => {
    const handleError = (error) => rejectStart(error);
    server.once('error', handleError);
    server.listen(port, host, () => {
      server.off('error', handleError);
      const ownerCount = db.prepare('SELECT COUNT(*) AS count FROM owners').get().count;
      if (host !== '127.0.0.1' && host !== 'localhost' && ownerCount === 0) {
        console.error('DEPLOYMENT LOCKED: create the owner locally before binding this app to a public interface.');
      }
      console.log(`GTM Agent is listening on http://${host}:${port}`);
      resolveStart(server);
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
