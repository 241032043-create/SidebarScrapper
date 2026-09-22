(() => {
  const api = globalThis.__universityScraperStream = globalThis.__universityScraperStream || {};

  if (!globalThis.chrome?.runtime?.onMessage) return;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SCRAPE_DETAIL_PAGE') {
      api.extractDetailPage(message.fallback)
        .then((details) => sendResponse?.({ details }))
        .catch((error) => sendResponse?.({ details: null, error: error.message || 'Stream details could not be extracted.' }));
      return true;
    }
    return false;
  });

  api.extractDetailPage = async function extractDetailPage(fallback = {}) {
    await expandDescription();
    const body = document.body?.innerText || '';
    const title = normalize(document.querySelector('h1')?.innerText || document.title);
    const highlights = extractHighlights();
    const feeTable = extractFeeTable();
    const eligibilityText = extractSectionText(/Eligibility/i);
    return extractMarketplaceData({ body, title, highlights, feeTable, eligibilityText, fallback });
  };

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
      entrance_exams: uniqueExams
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

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})();
