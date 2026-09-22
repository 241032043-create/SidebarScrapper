(() => {
  if (!globalThis.chrome?.runtime?.onMessage) return;
  let selecting = false;
  let hoveredCard = null;
  let selectedCard = null;
  let discoveredCourseCards = null;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PING') {
      sendResponse?.({ ok: true });
      return;
    }
    return false;
  });

  function beginSelection() {
    selecting = true;
    hoveredCard = null;
    removeSelectionListeners();
    document.addEventListener('pointerover', handlePointerOver, true);
    document.addEventListener('click', handleCardClick, true);
    chrome.runtime.sendMessage({ type: 'SELECTION_STARTED' });
  }

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

  async function findAllCourseCards(includeStreams = false) {
    const cards = await findAllCourseCardElements(includeStreams);
    return cards.map(({ data }) => data);
  }

  async function findAllCourseCardElements(includeStreams = false) {
    if (!includeStreams && discoveredCourseCards?.length) return discoveredCourseCards;
    await waitForCourseCards();
    await revealAllParentCourses();
    await wait(250);
    const section = document.querySelector('#course-card-section') || document.body;
    const cards = [...section.querySelectorAll('.course-card, [class*="course-card"]')];
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
    if (!includeStreams) discoveredCourseCards = discovered;
    return discovered;
  }

  async function selectCourseCard(index) {
    const cards = await findAllCourseCardElements(false);
    const selected = cards[index]?.element;
    if (!selected) throw new Error('The selected course card was not found on the page.');
    await scrapeSelectedCard(selected);
  }

  async function expandCourseCard(card) {
    const control = findCoursesControl(card);
    let streams = extractCourses(card);
    if (streams.length || !control) return;
    control.click();
    await waitForExpandedCourses(card);
    streams = extractCourses(card);
    if (streams.length) await revealScrollableContent(card);
  }

  async function revealAllParentCourses() {
    const section = document.querySelector('#course-card-section') || document.body;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const button = [...section.querySelectorAll('button, a, [role="button"]')]
        .find((element) => /^(?:view\s+more|load\s+more|view\s+all)(?:\s+(?:courses?|programmes?|degrees?))?$/i.test(normalize(element.innerText || element.textContent || '')));
      if (!button || button.disabled || button.getAttribute('aria-hidden') === 'true') break;
      button.click();
      await wait(350);
    }
  }

  async function waitForCourseCards() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (document.querySelector('.course-card, [class*="course-card"]')) return;
      await wait(300);
    }
    throw new Error('Course cards did not load on the Courses & Fees page.');
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
    return url || normalize(title).toLowerCase();
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

  async function waitForExpandedCourses(card) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (extractCourses(card).length || hasExpandedCourseRows(card)) return;
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
    return {
      fees: feeMatch?.[0] || feeLine.match(/₹\s*[\d,.]+\s*(?:L|Lakhs?|K|Cr|Crore)?/i)?.[0] || '',
      duration: lines.find((line) => /^\s*•?\s*\d+\s*years?\b/i.test(line))?.match(/\d+\s*years?/i)?.[0] || '',
      mode: text.match(/\b(Full Time|Part Time|Online)\b/i)?.[1] || '',
      ranking: rankingMatch?.[0]?.trim() || rankingLine,
      applicationDate: applicationMatch?.[0]?.trim() || applicationLine,
      views: viewsMatch?.[0]?.trim() || viewsLine.split(/\s+Fees Structure/i)[0]
    };
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
      if (!isCourseName(name, rowText, parentTitle) || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      result.push({
        name,
        fee: rowText.match(/₹\s*[\d,.]+(?:\s*(?:L|Cr))?/i)?.[0] || '',
        rating: rowText.match(/(?:^|\s)([0-5](?:\.\d)?)(?=\s*(?:★|⭐|\||$))/)?.[1] || '',
        views: rowText.match(/\(?[\d,.]+K?\s*views?\)?/i)?.[0] || '',
        mode: parentMode,
        url: link.href
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
    return /₹|views?|★/i.test(rowText) || /Engineering|Science|Technology|Biotechnology|Artificial|Management|Commerce|Medicine|Computer/i.test(name);
  }

  function normalize(value) {
    return value.replace(/\s+/g, ' ').trim();
  }

  function extractPlacementData() {
    const pageTitle = normalize(document.querySelector('h1')?.innerText || document.title || '');
    const universityName = pageTitle.replace(/\s+Placement(?:\s+20\d{2})?.*$/i, '').trim();
    const tables = [...document.querySelectorAll('table')];
    const parseRows = (table) => [...table.querySelectorAll('tr')]
      .map((row) => [...row.children].map((cell) => normalize(cell.innerText || '')))
      .filter((row) => row.some(Boolean));
    const summary = {};
    const yearlyStats = [];
    const collegeStats = [];
    const recruiters = new Set();
    const tablesData = [];

    for (const table of tables) {
      const rows = parseRows(table);
      if (rows.length < 2) continue;
      const headers = rows[0];
      const body = rows.slice(1);
      tablesData.push({ headers, rows: body });
      if (/^year$/i.test(headers[0])) {
        for (const row of body) {
          const record = Object.fromEntries(headers.map((header, index) => [header || `column_${index + 1}`, row[index] || '']));
          yearlyStats.push(record);
        }
      } else if (/^college$/i.test(headers[0])) {
        for (const row of body) {
          collegeStats.push(Object.fromEntries(headers.map((header, index) => [header || `column_${index + 1}`, row[index] || ''])));
        }
      } else if (/^companies?$/i.test(headers[0])) {
        body.flat().filter(Boolean).forEach((company) => recruiters.add(company));
      } else if (/^(particular|particulars)$/i.test(headers[0]) && /^statistics|values$/i.test(headers[1] || '')) {
        for (const row of body) {
          if (row[0] && row[1]) summary[row[0]] = row[1];
          if (/recruiters/i.test(row[0] || '')) {
            row[1].split(/,|\n/).map((company) => normalize(company)).filter(Boolean).forEach((company) => recruiters.add(company));
          }
        }
      }
    }

    const totalStudents = Number.parseInt(summary['Total Students'], 10);
    const studentsPlaced = Number.parseInt(summary['Number of Students Placed'], 10);
    if (Number.isFinite(totalStudents) && Number.isFinite(studentsPlaced) && totalStudents > 0) {
      summary['Placement Rate (%)'] = `${((studentsPlaced / totalStudents) * 100).toFixed(2)}%`;
    }

    return {
      university_name: universityName,
      source_url: location.href,
      summary,
      yearly_stats: yearlyStats,
      college_stats: collegeStats,
      recruiters: [...recruiters],
      tables: tablesData
    };
  }

  async function extractRankingData() {
    await revealRankingContent();
    const heading = document.querySelector('h1');
    const pageTitle = normalize(heading?.innerText || document.title || '');
    const universityName = pageTitle.replace(/\s+Ranking(?:\s+20\d{2})?.*$/i, '').trim();
    const pageText = normalize(document.body?.innerText || '');
    const agencies = [
      { type: 'NIRF', match: 'NIRF', body: 'Ministry Of Education, India' },
      { type: 'India Today', match: 'India Today', body: 'India Today' },
      { type: 'Outlook', match: 'Outlook', body: 'Outlook India' },
      { type: 'IIRF', match: 'IIRF', body: 'IIRF' },
      { type: 'TOI', match: 'The Times Of India', body: 'The Times Of India' },
      { type: 'NIRF Innovation', match: 'National Institutional Ranking Framework Innovation', body: 'National Institutional Ranking Framework Innovation' },
      { type: 'QS', match: 'QS World University', body: 'QS World University' },
      { type: 'Collegedunia', match: 'Collegedunia.com', body: 'Collegedunia.com' }
    ];
    const entries = []; 
    for (const agency of agencies) {
      const marker = agency.type === 'India Today' ? 'Indiatoday Ranking' : `${agency.type} Ranking`;
      const start = pageText.toLowerCase().indexOf(marker.toLowerCase());
      if (start < 0) continue;
      const pattern = new RegExp(`${escapeRegExp(universityName)}\\s+([^.!?]{1,100}?)\\s+ranking\\s+by\\s+${escapeRegExp(agency.match)}\\s+is\\s+([\\d-]+)\\s+out\\s+of\\s+[\\d,]+[^.]*?in\\s+(20\\d{2})(?:\\s+and\\s+it\\s+was\\s+([\\d-]+)[^.]*?in\\s+(20\\d{2}))?`, 'gi');
      let match;
      while ((match = pattern.exec(pageText))) {
        const stream = normalize(match[1]).replace(/^(Overall)\s*$/i, 'Overall');
        if (/ranking|top streams|top agencies|compare|courses|fees/i.test(stream)) continue;
        entries.push({ agency, stream, rank: match[2], year: match[3], previousRank: match[4] || '' });
      }
    }
    const tableAgencies = [
      { heading: 'Collegedunia Ranking', type: 'Collegedunia', body: 'Collegedunia.com' },
      { heading: 'Indiatoday Ranking', type: 'India Today', body: 'India Today' },
      { heading: 'NIRF Ranking', type: 'NIRF', body: 'Ministry Of Education, India' },
      { heading: 'Outlook Ranking', type: 'Outlook', body: 'Outlook India' },
      { heading: 'IIRF Ranking', type: 'IIRF', body: 'IIRF' },
      { heading: 'TOI Ranking', type: 'TOI', body: 'The Times Of India' },
      { heading: 'NIRF Innovation Ranking', type: 'NIRF Innovation', body: 'National Institutional Ranking Framework Innovation' },
      { heading: 'QS Ranking', type: 'QS', body: 'QS World University' }
    ];
    for (const agency of tableAgencies) {
      const heading = [...document.querySelectorAll('h2, h3, h4')]
        .find((element) => normalize(element.innerText || '') === agency.heading);
      let container = heading;
      while (container && !container.querySelector('table')) container = container.parentElement;
      const table = container?.querySelector('table');
      if (!table) continue;
      const headers = [...table.querySelectorAll('thead th, tr:first-child > *')].map((cell) => normalize(cell.innerText || ''));
      for (const row of [...table.querySelectorAll('tbody tr')]) {
        const cells = [...row.children].map((cell) => normalize(cell.innerText || ''));
        const stream = cells[0]?.replace(/\s*Compare\s*$/i, '').trim();
        if (!stream) continue;
        const rankedCells = cells.slice(1).map((text, index) => {
          const rankMatch = text.match(/#?([\d-]+)\s+out\s+of\s+[\d,]+\s+in\s+(?:India|International)\s+(20\d{2})/i);
          return rankMatch ? { rank: rankMatch[1], year: rankMatch[2], index } : null;
        }).filter(Boolean);
        for (const current of rankedCells) {
          const previous = rankedCells.find((candidate) => candidate.index > current.index);
          entries.push({ agency, stream, rank: current.rank, year: current.year, previousRank: previous?.rank || '' });
        }
      }
    }
    const unique = new Map(entries.map((entry) => [`${entry.agency.type}|${entry.stream}|${entry.year}|${entry.rank}`, entry]));
    return [...unique.values()].map((entry) => {
      const rankNumber = Number.parseInt(entry.rank, 10);
      const previousNumber = Number.parseInt(entry.previousRank, 10);
      const change = Number.isFinite(rankNumber) && Number.isFinite(previousNumber)
        ? `${previousNumber - rankNumber >= 0 ? '+' : ''}${previousNumber - rankNumber}`
        : 'N/A';
      const isBand = entry.rank.includes('-');
      return {
        university_name: universityName,
        ranking_year: entry.year,
        ranking_type: entry.agency.type,
        ranking_body: entry.agency.body,
        rank_position: entry.rank,
        previous_rank: entry.previousRank || 'N/A',
        change,
        stream: entry.stream,
        score: 'N/A',
        subtitle: isBand ? `Placed in the official ${entry.rank} rank band` : `Ranked ${entry.rank} in the official ${entry.agency.type} ranking`,
        highlight: isBand ? `Secured a position within the official ${entry.rank} ${entry.agency.type} rank band.` : `Secured rank ${entry.rank} in the official ${entry.agency.type} ranking.`
      };
    });
  }

  async function revealRankingContent() {
    for (const headingText of ['Top Streams:', 'Top Agencies:']) {
      const heading = [...document.querySelectorAll('h2, h3, h4')]
        .find((element) => normalize(element.innerText || '') === headingText);
      const control = heading?.parentElement?.nextElementSibling?.querySelector('button');
      if (control && /^All$/i.test(normalize(control.innerText || '')) && !control.classList.contains('active')) {
        control.click();
        await wait(250);
      }
    }
    const originalPosition = window.scrollY;
    let previousHeight = 0;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      window.scrollTo(0, document.body.scrollHeight);
      await wait(350);
      const height = document.body.scrollHeight;
      if (height === previousHeight && window.innerHeight + window.scrollY >= height - 5) break;
      previousHeight = height;
    }
    window.scrollTo(0, originalPosition);
    await wait(250);
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  async function extractDetailPage(fallback = {}) {
    await expandDescription();
    const body = document.body?.innerText || '';
    const title = normalize(document.querySelector('h1')?.innerText || document.title);
    const highlights = extractHighlights();
    const feeTable = extractFeeTable();
    const eligibilityText = extractSectionText(/Eligibility/i);
    return extractMarketplaceData({ body, title, highlights, feeTable, eligibilityText, fallback });
  }

  function extractMarketplaceData({ body, title, highlights, feeTable, eligibilityText, fallback }) {
    const feeValue = (pattern) => extractAmount(feeTable.find((row) => pattern.test(row.component))?.amount || '');
    const feeBounds = deriveFeeBounds(body, feeTable, highlights.fees, fallback.fee);
    const eligibilityBlock = extractBoundedBlock(body, /Eligibility Criteria:?/i, /Admission Process:?|Students' Opinion|Scholarships|Placements/i) || eligibilityText || highlights.eligibility;
    const admissionBlock = extractBoundedBlock(body, /Admission Process:?/i, /Eligibility Criteria:?|Students' Opinion|Scholarships|Placements/i);
    const admissionStatus = extractAdmissionStatus(body);
    const qualification = eligibilityBlock.match(/(?:Class|10\s*\+\s*2|12th)[^.!?]{0,500}/i)?.[0] || '';
    const percentage = eligibilityBlock.match(/\b\d{1,3}%\b/)?.[0]
      || qualification.match(/\b\d{1,3}%\b/)?.[0]
      || body.match(/minimum\s+(?:aggregate\s+of\s+)?\d{1,3}%/i)?.[0]?.match(/\d{1,3}%/)?.[0]
      || '';
    const topCourseContent = body.split(/Key Points|Table of Contents|Fees Admission Scholarships/i)[0];
    const examMatches = `${topCourseContent} ${admissionBlock} ${eligibilityBlock}`.match(/\b(?:JEE\s*Main|JEE\s*Advanced|CUET(?:-UG)?|NEET|CAT|MAT|XAT|NMAT|CMAT)\b/gi) || [];
    const uniqueExams = [...new Set(examMatches.map(normalize))];
    const courseMatch = title.match(/\b(B\.?Tech|B\.?E\.?|B\.?Sc|B\.?Com|B\.?A\.?|BA|MA|MBA|M\.?Tech|M\.?Sc|M\.?S|MBBS|BCA|BBA|MCA|LLB|Ph\.?D)\b/i);
    const stream = extractStreamName(title, courseMatch?.[0] || '');
    return {
      stream_name: stream || title,
      course: courseMatch?.[1] || '',
      duration: normalizeDuration(highlights.duration || extractCourseDuration(body)),
      mode: extractHighlightsMode() || fallback.mode || extractStudyMode(topCourseContent),
      admissionStatus,
      admission_dates: extractAdmissionDates(body),
      source_url: location.href,
      intake: extractIntake(body) || extractSeatAvailability(body),
      description: extractDescription(body),
      tuition_fee: feeValue(/tuition fee|academic fee/i)
        || feeValue(/total fees|total fee|total academic fee/i)
        || extractAmount(fallback.fee || ''),
      hostel_fee: feeValue(/hostel fee/i),
      admission_fee: feeValue(/admission fee|registration fee/i),
      total_fee: feeValue(/total fees|total academic fee/i) || extractAmount(fallback.fee || ''),
      min_fee: feeBounds.min || extractAmount(fallback.fee || ''),
      max_fee: feeBounds.max || extractAmount(fallback.fee || ''),
      seat_availability: extractSeatAvailability(body),
      age_limit: '',
      seat_distribution: [],
      min_qualification: normalize(qualification),
      min_percentage: percentage,
      entrance_exams: uniqueExams.join(', ')
    };
  }

  function extractPlacementData(body, placementText) {
    const table = [...document.querySelectorAll('table')].find((item) => /placement metric/i.test(normalize(item.innerText)));
    const statistics = [...(table?.querySelectorAll('tr') || [])].map((row) => {
      const cells = [...row.querySelectorAll('th, td')].map((cell) => normalize(cell.innerText));
      return cells.length >= 2 ? { metric: cells[0], value: cells[cells.length - 1] } : null;
    }).filter((row) => row && !/placement metric|data|feature/i.test(row.metric));
    const note = body.match(/Course-specific placement data[^.]*\./i)?.[0] || '';
    const placedMetric = statistics.find((row) => /students placed before passing out/i.test(row.metric));
    return {
      description: placementText || '',
      statistics,
      students_placed_before_passing_out: placedMetric?.value || '',
      note: normalize(note)
    };
  }

  function extractStreamName(title, course) {
    const withoutSuffix = title.replace(/:\s*Fees.*$/i, '').trim();
    const escapedCourse = course.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const courseStart = course ? withoutSuffix.search(new RegExp(`\\b${escapedCourse}\\b`, 'i')) : -1;
    const courseTitle = courseStart >= 0 ? withoutSuffix.slice(courseStart) : withoutSuffix;
    return courseTitle.replace(new RegExp(`^${escapedCourse}(?:\\s+|$)`, 'i'), '').trim() || courseTitle;
  }

  function extractBoundedBlock(text, startPattern, endPattern) {
    const start = text.search(startPattern);
    if (start < 0) return '';
    const remaining = text.slice(start).replace(startPattern, '');
    const end = remaining.search(endPattern);
    return normalize((end >= 0 ? remaining.slice(0, end) : remaining).slice(0, 700));
  }

  function extractHighlightsMode() {
    const table = [...document.querySelectorAll('table')].find((item) => /course highlights|mode of study/i.test(normalize(item.innerText)));
    const row = [...(table?.querySelectorAll('tr') || [])].find((item) => /mode of study/i.test(normalize(item.innerText)));
    return row ? [...row.querySelectorAll('th, td')].map((cell) => normalize(cell.innerText)).pop() || '' : '';
  }

  function extractStudyMode(body) {
    const match = body.match(/\b(Full[- ]?time|Part[- ]?time|On[- ]campus|Distance)\b/i);
    return match ? match[1].replace(/-/g, ' ') : '';
  }

  function extractIntake(body) {
    const match = body.match(/(?:annual\s+)?intake\s*[:\-]?\s*([\d,]+\s*(?:students?|seats?)?(?:\s*\/\s*year)?)/i)
      || body.match(/seats?\s+available\s*[:\-]?\s*([\d,]+)/i);
    return match ? normalize(match[1]) : '';
  }

  function extractSeatAvailability(body) {
    const match = body.match(/(?:seat\s+availability|available\s+seats?|seats\s+available)\s*[:\-]?\s*([\d,]+)/i);
    return match ? match[1].replace(/,/g, '') : '';
  }

  function extractDescription(body) {
    const lines = body.split(/\r?\n/).map(normalize).filter(Boolean);
    const start = lines.findIndex((line) => /(?:offers?|provides?|is a \d+[- ]?year|program(?:me)? covers?)/i.test(line));
    if (start >= 0) {
      const description = [];
      for (let index = start; index < Math.min(lines.length, start + 8); index += 1) {
        if (/^(Bachelor|Master|B\.?Tech|B\.?Sc|Fees|Eligibility|Admission|Key Points|Table of Contents)/i.test(lines[index])) break;
        description.push(lines[index]);
      }
      if (description.join(' ').length >= 50) return description.join(' ').replace(/\s*Read More\s*$/i, '').slice(0, 900);
    }
    const match = body.match(/(?:programme|program(?:me)?)\s+is\s+(?:a|an)\s+[^.]{40,500}\./i);
    return normalize(match?.[0] || '').replace(/\s*Read More\s*$/i, '');
  }

  async function expandDescription() {
    const readMore = [...document.querySelectorAll('button, a, [role="button"]')]
      .find((element) => /^Read More$/i.test(normalize(element.innerText || element.textContent || '')));
    if (readMore && !readMore.dataset.universityScraperExpanded) {
      readMore.dataset.universityScraperExpanded = 'true';
      readMore.click();
      await wait(350);
    }
  }

  function extractCourseDuration(body) {
    const topContent = body.split(/Key Points|Table of Contents|Fees Admission Scholarships/i)[0];
    const match = body.match(/\bDuration\s*:\s*(\d+\s*[- ]?year(?:s)?)\b/i)
      || topContent.match(/\b(\d+\s*[- ]?year(?:s)?)\b/i)
      || body.match(/\b(\d+\s*[- ]?year(?:s)?)\b/i);
    return match?.[1] || '';
  }

  function normalizeDuration(value) {
    const match = normalize(value).match(/(\d+)\s*[- ]?year/i);
    return match ? `${match[1]} Years` : '';
  }

  function extractAmount(value) {
    const match = normalize(value).match(/(?:₹|Rs\.?|INR)?\s*([\d,]+(?:\.\d+)?)\s*(L|Lakhs?|Cr|Crore)?/i);
    if (!match) return '';
    const amount = Number(match[1].replace(/,/g, '')) * (match[2] ? /cr|crore/i.test(match[2]) ? 10000000 : 100000 : 1);
    return Number.isFinite(amount) ? String(Math.round(amount)) : '';
  }

  function deriveFeeBounds(body, feeTable, highlightFees, fallbackFee) {
    const feeRangePattern = /(?:₹|Rs\.?|INR)?\s*[\d,.]+\s*(?:L|Lakhs?|Cr|Crore)?\s*-\s*(?:₹|Rs\.?|INR)?\s*[\d,.]+\s*(?:L|Lakhs?|Cr|Crore)?/i;
    const rangeSources = [highlightFees, fallbackFee, ...feeTable.map((row) => row.amount)];
    for (const source of rangeSources) {
      const range = normalize(source || '').match(feeRangePattern);
      if (!range) continue;
      const values = range[0].match(/(?:₹|Rs\.?|INR)?\s*[\d,.]+\s*(?:L|Lakhs?|Cr|Crore)?/gi)?.map(extractAmount).filter(Boolean) || [];
      if (values.length >= 2) return { min: values[0], max: values[1] };
    }
    const academic = feeTable.filter((row) => /total (?:tuition|academic) fee/i.test(row.component) && !/hostel/i.test(row.component));
    const nonSponsored = academic.find((row) => /non-sponsored/i.test(row.component)) || academic[0];
    const sponsoredPerTerm = feeTable.find((row) => /sponsored/i.test(row.component) && /per semester|per year/i.test(row.component));
    const terms = Number(feeTable.find((row) => /number of semesters/i.test(row.component))?.amount || 0);
    const min = extractAmount(nonSponsored?.amount || '');
    const sponsored = extractAmount(sponsoredPerTerm?.amount || '');
    const max = sponsored && terms ? String(Number(sponsored) * terms) : min;
    return { min, max: max || min };
  }

  function extractHighlights() {
    const table = [...document.querySelectorAll('table')].find((item) => /course highlights|mode of study/i.test(normalize(item.innerText)));
    const values = {};
    table?.querySelectorAll('tr').forEach((row) => {
      const cells = [...row.querySelectorAll('th, td')].map((cell) => normalize(cell.innerText));
      if (cells.length >= 2) values[cells[0].toLowerCase()] = cells[cells.length - 1];
    });
    return { duration: values.duration || '', fees: values['total fees'] || '', eligibility: values.eligibility || '' };
  }

  function extractValueFromText(text, pattern) {
    return normalize(text.match(pattern)?.[1] || '');
  }

  function extractSectionText(headingPattern) {
    const heading = [...document.querySelectorAll('h2, h3, h4, [role="heading"]')]
      .find((element) => headingPattern.test(normalize(element.innerText)));
    if (!heading) return '';
    const chunks = [];
    let current = heading.nextElementSibling;
    for (let index = 0; current && index < 4; index += 1, current = current.nextElementSibling) {
      if (/^H[1-4]$/.test(current.tagName)) break;
      const text = normalize(current.innerText || '');
      if (text) chunks.push(text);
    }
    return chunks.join(' ').slice(0, 500);
  }

  function extractAdmissionStatus(body) {
    const match = body.match(/Admissions?\b[^.\n]{0,100}\b(?:are|is|remain|remains)\s+(currently\s+)?(open|closed|ongoing)/i)
      || body.match(/Admission\s+Status\s*:\s*Applications?\s+(open|closed|ongoing)/i);
    if (match) return (match[2] || match[1] || '').trim();
    const deadline = body.match(/Application\s+Deadline\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
    if (!deadline) return '';
    const deadlineDate = new Date(deadline[1]);
    return Number.isNaN(deadlineDate.getTime()) ? '' : (deadlineDate >= new Date() ? 'open' : 'closed');
  }

  function extractAdmissionDates(body) {
    const lines = body.split(/\r?\n/).map(normalize).filter(Boolean);
    return lines.filter((line) => /application|deadline|last date to apply|commencement/i.test(line) && /\d{4}|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b|\b\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+/i.test(line)).slice(0, 10);
  }

  function extractFeeTable() {
    const tables = [...document.querySelectorAll('table')];
    const feeTable = tables.find((table) => /fee component|fee components|tuition fee.*(?:semester|year)|number of semesters/i.test(normalize(table.innerText)))
      || tables.find((table) => /total fees/i.test(normalize(table.innerText)) && !/course highlights/i.test(normalize(table.innerText)));
    if (!feeTable) return [];
    return [...feeTable.querySelectorAll('tr')].map((row) => {
      const cells = [...row.querySelectorAll('th, td')].map((cell) => normalize(cell.innerText));
      return cells.length >= 2 ? { component: cells[0], amount: cells[cells.length - 1] } : null;
    }).filter((row) => row && !/^(fee component|amount \(rs\.?\))$/i.test(row.component));
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})();
