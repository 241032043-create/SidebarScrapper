(() => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'SCRAPE_GOOGLE_IMAGES') return;
    setTimeout(async () => sendResponse({ images: await extractImages() }), 1200);
    return true;
  });

  async function extractImages() {
    const results = [];
    const seen = new Set();
    const embeddedUrls = getEmbeddedImageUrls();
    const queryTerms = getQueryTerms();
    const locationTerms = getLocationTerms();
    let embeddedIndex = 0;
    const images = [...document.querySelectorAll('img[alt]')];
    for (const image of images) {
      const heading = (image.alt || image.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (!heading || /^(google|search by image)$/i.test(heading)) continue;
      const resultLink = findResultLink(image);
      const imageUrl = getOriginalImageUrl(resultLink) || getDirectImageUrl(image) || embeddedUrls[embeddedIndex++];
      if (!/^https?:\/\//i.test(imageUrl) || seen.has(imageUrl)) continue;
      const source = getSourceUrl(resultLink, image);
      if (!matchesRequestedLocation(`${heading} ${imageUrl} ${source}`, locationTerms)) continue;
      seen.add(imageUrl);
      const dimensions = getDimensions(resultLink);
      results.push({ heading, image: imageUrl, source, relevance: getRelevanceScore(heading, imageUrl, source, queryTerms), ...dimensions });
    }
    const candidatesToMeasure = results
      .sort((first, second) => second.relevance - first.relevance || second.area - first.area)
      .slice(0, 15);
    const measuredResults = await Promise.all(candidatesToMeasure.map(async (result) => {
      if (result.width && result.height) return result;
      const measured = await measureImage(result.image);
      return { ...result, ...measured, area: measured.width * measured.height };
    }));
    return measuredResults.sort((first, second) => second.relevance - first.relevance || second.area - first.area).slice(0, 50).map(({ area, relevance, ...result }) => result);
  }

  function getOriginalImageUrl(resultLink) {
    if (!resultLink?.href) return '';
    try {
      return new URL(resultLink.href).searchParams.get('imgurl') || '';
    } catch {
      return '';
    }
  }

  function getSourceUrl(resultLink, image) {
    if (resultLink?.href) {
      try {
        const source = new URL(resultLink.href).searchParams.get('imgrefurl') || '';
        if (source) return source;
      } catch {
        // Fall through to the card metadata fallback.
      }
    }
    let element = image;
    for (let depth = 0; element && depth < 12; depth += 1, element = element.parentElement) {
      const source = element.getAttribute?.('data-lpage');
      if (/^https?:\/\//i.test(source || '')) return source;
    }
    return '';
  }

  function getQueryTerms() {
    const query = new URLSearchParams(location.search).get('q') || document.title;
    return query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2 && !['the', 'and', 'for', 'with'].includes(term));
  }

  function getLocationTerms() {
    const query = new URLSearchParams(location.search).get('q') || '';
    const universityMatch = query.match(/"([^"]+)"/);
    if (!universityMatch) return [];
    return universityMatch[1].toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2 && !['the', 'and', 'for', 'university', 'college'].includes(term));
  }

  function matchesRequestedLocation(text, locationTerms) {
    if (!locationTerms.length) return true;
    const normalized = text.toLowerCase();
    if (!locationTerms.some((term) => normalized.includes(term))) return false;
    const otherCampusTerms = ['gurugram', 'gurgaon', 'lucknow', 'kolkata', 'jaipur', 'hyderabad', 'raipur', 'mumbai', 'bengaluru', 'bangalore', 'punjab'];
    return !otherCampusTerms.some((term) => !locationTerms.includes(term) && normalized.includes(term));
  }

  function getRelevanceScore(heading, imageUrl, source, queryTerms) {
    const text = `${heading} ${imageUrl} ${source}`.toLowerCase();
    return queryTerms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
  }

  function findResultLink(image) {
    let element = image;
    for (let depth = 0; element && depth < 8; depth += 1, element = element.parentElement) {
      if (element.matches?.('a[href*="/imgres"]')) return element;
      const nestedLink = element.querySelector?.('a[href*="/imgres"]');
      if (nestedLink) return nestedLink;
    }
    return null;
  }

  function getDirectImageUrl(image) {
    const candidates = [image.getAttribute('data-iurl'), image.getAttribute('data-src')];
    return candidates.find((url) => /^https?:\/\//i.test(url || '') && !/encrypted-tbn|gstatic\.com\/images/i.test(url)) || '';
  }

  function getEmbeddedImageUrls() {
    const html = document.documentElement.innerHTML;
    const matches = html.match(/https?:[^"'\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>]*)?/gi) || [];
    return [...new Set(matches.map((url) => decodeHtmlEntities(url).replace(/\\u003d/g, '=').replace(/\\u0026/g, '&')).filter((url) => !/encrypted-tbn|gstatic\.com|google\.com/i.test(url)))];
  }

  function decodeHtmlEntities(value) {
    return value.replace(/&amp;/g, '&').replace(/\\u002F/g, '/');
  }

  function measureImage(url) {
    return new Promise((resolve) => {
      const image = new Image();
      const finish = () => resolve({ width: image.naturalWidth || 0, height: image.naturalHeight || 0 });
      image.onload = finish;
      image.onerror = finish;
      setTimeout(finish, 4000);
      image.src = url;
    });
  }

  function getDimensions(resultLink) {
    if (!resultLink?.href) return { width: 0, height: 0, area: 0 };
    try {
      const params = new URL(resultLink.href).searchParams;
      const width = Number(params.get('w')) || 0;
      const height = Number(params.get('h')) || 0;
      return { width, height, area: width * height };
    } catch {
      return { width: 0, height: 0, area: 0 };
    }
  }
})();
