(() => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'VERIFY_GOOGLE_FACILITY') return;
    const universityName = String(message.universityName || '').toLowerCase();
    const facilityTerms = String(message.facilityQuery || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const sources = [...document.querySelectorAll('a[href]')]
      .map((link) => ({ heading: (link.innerText || '').replace(/\s+/g, ' ').trim(), url: unwrapGoogleUrl(link.href) }))
      .filter((link) => link.heading && /^https?:\/\//i.test(link.url) && !/google\./i.test(new URL(link.url).hostname))
      .slice(0, 20);
    const bodyText = document.body?.innerText?.toLowerCase() || '';
    const resultStart = bodyText.search(/web results|search results|ai overview/);
    const resultText = `${resultStart >= 0 ? bodyText.slice(resultStart) : ''} ${sources.map((source) => source.heading).join(' ')}`;
    const facilityMentioned = facilityTerms.some((term) => resultText.includes(term));
    const universityMentioned = universityName.split(/[^a-z0-9]+/).filter((term) => term.length > 2).every((term) => resultText.includes(term));
    sendResponse({ available: facilityMentioned && universityMentioned, sources });
  });

  function unwrapGoogleUrl(value) {
    try {
      const url = new URL(value);
      if (!/google\./i.test(url.hostname)) return value;
      return url.searchParams.get('q') || url.searchParams.get('url') || value;
    } catch {
      return value;
    }
  }
})();
