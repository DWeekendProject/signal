export const manualPublicSource = {
  id: 'manual_public',
  validate(candidate) {
    const errors = [];
    try {
      const url = new URL(candidate.sourceUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol.');
    } catch {
      errors.push('A valid public http(s) source URL is required.');
    }
    if (!candidate.evidenceExcerpt || candidate.evidenceExcerpt.trim().length < 20) errors.push('A meaningful evidence excerpt is required.');
    if (!candidate.signal || candidate.signal.trim().length < 12) errors.push('Describe the observable problem signal.');
    if (!candidate.personName && !candidate.companyName) errors.push('Name the person or company visible in the source.');
    return errors;
  },
  normalize(candidate) {
    return {
      ...candidate,
      personName: String(candidate.personName || '').trim().slice(0, 240),
      companyName: String(candidate.companyName || '').trim().slice(0, 240),
      sourceUrl: String(candidate.sourceUrl || '').trim().slice(0, 2000),
      evidenceExcerpt: String(candidate.evidenceExcerpt || '').trim().slice(0, 4000),
      signal: String(candidate.signal || '').trim().slice(0, 2000),
      sourceTitle: String(candidate.sourceTitle || 'Public source').trim().slice(0, 300),
      whySignalMatters: String(candidate.whySignalMatters || '').trim().slice(0, 2000),
      productFit: String(candidate.productFit || '').trim().slice(0, 2000),
      actionReason: String(candidate.actionReason || '').trim().slice(0, 2000),
    };
  },
};
