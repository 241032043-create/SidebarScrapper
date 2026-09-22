(() => {
  const api = globalThis.__universityScraperCourse = globalThis.__universityScraperCourse || {};

  if (!globalThis.chrome?.runtime?.onMessage) return;
  api.listenerReady = true;
  api.debug = { messageCount: 0, lastCollection: null };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    api.debug.messageCount += 1;
    console.debug('[University Scraper][course-content] message received', message.type, location.href);
    if (message.type === 'START_CARD_SELECTION') {
      api.beginSelection();
      sendResponse?.({ ok: true });
      return;
    }
    if (message.type === 'SCRAPE_ALL_CARDS') {
      const collection = api.findAllCourseCards(Boolean(message.includeStreams));
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Course card collection timed out after 25 seconds.')), 25000));
      Promise.race([collection, timeout])
        .then((cards) => {
          console.debug('[University Scraper][course-content] collection complete', { count: cards.length, collectionComplete: api.lastCollectionComplete !== false });
          sendResponse?.({ cards, complete: api.lastCollectionComplete !== false });
        })
        .catch((error) => {
          console.error('[University Scraper][course-content] collection failed', error);
          sendResponse?.({ cards: [], error: error.message || 'Course cards could not be read.' });
        });
      return true;
    }
    if (message.type === 'SELECT_COURSE_CARD') {
      api.selectCourseCard(message.index)
        .then(() => sendResponse?.({ ok: true }))
        .catch((error) => sendResponse?.({ ok: false, message: error.message }));
      return true;
    }
    return false;
  });

  let selecting = false;
  let hoveredCard = null;
  let selectedCard = null;
  let discoveredCourseCards = null;

  api.beginSelection = function beginSelection() {
    selecting = true;
    hoveredCard = null;
    removeSelectionListeners();
    document.addEventListener('pointerover', handlePointerOver, true);
    document.addEventListener('click', handleCardClick, true);
    chrome.runtime.sendMessage({ type: 'SELECTION_STARTED' });
  };

  api.findAllCourseCards = async function findAllCourseCards(includeStreams = false) {
    console.debug('[University Scraper][course-content] starting collection', { url: location.href, path: location.pathname, includeStreams });
    reportCollection('collector started');
    const cards = await findAllCourseCardElements(includeStreams);
    const section = document.querySelector('#course-card-section') || document.body;
    const paginationIncomplete = [...section.querySelectorAll('a, button, [role="button"]')].some((element) =>
      isVisibleCard(element) && !element.disabled && /^(?:next|next page|›|>)$/i.test(normalize(element.innerText || element.textContent || ''))
    );
    api.lastCollectionComplete = !paginationIncomplete;
    api.debug.lastCollection = { count: cards.length, collectionComplete: api.lastCollectionComplete };
    return cards.map(({ data }) => data);
  };

  api.selectCourseCard = async function selectCourseCard(index) {
    const cards = await findAllCourseCardElements(false);
    const selected = cards[index]?.element;
    if (!selected) throw new Error('The selected course card was not found on the page.');
    await scrapeSelectedCard(selected);
  };

  function handlePointerOver(event) {
    if (!selecting) return;
    const card = findCourseCard(event.target);
    if (card === hoveredCard) return;
    hoveredCard?.classList.remove('university-scraper-hover');
    hoveredCard = card;
    hoveredCard?.classList.add('university-scraper-hover');
  }

  function handleCardClick(event) {
    if (!selecting) return;
    const card = findCourseCard(event.target);
    if (!card) return;
    event.preventDefault();
    event.stopPropagation();
    selecting = false;
    removeSelectionListeners();
    selectedCard?.classList.remove('university-scraper-selected');
    selectedCard = card;
    selectedCard.classList.remove('university-scraper-hover');
    selectedCard.classList.add('university-scraper-selected');
    scrapeSelectedCard(card).catch((error) => {
      chrome.runtime.sendMessage({ type: 'SCRAPE_ERROR', message: `Scrape failed: ${error.message}` });
    });
  }

  function removeSelectionListeners() {
    document.removeEventListener('pointerover', handlePointerOver, true);
    document.removeEventListener('click', handleCardClick, true);
    hoveredCard?.classList.remove('university-scraper-hover');
    hoveredCard = null;
  }

  function findCourseCard(startElement) {
    let current = startElement instanceof Element ? startElement : startElement?.parentElement;
    let best = null;
    let bestScore = -Infinity;
    for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
      const text = normalize(current.innerText || '');
      const rect = current.getBoundingClientRect();
      if (rect.width < 250 || rect.height < 100 || rect.height > 900 || text.length < 60) continue;
      const score = cardScore(current, text);
      if (score > bestScore) { best = current; bestScore = score; }
    }
    return bestScore >= 3 ? best : null;
  }

  function cardScore(element, text) {
    let score = 0;
    if (/\bCourses\b/i.test(text)) score += 4;
    if (/Total Fees|Application Date|Offered at|Views/i.test(text)) score += 2;
    if (/\b(B\.Tech|B\.Sc|MBA|M\.Tech|MBBS|BCA|BBA)\b/i.test(text)) score += 2;
    if (element.matches('[class*="card"], [class*="Card"], article')) score += 1;
    return score;
  }

  async function scrapeSelectedCard(card) {
    chrome.runtime.sendMessage({ type: 'SCRAPE_STARTED' });
    const data = { title: extractTitle(card), summary: extractSummary(card), parentUrl: findParentCourseUrl(card), courses: [] };
    await expandCourseCard(card);
    data.courses = extractCourses(card);
    chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', data });
  }

  function findCoursesControl(card) {
    return [...card.querySelectorAll('.course-info, button, a, [role="button"], div, span')]
      .find((element) => /^Courses(?:\s|$)/i.test(normalize(element.innerText || element.textContent || '')));
  }

  function getCourseCount(card) {
    const control = findCoursesControl(card);
    const text = normalize(control?.innerText || card.innerText || '');
    const count = text.match(/&\s*(\d+)\s+more\b/i)?.[1];
    return count ? Number(count) + 1 : 0;
  }

  function findParentCourseUrl(card) {
    return card.querySelector('a[href*="/courses"]')?.href || card.querySelector('a[href]')?.href || location.href;
  }

  async function findAllCourseCardElements(includeStreams = false) {
    if (!includeStreams && discoveredCourseCards?.length) return discoveredCourseCards;
    reportCollection('waiting for initial course cards');
    await waitForCourseCards();
    reportCollection('initial course cards found');
    const initialCandidates = [...document.querySelectorAll('.course-card, [class*="course-card"]')];
    console.debug('[University Scraper][course-content] candidates before reveal', { count: initialCandidates.length, visible: initialCandidates.filter(isVisibleCard).length });
    const revealResult = await revealAllParentCourses();
    reportCollection(`reveal settled at ${revealResult.count} cards`);
    await wait(250);
    const section = document.querySelector('#course-card-section') || document.body;
    const cards = [...section.querySelectorAll('.course-card, [class*="course-card"]')].filter(isVisibleCard);
    console.debug('[University Scraper][course-content] candidates after reveal/filter', { beforeReveal: initialCandidates.length, afterReveal: revealResult.count, visible: cards.length });
    chrome.runtime.sendMessage({ type: 'COURSE_CARDS_PROGRESS', message: `Found ${cards.length} course-card elements. Preparing the picker...` });
    const unique = new Map();
    for (let start = 0; start < cards.length; start += 4) {
      const batch = cards.slice(start, start + 4);
      if (includeStreams) {
        chrome.runtime.sendMessage({ type: 'COURSE_CARDS_PROGRESS', message: `Expanding course cards ${start + 1}-${Math.min(start + 4, cards.length)} of ${cards.length}...` });
      }
      await Promise.all(batch.map(async (card) => {
        const title = extractTitle(card);
        const summary = extractSummary(card);
        const parentUrl = findParentCourseUrl(card);
        let streamCount = getCourseCount(card);
        if (!isParentCourseCard(title, summary, parentUrl, normalize(card.innerText), section)) return;
        const key = normalizeCourseKey(title, parentUrl);
        if (unique.has(key)) return;
        if (includeStreams) {
          await expandCourseCard(card);
          streamCount = extractCourses(card).length || streamCount;
        }
        const courses = includeStreams ? extractCourses(card) : [];
        unique.set(key, { element: card, data: { title, parentUrl, summary, streamCount: courses.length || streamCount, courses } });
      }));
    }
    if (!unique.size) {
      for (const card of cards) {
        const title = extractTitle(card);
        const parentUrl = findParentCourseUrl(card);
        if (!title || !parentUrl) continue;
        const key = normalizeCourseKey(title, parentUrl);
        if (unique.has(key)) continue;
        unique.set(key, { element: card, data: { title, parentUrl, summary: extractSummary(card), streamCount: getCourseCount(card), courses: [] } });
      }
    }
    const discovered = [...unique.values()];
    reportCollection(`parent filtering settled at ${discovered.length} courses`);
    console.debug('[University Scraper][course-content] parent courses discovered', { visibleCards: cards.length, parentCourses: discovered.length });
    if (!includeStreams) discoveredCourseCards = discovered;
    return discovered;
  }

  async function expandCourseCard(card) {
    const control = findCoursesControl(card);
    let streams = extractCourses(card);
    if (streams.length || !control || isExpanded(control, card)) return;
    const before = cardSignature(card);
    control.click();
    await waitForExpandedCourses(card, before);
    streams = extractCourses(card);
    if (streams.length) await revealScrollableContent(card);
  }

  async function revealAllParentCourses() {
    const section = document.querySelector('#course-card-section') || document.body;
    const beforeCount = section.querySelectorAll('.course-card, [class*="course-card"]').length;
    reportCollection(`reveal started at ${beforeCount} cards`);
    let stableRounds = 0;
    while (stableRounds < 3) {
      const before = cardSignature(section);
      const button = [...section.querySelectorAll('button, a, [role="button"]')]
        .find((element) => isVisibleCard(element) && !element.disabled && element.getAttribute('aria-hidden') !== 'true'
          && /^(?:view\s+more|load\s+more|view\s+all)(?:\s+(?:courses?|programmes?|degrees?))?$/i.test(normalize(element.innerText || element.textContent || '')));
      if (button) button.click();
      else {
        const scrollable = section.scrollHeight > section.clientHeight + 20 ? section : document.scrollingElement;
        if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
      }
      const changed = await waitForCardChange(section, before, button ? 5000 : 1000);
      console.debug('[University Scraper][course-content] reveal round', { stableRounds, count: section.querySelectorAll('.course-card, [class*="course-card"]').length, button: Boolean(button) });
      if (!button && !changed) break;
      stableRounds = cardSignature(section) === before ? stableRounds + 1 : 0;
    }
    const count = section.querySelectorAll('.course-card, [class*="course-card"]').length;
    console.debug('[University Scraper][course-content] reveal settled', { before: beforeCount, after: count, stableRounds });
    return { count };
  }

  function isVisibleCard(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function cardSignature(section) {
    return [...section.querySelectorAll('.course-card, [class*="course-card"]')]
      .filter(isVisibleCard)
      .map((card) => `${extractTitle(card)}|${findParentCourseUrl(card)}`)
      .sort().join('||');
  }

  async function waitForCardChange(section, before, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (cardSignature(section) !== before) return true;
      await wait(150);
    }
    return false;
  }

  async function waitForCourseCards() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (document.querySelector('.course-card, [class*="course-card"]')) return;
      await wait(300);
    }
    throw new Error('Course cards did not load on the Courses & Fees page.');
  }

  function reportCollection(message) {
    chrome.runtime.sendMessage({ type: 'COURSE_CARDS_PROGRESS', message: `[course-content] ${message}` }).catch(() => {});
  }

  function isParentCourseCard(title, summary, parentUrl, text) {
    if (!title || !parentUrl || /view more|select goal|table of contents/i.test(text)) return false;
    if (/select goal|table of contents|popular courses|other courses|application fees|faqs?|courses?\s*&?\s*fees?\s*20\d{2}/i.test(title)) return false;
    if (/select goal|table of contents|popular courses|other courses|application fees|faqs?/i.test(text)) return false;
    return Boolean(summary.fees || summary.duration || summary.applicationDate || /\b(open|closed|ongoing)\b/i.test(text));
  }

  function parentCardMetadataScore(summary) {
    return [summary.fees, summary.duration, summary.applicationDate, summary.mode].filter(Boolean).length;
  }

  function normalizeCourseKey(title, parentUrl) {
    const url = String(parentUrl || '').split('#')[0].replace(/\/$/, '').toLowerCase();
    return `${url}|${normalize(title).toLowerCase()}`;
  }

  function isExpanded(control, card) {
    const labelled = control.getAttribute('aria-expanded');
    if (labelled) return labelled === 'true';
    return hasExpandedCourseRows(card);
  }

  async function revealScrollableContent(card) {
    const scrollables = [...card.querySelectorAll('*')].filter((element) => element.scrollHeight > element.clientHeight + 10);
    for (const container of scrollables) {
      container.scrollTop = container.scrollHeight;
      await wait(120);
    }
  }

  async function waitForExpandedCourses(card, before) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (extractCourses(card).length || hasExpandedCourseRows(card) || cardSignature(card) !== before) return;
      await wait(150);
    }
  }

  function hasExpandedCourseRows(card) {
    const parentTitle = extractTitle(card).toLowerCase();
    return [...card.querySelectorAll('a[href]')].some((link) => {
      const name = normalize(link.innerText || link.textContent || '');
      const rowText = normalize(link.closest('li, tr, [class*="course"], [class*="Course"]')?.innerText || link.parentElement?.innerText || '');
      return isCourseName(name, rowText, parentTitle) && /₹|views?|★|⭐/i.test(rowText);
    });
  }

  function extractTitle(card) {
    const heading = card.querySelector('a.course-title, a[class*="course-title"], h1, h2, h3, h4, [class*="heading"], [class*="title"]');
    return normalize(heading?.innerText || card.innerText.split('\n')[0] || '');
  }

  function extractSummary(card) {
    const lines = card.innerText.split(/\r?\n/).map(normalize).filter(Boolean);
    const text = normalize(card.innerText);
    const feeLine = lines.find((line) => /₹/.test(line) && /(?:L|Cr|Total Fees|\d)/i.test(line)) || '';
    const rankingLine = lines.find((line) => /^Ranked\b/i.test(line)) || '';
    const applicationLine = lines.find((line) => /^Application Date\b/i.test(line)) || '';
    const viewsLine = lines.find((line) => /Views/i.test(line) && !/Courses/i.test(line)) || '';
    const feeMatch = text.match(/₹\s*[\d,.]+\s*(?:L|Lakhs?|K|Cr|Crore)?\s*(?:-\s*₹?\s*[\d,.]+\s*(?:L|Lakhs?|K|Cr|Crore)?)?/i);
    const rankingMatch = text.match(/Ranked[^]*?(?=Offered at|Application Date|Courses|\d[\d.]*K?\s*Views|Fees Structure|$)/i);
    const applicationMatch = text.match(/Application Date[^]*?(?=Courses|\d[\d.]*K?\s*Views|Fees Structure|$)/i);
    const viewsMatch = text.match(/[\d.]+K?\s*Views(?:\s*\([^)]*\))?/i);
    const academicLevel = inferAcademicLevel(extractTitle(card));
    return {
      fees: feeMatch?.[0] || feeLine.match(/₹\s*[\d,.]+\s*(?:L|Lakhs?|K|Cr|Crore)?/i)?.[0] || '',
      duration: lines.find((line) => /^\s*•?\s*\d+\s*years?\b/i.test(line))?.match(/\d+\s*years?/i)?.[0] || '',
      mode: text.match(/\b(Full Time|Part Time|Online)\b/i)?.[1] || '',
      ranking: rankingMatch?.[0]?.trim() || rankingLine,
      applicationDate: applicationMatch?.[0]?.trim() || applicationLine,
      views: viewsMatch?.[0]?.trim() || viewsLine.split(/\s+Fees Structure/i)[0],
      category: academicLevel.category,
      degree_level: academicLevel.degree_level
    };
  }

  function inferAcademicLevel(title) {
    const value = String(title || '').toLowerCase();
    if (/\b(ph\.?d|doctorate|m\.?phil)\b/i.test(value)) return { category: 'Doctorate', degree_level: 'Doctorate' };
    if (/\b(pg diploma|post graduate diploma)\b/i.test(value)) return { category: 'PG Diploma', degree_level: 'PG Diploma' };
    if (/\b(diploma|polytechnic)\b/i.test(value)) return { category: 'Diploma', degree_level: 'Diploma' };
    if (/\b(m\.?tech|mba|mca|m\.?sc|m\.?com|m\.?des|m\.?arch|llm|m\.?pharm|mpt|md|ms|master)\b/i.test(value)) return { category: 'Post Graduation', degree_level: 'Masters' };
    if (/\b(b\.?tech|b\.?e\.?|b\.?sc|bba|bca|b\.?com|b\.?a\.?|ba|mbbs|bachelor)\b/i.test(value)) return { category: 'Graduation', degree_level: 'Bachelors' };
    return { category: '', degree_level: '' };
  }

  function extractCourses(card) {
    const result = [];
    const seen = new Set();
    const parentTitle = extractTitle(card).toLowerCase();
    const parentMode = extractSummary(card).mode || '';
    const streamLinks = [...card.querySelectorAll('a.stream-text[href]')];
    const links = streamLinks.length ? streamLinks : [...card.querySelectorAll('a[href]')];

    for (const link of links) {
      const name = normalize(link.innerText || link.textContent || '');
      const row = findCourseRow(link, card);
      const rowText = normalize(row?.innerText || link.parentElement?.innerText || '');
      const url = canonicalUrl(link.href);
      const key = `${url}|${name.toLowerCase()}`;
      if (!isCourseName(name, rowText, parentTitle) || !url || seen.has(key)) continue;
      seen.add(key);
      result.push({
        name,
        fee: rowText.match(/₹\s*[\d,.]+(?:\s*(?:L|Cr))?/i)?.[0] || '',
        rating: rowText.match(/(?:^|\s)([0-5](?:\.\d)?)(?=\s*(?:★|⭐|\||$))/)?.[1] || '',
        views: rowText.match(/\(?[\d,.]+K?\s*views?\)?/i)?.[0] || '',
        mode: parentMode,
        url
      });
    }
    return result;
  }

  function findCourseRow(link, card) {
    let current = link;
    for (let depth = 0; current && current !== card && depth < 5; depth += 1, current = current.parentElement) {
      const text = normalize(current.innerText || '');
      if (text.length >= link.innerText.length && text.length < 300 && /₹|views?|★|⭐/i.test(text)) return current;
    }
    return link.closest('li, tr, [class*="course"], [class*="Course"]') || link.parentElement;
  }

  function isCourseName(name, rowText, parentTitle) {
    if (name.length < 3 || name.length > 120) return false;
    if (name.toLowerCase() === parentTitle) return false;
    if (/^(Courses|Fees Structure|View All|University Department|Apply|Read More)$/i.test(name)) return false;
    if (/reviews?|views?|total fees|last year|application date|offered at/i.test(name)) return false;
    if (/^[\d().,%+\-\s]+$/.test(name) || /^[([{]/.test(name)) return false;
    return /₹|views?|★|⭐/i.test(rowText) || linkLooksLikeStream(name);
  }

  function linkLooksLikeStream(name) {
    return !/^(?:home|about|admission|placement|ranking|contact|apply|read more|view all|fees structure)$/i.test(name);
  }

  function canonicalUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (url.hostname !== location.hostname || !/\/courses\//i.test(url.pathname)) return '';
      url.hash = '';
      return url.href.replace(/\/$/, '');
    } catch {
      return '';
    }
  }

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})();
