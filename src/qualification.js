const ACTIONS = new Set(['public_reply', 'dm', 'email', 'watch', 'no_action']);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function words(value) {
  const ignored = new Set(['about', 'after', 'again', 'being', 'could', 'from', 'have', 'people', 'their', 'there', 'these', 'they', 'this', 'those', 'when', 'where', 'which', 'with', 'would']);
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9]{4,}/g)?.filter((word) => !ignored.has(word)) || []);
}

function overlapCount(left, right) {
  const rightWords = words(right);
  return [...words(left)].filter((word) => rightWords.has(word)).length;
}

function recentScore(capturedAt, text) {
  const age = capturedAt ? Date.now() - new Date(capturedAt).getTime() : Number.POSITIVE_INFINITY;
  if (/\b(right now|this week|today|currently|actively|this month|need to decide)\b/i.test(text)) return 3;
  if (Number.isFinite(age) && age <= 14 * 86_400_000) return 3;
  if (Number.isFinite(age) && age <= 60 * 86_400_000) return 2;
  return 1;
}

export function deriveCandidateMetrics(candidate, experiment, source = {}) {
  const evidence = String(candidate.evidenceExcerpt || '');
  const combined = `${evidence} ${candidate.signal || ''}`;
  const experimentContext = `${experiment.signal || ''} ${experiment.audience || ''}`;
  const overlap = overlapCount(combined, experimentContext);
  const hasCurrentProblem = /\b(blocked|blocker|broken|failing|stuck|struggling|problem|issue|cannot|can't|keeps|costing|need|looking|comparing|replace|solve)\b/i.test(combined);
  const hasFirstPersonContext = /\b(i|we|our|my|team)\b/i.test(evidence);
  const explicitlyResolved = /\b(fully solved|already solved|not looking|no longer need|fixed now)\b/i.test(combined);
  const specificity = candidate.demographicOnly ? 0 : clamp(2 + (hasCurrentProblem ? 1 : 0) + (hasFirstPersonContext ? 1 : 0) + (overlap >= 2 ? 1 : 0), 0, 5);
  const recency = recentScore(candidate.capturedAt, combined);
  const productFit = clamp(2 + Math.min(overlap, 3), 0, 5);
  const evidenceQuality = clamp(1 + (evidence.length >= 80 ? 1 : 0) + (hasFirstPersonContext ? 1 : 0) + (candidate.sourceUrl ? 1 : 0), 0, 4);
  const sourceReliability = source.source_kind === 'simulation' ? 3 : source.id === 'manual_public' ? 2 : 1;

  return {
    ...candidate,
    demographicOnly: candidate.demographicOnly === true || !hasCurrentProblem,
    signalSpecificity: specificity,
    recency,
    productFitScore: productFit,
    evidenceQuality,
    sourceReliability,
    disqualifiers: candidate.disqualifiers || (explicitlyResolved ? 'The evidence says the problem is already solved or no change is wanted.' : ''),
    disqualifierSeverity: candidate.disqualifierSeverity || (explicitlyResolved ? 'hard' : undefined),
    recommendedAction: candidate.recommendedAction || (hasCurrentProblem && recency === 3 ? 'public_reply' : 'watch'),
    whySignalMatters: candidate.whySignalMatters || `The evidence describes “${experiment.signal}” as a present problem rather than relying only on demographic fit.`,
    productFit: candidate.productFit || (overlap
      ? `The evidence shares specific problem language with the selected audience and signal for ${experiment.audience}.`
      : `The current problem appears adjacent to ${experiment.audience}, but fit needs owner review.`),
    derivationNotes: {
      specificity: hasCurrentProblem && hasFirstPersonContext ? 'A specific problem is described in first-person context.' : 'The problem description has limited first-person detail.',
      recency: recency === 3 ? 'The excerpt or capture date indicates current need.' : 'The timing is less certain.',
      fit: overlap ? 'The evidence overlaps with the selected hypothesis and signal.' : 'Fit is inferred with little shared problem language.',
      evidence: evidenceQuality >= 3 ? 'The stored excerpt is substantial and tied to a source.' : 'The evidence is brief or missing useful source context.',
      source: source.source_kind === 'simulation' ? 'This is controlled fictional evidence for testing only.' : 'This excerpt was deliberately supplied by the owner from a public source.',
    },
  };
}

export function qualifyCandidate(candidate, experiment) {
  const specificity = clamp(candidate.signalSpecificity, 0, 5);
  const recency = clamp(candidate.recency, 0, 3);
  const productFit = clamp(candidate.productFitScore, 0, 5);
  const evidenceQuality = clamp(candidate.evidenceQuality, 0, 4);
  const sourceReliability = clamp(candidate.sourceReliability, 0, 3);
  const disqualifiers = String(candidate.disqualifiers || '').trim();
  const demographicOnly = candidate.demographicOnly === true;

  if (demographicOnly || specificity < 2) {
    return { accepted: false, reason: 'Rejected: demographic fit without a specific current problem signal.' };
  }
  if (disqualifiers && candidate.disqualifierSeverity === 'hard') {
    return { accepted: false, reason: `Rejected by disqualifier: ${disqualifiers}` };
  }

  const penalty = disqualifiers ? 3 : 0;
  const score = Math.max(0, specificity * 4 + recency * 3 + productFit * 3 + evidenceQuality * 2 + sourceReliability - penalty);
  const intentStrength = score >= 42 ? 'high' : score >= 28 ? 'medium' : 'low';
  const confidence = Math.round(clamp((evidenceQuality * 16) + (sourceReliability * 8) + (specificity * 3), 20, 95));
  const requestedAction = ACTIONS.has(candidate.recommendedAction) ? candidate.recommendedAction : 'watch';
  const recommendedAction = intentStrength === 'low' && !['watch', 'no_action'].includes(requestedAction) ? 'watch' : requestedAction;

  const notes = candidate.derivationNotes;
  const originalReasoning = notes
    ? [notes.specificity, notes.recency, notes.fit, notes.evidence, notes.source, disqualifiers ? `Concern: ${disqualifiers}` : 'No explicit disqualifier was found.'].join(' ')
    : [
      `Signal specificity ${specificity}/5`,
      `recency ${recency}/3`,
      `product fit ${productFit}/5`,
      `evidence quality ${evidenceQuality}/4`,
      `source reliability ${sourceReliability}/3`,
      disqualifiers ? `concern: ${disqualifiers}` : 'no stated disqualifier',
    ].join('; ');

  return {
    accepted: true,
    score,
    confidence,
    intentStrength,
    recommendedAction,
    whySignalMatters: candidate.whySignalMatters || `This is direct evidence of the problem in the experiment: ${experiment.signal}`,
    productFit: candidate.productFit || `Potential fit with ${experiment.audience}.`,
    intentReason: `${intentStrength[0].toUpperCase()}${intentStrength.slice(1)} intent based on signal specificity, recency, fit, and evidence quality.`,
    actionReason: candidate.actionReason || actionReason(recommendedAction, intentStrength),
    originalReasoning,
  };
}

export function qualifyEvidence(candidate, experiment, source) {
  return qualifyCandidate(deriveCandidateMetrics(candidate, experiment, source), experiment);
}

function actionReason(action, strength) {
  const reasons = {
    public_reply: 'The problem was discussed publicly, so a useful public response is the least intrusive next step.',
    dm: 'A private response may be appropriate, but it still requires owner review and approval.',
    email: 'Email may be appropriate when a legitimate business address is already available; do not discover one automatically.',
    watch: `The evidence is ${strength} confidence, so gather more context before contacting.`,
    no_action: 'The evidence does not justify contact.',
  };
  return reasons[action];
}
