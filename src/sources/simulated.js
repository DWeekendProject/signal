const AUTHORS = [
  ['Maya Chen', 'Northstar Studio'],
  ['Arjun Mehta', 'Draftwise Labs'],
  ['Lena Ortiz', 'Weeklight'],
  ['Sam Rivera', 'Patchwork Works'],
  ['Noah Williams', 'Independent builder'],
  ['Iris Park', 'Tidepool Tools'],
  ['Jon Bell', 'Tiny Signal Co.'],
  ['Priya Nair', 'Morrow Systems'],
  ['Eli Brooks', 'Fieldnote'],
  ['Fatima Khan', 'Lantern Product'],
  ['Theo Martin', 'Sidepath'],
  ['Nina Singh', 'Plainspoken Labs'],
];

const CONTEXTS = [
  'We shipped the first version, but this has become the blocker keeping us from inviting the next users.',
  'I have tried two workarounds this week and neither survives the real workflow.',
  'This was manageable during the prototype, but it is now stopping the team from moving forward.',
  'I am looking for a practical fix now because the current setup keeps failing at the same point.',
  'The basic flow works, yet this problem appears every time we try to use it for real.',
  'We have budgeted time this month to solve it instead of adding another temporary workaround.',
  'I thought we had solved this, but the same issue came back as soon as usage increased.',
  'This is the third time I have had to rebuild the process, and I need a more durable approach.',
  'People are ready to use the product, but I cannot confidently move them through this step.',
  'I am comparing options now because the manual approach is costing us a full day each week.',
  'The team can reproduce the problem and we are actively looking for something simpler.',
  'I need to decide this week whether to keep patching the current approach or replace it.',
];

function daysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function candidateFor(experiment, sourceId, index) {
  const [personName, companyName] = AUTHORS[index];
  const exactProblem = String(experiment.signal).replace(/[.!?]+$/, '');
  return {
    personName,
    companyName,
    sourceTitle: `Simulated public discussion ${index + 1}`,
    sourceUrl: `https://${sourceId}.simulation.invalid/posts/${experiment.id}-${index + 1}`,
    evidenceExcerpt: `${CONTEXTS[index]} Specifically: ${exactProblem}. I would value advice from someone who has solved this without adding more complexity.`,
    signal: `${personName} describes the experiment’s target problem as a current blocker and is actively looking for a solution.`,
    capturedAt: daysAgo(index % 8),
    personalizationContext: `${personName} publicly described the blocker in the context of ${experiment.audience}. The safest opening is to respond to that exact problem, not their job title or company size.`,
    recommendedAction: 'public_reply',
  };
}

export const simulatedSource = {
  supports(source) {
    return source.source_kind === 'simulation' && source.implementation_status === 'available';
  },

  discover(experiment, source) {
    const size = source.simulation_behavior === 'failure' ? 4 : source.simulation_behavior === 'paid' ? 6 : 12;
    const candidates = Array.from({ length: size }, (_, index) => candidateFor(experiment, source.id, index));
    if (size >= 12) {
      candidates[10] = {
        ...candidates[10],
        evidenceExcerpt: `I lead a small company in the right category and enjoy reading about ${experiment.audience}.`,
        signal: 'Broad demographic and topical fit without a present problem.',
        demographicOnly: true,
      };
      candidates[11] = {
        ...candidates[11],
        evidenceExcerpt: `We had the problem last year, but it is fully solved now and we are not looking to change anything. ${experiment.signal}`,
        signal: 'The historical problem matches, but the person explicitly says it is solved.',
        disqualifiers: 'The person says the problem is already solved and they are not looking to change.',
        disqualifierSeverity: 'hard',
        recommendedAction: 'no_action',
      };
    }
    return candidates;
  },
};
