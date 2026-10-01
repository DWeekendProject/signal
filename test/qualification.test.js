import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCandidateMetrics, qualifyCandidate, qualifyEvidence } from '../src/qualification.js';
import { manualPublicSource } from '../src/sources/manual-public.js';

const experiment = {
  audience: 'AI-assisted builders stuck moving from prototype to production',
  signal: 'A recent public statement describing production or maintenance trouble',
};

test('specific current intent qualifies above demographic fit', () => {
  const result = qualifyCandidate({
    signalSpecificity: 5,
    recency: 3,
    productFitScore: 5,
    evidenceQuality: 4,
    sourceReliability: 3,
    recommendedAction: 'public_reply',
  }, experiment);

  assert.equal(result.accepted, true);
  assert.equal(result.intentStrength, 'high');
  assert.equal(result.recommendedAction, 'public_reply');
  assert.ok(result.score >= 42);
});

test('demographic-only candidates are rejected even when fit scores are high', () => {
  const result = qualifyCandidate({
    demographicOnly: true,
    signalSpecificity: 5,
    recency: 3,
    productFitScore: 5,
    evidenceQuality: 4,
    sourceReliability: 3,
  }, experiment);

  assert.equal(result.accepted, false);
  assert.match(result.reason, /demographic fit/i);
});

test('low-intent evidence cannot recommend intrusive outreach', () => {
  const result = qualifyCandidate({
    signalSpecificity: 2,
    recency: 0,
    productFitScore: 2,
    evidenceQuality: 1,
    sourceReliability: 1,
    recommendedAction: 'email',
  }, experiment);

  assert.equal(result.accepted, true);
  assert.equal(result.intentStrength, 'low');
  assert.equal(result.recommendedAction, 'watch');
});

test('manual public source requires a link, identity, signal, and useful excerpt', () => {
  const errors = manualPublicSource.validate({
    sourceUrl: 'not-a-url',
    evidenceExcerpt: 'too short',
    signal: 'vague',
  });

  assert.equal(errors.length, 4);
});

test('owner-supplied evidence is qualified without owner-entered numeric scores', () => {
  const candidate = {
    personName: 'Public Author',
    sourceUrl: 'https://example.com/problem',
    evidenceExcerpt: 'I am blocked right now because this production workflow keeps failing, and I am actively looking for a durable fix.',
    signal: 'The author is currently blocked moving a production workflow forward.',
  };
  const metrics = deriveCandidateMetrics(candidate, experiment, { id: 'manual_public', source_kind: 'owner_input' });
  const result = qualifyEvidence(candidate, experiment, { id: 'manual_public', source_kind: 'owner_input' });

  assert.equal(result.accepted, true);
  assert.ok(metrics.signalSpecificity > 0);
  assert.ok(metrics.evidenceQuality > 0);
  assert.match(result.originalReasoning, /owner/i);
});

test('an explicitly solved problem is rejected as a hard disqualifier', () => {
  const result = qualifyEvidence({
    personName: 'Past User',
    sourceUrl: 'https://example.com/resolved',
    evidenceExcerpt: 'We were stuck in production last year, but it is fully solved now and we are not looking to change anything.',
    signal: 'Historical production problem.',
  }, experiment, { id: 'manual_public', source_kind: 'owner_input' });

  assert.equal(result.accepted, false);
  assert.match(result.reason, /disqualifier/i);
});
