chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

let pendingSingleCardTab = null;
let pendingSingleCardCards = [];
const SINGLE_CARD_SESSION_KEY = 'singleCardSession';
let activeAllCourseDetailsPromise = null;
let activeAllCourseDetailsRun = 0;
const universityUrlCache = new Map();
const STREAM_SCRAPE_CONCURRENCY = 8;
const SINGLE_CARD_SCRAPE_CONCURRENCY = 4;

chrome.storage.session.get(SINGLE_CARD_SESSION_KEY).then(({ singleCardSession }) => {
  if (Number.isInteger(singleCardSession?.tabId)) {
    pendingSingleCardTab = singleCardSession.tabId;
    pendingSingleCardCards = Array.isArray(singleCardSession.cards) ? singleCardSession.cards : [];
  }
}).catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== pendingSingleCardTab) return;
  pendingSingleCardTab = null;
  pendingSingleCardCards = [];
  chrome.storage.session.remove(SINGLE_CARD_SESSION_KEY).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== 'OPEN_SCRAPER' || !sender.tab?.id) return;
  chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'COURSE_CARDS_PROGRESS') {
    sendProgress(message.message);
    return;
  }
  if (message.type === 'GET_UNIVERSITY_SUGGESTIONS' && message.query) {
    getUniversitySuggestions(message.query)
      .then((suggestions) => sendResponse?.({ suggestions }))
      .catch(() => sendResponse?.({ suggestions: [] }));
    return true;
  }
  if (pendingSingleCardTab && sender.tab?.id === pendingSingleCardTab && ['SCRAPE_RESULT', 'SCRAPE_ERROR'].includes(message.type)) {
    chrome.runtime.sendMessage(message).catch(() => {});
    return;
  }
  if (message.type === 'SHOW_CACHED_SINGLE_COURSE_CARDS') {
    chrome.storage.session.get(SINGLE_CARD_SESSION_KEY).then(({ singleCardSession }) => {
      if (Number.isInteger(singleCardSession?.tabId)) {
        pendingSingleCardTab = singleCardSession.tabId;
        pendingSingleCardCards = Array.isArray(singleCardSession.cards) ? singleCardSession.cards : [];
      }
      if (!Number.isInteger(pendingSingleCardTab)) throw new Error('The course page is no longer available. Start the course picker again.');
      return chrome.tabs.get(pendingSingleCardTab);
    }).then(() => {
      sendResponse?.({ ok: true, cards: pendingSingleCardCards });
    }).catch(() => {
      pendingSingleCardTab = null;
      pendingSingleCardCards = [];
      chrome.storage.session.remove(SINGLE_CARD_SESSION_KEY).catch(() => {});
      sendResponse?.({ ok: false, message: 'The course page is no longer available. Start the course picker again.' });
    });
    return true;
  }
  if (message.type === 'SCRAPE_COURSE_DETAILS' && Array.isArray(message.courses)) {
    scrapeCourseDetails(message.courses, message.parentUrl, message.courseCard)
      .then(({ courses, parentDetails }) => chrome.runtime.sendMessage({ type: 'DETAILS_RESULT', courses, parentDetails }))
      .catch((error) => chrome.runtime.sendMessage({ type: 'DETAILS_ERROR', message: error.message }));
    sendResponse?.({ ok: true });
    return true;
  }
  if (message.type === 'SCRAPE_ALL_PARENT_DESCRIPTIONS' && Array.isArray(message.courses)) {
    generateCourseDescriptions(message.courses)
      .then((courses) => {
        const summary = courses.descriptionSummary || null;
        if (summary?.batchesFailed) {
          chrome.runtime.sendMessage({
            type: 'ALL_DESCRIPTIONS_ERROR',
            courses,
            summary,
            message: `Gemini description generation failed for ${summary.failedDescriptions} courses across ${summary.batchesFailed} batch(es).`
          });
          return;
        }
        chrome.runtime.sendMessage({ type: 'ALL_DESCRIPTIONS_RESULT', courses, summary });
      })
      .catch((error) => chrome.runtime.sendMessage({ type: 'ALL_DESCRIPTIONS_ERROR', message: error.message }));
    sendResponse?.({ ok: true });
    return true;
  }
  if (message.type === 'SCRAPE_ALL_COURSE_DETAILS' && Array.isArray(message.courses)) {
    if (activeAllCourseDetailsPromise) {
      sendResponse?.({ ok: true, reused: true });
      return true;
    }
    const runId = ++activeAllCourseDetailsRun;
    activeAllCourseDetailsPromise = scrapeAllCourseDetails(message.courses, runId);
    activeAllCourseDetailsPromise
      .then(({ courses, completeness }) => chrome.runtime.sendMessage({ type: 'ALL_COURSE_DETAILS_RESULT', courses, completeness }))
      .catch((error) => chrome.runtime.sendMessage({ type: 'ALL_COURSE_DETAILS_ERROR', message: error.message }))
      .finally(() => { activeAllCourseDetailsPromise = null; });
    sendResponse?.({ ok: true });
    return true;
  }
  if (message.type === 'SCRAPE_ALL_COURSES_FOR_UNIVERSITY' && message.universityName) {
    sendProgress(`Finding the Collegedunia Courses & Fees page for ${message.universityName}...`);
    scrapeAllCoursesForUniversity(message.universityName)
      .then((cards) => chrome.runtime.sendMessage({ type: 'ALL_COURSES_RESULT', cards }))
      .catch((error) => chrome.runtime.sendMessage({ type: 'ALL_COURSES_ERROR', message: error.message }));
    sendResponse?.({ ok: true });
    return true;
  }
  if (message.type === 'PREPARE_SINGLE_COURSE_SELECTION' && message.universityName) {
    sendProgress(`Finding course cards for ${message.universityName}...`);
    prepareSingleCourseSelection(message.universityName)
      .then(({ tabId, cards }) => {
        if (pendingSingleCardTab && pendingSingleCardTab !== tabId) chrome.tabs.remove(pendingSingleCardTab).catch(() => {});
        pendingSingleCardTab = tabId;
        pendingSingleCardCards = cards;
        chrome.storage.session.set({ [SINGLE_CARD_SESSION_KEY]: { tabId, cards } }).catch(() => {});
        sendResponse?.({ ok: true, cards });
      })
      .catch((error) => sendResponse?.({ ok: false, message: error.message }));
    return true;
  }
  if (message.type === 'SELECT_SINGLE_COURSE' && Number.isInteger(message.index) && pendingSingleCardTab) {
    chrome.tabs.sendMessage(pendingSingleCardTab, { type: 'SELECT_COURSE_CARD', index: message.index }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        sendResponse?.({ ok: false, message: chrome.runtime.lastError?.message || response?.message || 'The selected course card could not be opened.' });
        return;
      }
      sendResponse?.({ ok: true });
    });
    return true;
  }
  if (message.type === 'SCRAPE_RANKING_PAGE' && (message.url || message.universityName)) {
    sendProgress('Opening the university ranking page...');
    resolveUniversityPageUrl(message.url, message.universityName, 'ranking')
      .then((url) => scrapeRankingPage(url))
      .then((ranking) => chrome.runtime.sendMessage({ type: 'RANKING_RESULT', ranking }))
      .catch((error) => chrome.runtime.sendMessage({ type: 'RANKING_ERROR', message: error.message }));
    sendResponse?.({ ok: true });
    return true;
  }
  if (message.type === 'SCRAPE_PLACEMENT_PAGE' && (message.url || message.universityName)) {
    sendProgress('Opening the university placement page...');
    resolveUniversityPageUrl(message.url, message.universityName, 'placement')
      .then((url) => scrapePlacementPage(url))
      .then((placement) => chrome.runtime.sendMessage({ type: 'PLACEMENT_RESULT', placement }))
      .catch((error) => chrome.runtime.sendMessage({ type: 'PLACEMENT_ERROR', message: error.message }));
    sendResponse?.({ ok: true });
    return true;
  }
  if (message.type === 'SCRAPE_GOOGLE_IMAGES' && message.universityName) {
    sendProgress(`Checking facilities for ${message.universityName}...`);
    scrapeGoogleImages(message.universityName)
      .then((images) => chrome.runtime.sendMessage({ type: 'GOOGLE_IMAGES_RESULT', images }))
      .catch((error) => chrome.runtime.sendMessage({ type: 'GOOGLE_IMAGES_ERROR', message: error.message }));
    sendResponse?.({ ok: true });
    return true;
  }
  if (message.type === 'DOWNLOAD_GOOGLE_IMAGE' && message.image) {
    chrome.downloads.download({
      url: message.image,
      filename: `${sanitizeFilename(message.facility || 'University facility')} - ${sanitizeFilename(message.heading || 'image')}${getImageExtension(message.image)}`,
      conflictAction: 'uniquify',
      saveAs: false
    }).then(() => sendResponse?.({ ok: true })).catch((error) => sendResponse?.({ ok: false, message: error.message }));
    return true;
  }
  if (message.type === 'FETCH_GEMINI_OVERVIEW' && message.universityName) {
    sendProgress('Opening Gemini and preparing the university overview...');
    fetchGeminiOverview(message.universityName)
      .then((overview) => chrome.runtime.sendMessage({ type: 'GEMINI_OVERVIEW_RESULT', overview }))
      .catch((error) => chrome.runtime.sendMessage({ type: 'GEMINI_OVERVIEW_ERROR', message: error.message }));
    sendResponse?.({ ok: true });
    return true;
  }
});

function sendProgress(message) {
  chrome.runtime.sendMessage({ type: 'SCRAPE_PROGRESS', message }).catch(() => {});
}

async function resolveUniversityPageUrl(url, universityName, page) {
  if (!url && !universityName?.trim()) throw new Error('Enter a university or campus name first.');
  const baseUrl = url && /^https:\/\/collegedunia\.com\/university\//i.test(url)
    ? url
    : await findCollegeduniaUniversity(universityName.trim());
  return `${baseUrl.replace(/\/(?:courses-fees|ranking|placement)\/?$/i, '').replace(/\/$/, '')}/${page}`;
}

async function getUniversitySuggestions(query) {
  const queries = [query, `${query} university`, `${query} college`];
  const responses = await Promise.all(queries.map(async (term) => {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(term)}`;
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data?.[1]) ? data[1] : [];
  }));
  return [...new Set(responses.flat())]
    .filter((item) => /university|institute|college|iit|nit|school/i.test(item))
    .slice(0, 6);
}

function sanitizeFilename(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'image';
}

function getImageExtension(url) {
  try {
    const extension = new URL(url).pathname.match(/\.(jpg|jpeg|png|webp|gif)$/i)?.[1];
    return extension ? `.${extension.toLowerCase()}` : '.jpg';
  } catch {
    return '.jpg';
  }
}

async function fetchGeminiOverview(universityName) {
  sendProgress('Waiting for Gemini to return the structured overview...');
  const tab = await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: true });
  try {
    await waitForTabComplete(tab.id, 30000);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['gemini-content.js'] });
    await requestGemini(tab.id, { type: 'FILL_GEMINI_PROMPT', universityName }, 5);
    return await waitForGeminiResponse(tab.id, 60);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function generateCourseDescriptions(courses) {
  if (!courses.length) return [];
  sendProgress(`Opening Gemini to write ${courses.length} course descriptions...`);
  const output = courses.map((course) => ({ ...course, description: '' }));
  let failedBatches = 0;
  const batchErrors = [];
  let successfulDescriptions = 0;
  const descriptionStartedAt = Date.now();
  let tab = null;
  const batchSize = 12;
  const totalBatches = Math.ceil(courses.length / batchSize);
  console.debug('[University Scraper][gemini-courses] generation started', {
    totalCourses: courses.length,
    batchSize,
    totalBatches
  });
  try {
    tab = await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: true });
    await waitForTabComplete(tab.id, 30000);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['gemini-content.js'] });
    for (let start = 0; start < courses.length; start += batchSize) {
      const batchNumber = Math.floor(start / batchSize) + 1;
      const batch = courses.slice(start, start + batchSize).map((course, offset) => ({
        index: start + offset,
        course_name: course.title || '',
        category: course.summary?.category || '',
        degree_level: course.summary?.degree_level || '',
        course_type: course.summary?.mode || '',
        duration: course.summary?.duration || '',
        total_fees: course.summary?.fees || '',
        admission_status: course.summary?.applicationDate || '',
        streams: (course.courses || []).map((stream) => ({
          name: stream.name || '',
          fee: stream.fee || '',
          rating: stream.rating || '',
          views: stream.views || ''
        }))
      }));
      const batchId = `${Date.now()}-${start}`;
      let response;
      const requestedNames = batch.map((item) => `${item.index}:${item.course_name}`);
      console.debug('[University Scraper][gemini-courses] batch created', {
        batchNumber,
        totalBatches,
        batchSize: batch.length,
        batchId,
        courses: requestedNames
      });
      sendProgress(`Gemini batch ${batchNumber}/${totalBatches}: preparing ${batch.length} course descriptions...`);
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          console.debug('[University Scraper][gemini-courses] request starting', {
            batchNumber,
            attempt,
            model: 'Gemini web UI / model selected by Gemini',
            requestedCourses: batch.length,
            approximatePayloadBytes: new TextEncoder().encode(JSON.stringify({ type: 'FILL_COURSE_DESCRIPTION_PROMPT', batchId, courses: batch })).length,
            approximatePromptChars: 560 + batchId.length + JSON.stringify(batch).length,
            requestStart: new Date().toISOString()
          });
          const requestResult = await requestGemini(tab.id, { type: 'FILL_COURSE_DESCRIPTION_PROMPT', batchId, courses: batch }, 5);
          console.debug('[University Scraper][gemini-courses] request accepted by page bridge', { batchNumber, attempt, diagnostics: requestResult?.diagnostics || null });
          sendProgress(`Gemini batch ${batchNumber}/${totalBatches}: prompt sent; waiting for JSON response...`);
          response = validateDescriptionBatch(await waitForGeminiCourseResponse(tab.id, batchId, 45), batch, batchId);
          sendProgress(`Gemini batch ${batchNumber}/${totalBatches}: response received (${response.descriptions.length} descriptions).`);
          console.debug('[University Scraper][gemini-courses] batch succeeded', {
            batchNumber,
            attempt,
            returnedDescriptions: response.descriptions.length,
            returnedIndexes: response.descriptions.map((item) => item.index)
          });
          break;
        } catch (error) {
          console.error('[University Scraper][gemini-courses] batch attempt failed', {
            batchNumber,
            attempt,
            message: error.message,
            courses: requestedNames
          });
          if (attempt === 2) {
            failedBatches += 1;
            batchErrors.push({ batchNumber, batchId, indexes: batch.map((item) => item.index), message: error.message });
            sendProgress(`Gemini batch ${batchNumber}/${totalBatches}: failed after retry; leaving those descriptions blank.`);
          } else {
            sendProgress(`Gemini batch ${batchNumber}/${totalBatches}: no response; retrying once...`);
          }
        }
      }
      const beforeAssigned = output.filter((course) => course.description).length;
      for (const item of response?.descriptions || []) {
        const target = Number.isInteger(item.index) && item.index >= 0 && item.index < output.length ? output[item.index] : null;
        if (Number.isInteger(item.index) && item.index >= 0 && item.index < output.length && typeof item.description === 'string') {
          target.description = item.description.trim();
          successfulDescriptions += Boolean(target.description);
          console.debug('[University Scraper][gemini-courses] description merged', { index: item.index, assigned: Boolean(target.description) });
        }
      }
      console.debug('[University Scraper][gemini-courses] batch merge complete', {
        batchNumber,
        descriptionsBefore: beforeAssigned,
        descriptionsAfter: output.filter((course) => course.description).length
      });
      chrome.runtime.sendMessage({
        type: 'COURSE_DESCRIPTIONS_PROGRESS',
        completed: Math.min(start + batch.length, courses.length),
        total: courses.length,
        batch: batchNumber,
        totalBatches,
        phase: response ? 'completed' : 'failed',
        elapsedMs: Date.now() - descriptionStartedAt
      }).catch(() => {});
    }
    output.descriptionBatchFailures = failedBatches;
    output.descriptionBatchErrors = batchErrors;
    output.descriptionSummary = {
      totalCourses: courses.length,
      coursesSentToGemini: courses.length,
      successfulDescriptions,
      failedDescriptions: courses.length - successfulDescriptions,
      batchesAttempted: totalBatches,
      batchesSuccessful: totalBatches - failedBatches,
      batchesFailed: failedBatches,
      batchErrors
    };
    console.debug('[University Scraper][gemini-courses] generation complete', output.descriptionSummary);
    return output;
  } catch (error) {
    sendProgress(`Gemini course descriptions could not be generated; leaving all descriptions blank (${error.message}).`);
    const unattemptedBatches = Math.max(0, totalBatches - failedBatches);
    output.descriptionBatchFailures = failedBatches + unattemptedBatches;
    output.descriptionBatchErrors = [...batchErrors, { message: error.message, phase: 'setup' }];
    output.descriptionSummary = {
      totalCourses: courses.length,
      coursesSentToGemini: 0,
      successfulDescriptions,
      failedDescriptions: courses.length - successfulDescriptions,
      batchesAttempted: failedBatches,
      batchesSuccessful: 0,
      batchesFailed: failedBatches + unattemptedBatches,
      batchErrors: output.descriptionBatchErrors
    };
    console.error('[University Scraper][gemini-courses] generation failed', output.descriptionSummary);
    return output;
  } finally {
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function validateDescriptionBatch(response, batch, batchId) {
  const expectedIndexes = batch.map((item) => item.index);
  const receivedIndexes = Array.isArray(response?.descriptions) ? response.descriptions.map((item) => item?.index) : [];
  console.debug('[University Scraper][gemini-courses] validating response', {
    batchId,
    expectedCount: expectedIndexes.length,
    receivedCount: receivedIndexes.length,
    expectedIndexes,
    receivedIndexes
  });
  if (!response || response.batch_id !== batchId || !Array.isArray(response.descriptions)) {
    console.error('[University Scraper][gemini-courses] unexpected response structure', { batchId, responseType: typeof response, responseBatchId: response?.batch_id });
    throw new Error('Gemini returned a malformed or mismatched description batch.');
  }
  const expected = new Set(batch.map((item) => item.index));
  const received = new Set();
  const duplicates = [];
  const invalid = [];
  const empty = [];
  for (const item of response.descriptions) {
    if (received.has(item?.index)) duplicates.push(item?.index);
    if (!Number.isInteger(item?.index) || !expected.has(item.index)) invalid.push(item?.index);
    if (typeof item?.description !== 'string' || !item.description.trim()) empty.push(item?.index);
    if (!Number.isInteger(item?.index) || !expected.has(item.index) || received.has(item.index) || typeof item.description !== 'string' || !item.description.trim()) {
      console.error('[University Scraper][gemini-courses] response validation detail', { batchId, duplicates, invalid, empty });
      throw new Error('Gemini returned an invalid description index or value.');
    }
    received.add(item.index);
  }
  const missing = expectedIndexes.filter((index) => !received.has(index));
  if (received.size !== expected.size) {
    console.error('[University Scraper][gemini-courses] response missing descriptions', { batchId, missing, duplicates, invalid, empty });
    throw new Error('Gemini omitted one or more requested descriptions.');
  }
  return response;
}

function waitForGeminiCourseResponse(tabId, batchId, retries) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    chrome.tabs.sendMessage(tabId, { type: 'READ_GEMINI_RESPONSE', expectedBatchId: batchId }, (response) => {
      const runtimeError = chrome.runtime.lastError?.message || '';
      console.debug('[University Scraper][gemini-courses] response poll', {
        batchId,
        retriesRemaining: retries,
        elapsedMs: Date.now() - startedAt,
        runtimeError,
        hasJson: Boolean(response?.json),
        hasDescriptions: Array.isArray(response?.json?.descriptions),
        batchIdMatches: response?.json?.batch_id === batchId,
        responseDiagnostics: response?.diagnostics || null
      });
      if (!runtimeError && response?.json?.batch_id === batchId && Array.isArray(response.json.descriptions)) {
        resolve(response.json);
        return;
      }
      if (retries > 0) {
        setTimeout(() => waitForGeminiCourseResponse(tabId, batchId, retries - 1).then(resolve, reject), 2000);
        return;
      }
      reject(new Error('No valid course description response was received from Gemini.'));
    });
  });
}

function requestGemini(tabId, message, retries) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (!chrome.runtime.lastError && response?.ok) {
        resolve(response);
        return;
      }
      if (retries > 0) {
        setTimeout(() => requestGemini(tabId, message, retries - 1).then(resolve, reject), 1000);
        return;
      }
      reject(new Error(chrome.runtime.lastError?.message || 'Gemini prompt box was not found.'));
    });
  });
}

function waitForGeminiResponse(tabId, retries) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'READ_GEMINI_RESPONSE' }, (response) => {
      if (!chrome.runtime.lastError && response?.json) {
        resolve(response.json);
        return;
      }
      if (retries > 0) {
        setTimeout(() => waitForGeminiResponse(tabId, retries - 1).then(resolve, reject), 2000);
        return;
      }
      reject(new Error('No raw JSON response was received from Gemini. Check login, prompt submission, and the response.'));
    });
  });
}

const UNIVERSITY_FACILITIES = [
  { name: 'Auditorium', query: 'auditorium' },
  { name: 'Library', query: 'library' },
  { name: 'Hostel', query: 'hostel' },
  { name: 'Food Department / Cafeteria', query: 'cafeteria food court mess' },
  { name: 'Sports Facilities', query: 'sports complex ground' },
  { name: 'Laboratories', query: 'laboratory labs' },
  { name: 'Classrooms', query: 'classroom lecture hall' },
  { name: 'Campus', query: 'campus building' }
];

async function scrapeGoogleImages(universityName) {
  if (/^amity university$/i.test(universityName.trim())) {
    throw new Error('Amity University ke saath campus/city bhi likhein, e.g. Amity University Noida.');
  }
  const results = await mapWithConcurrency(UNIVERSITY_FACILITIES, 4, async (facility) => {
    sendProgress(`Checking ${facility.name.toLowerCase()} availability...`);
    const verification = await verifyGoogleFacility(universityName, facility.query);
    if (!verification.available) return null;
    const images = await scrapeGoogleImageQuery(`"${universityName}" ${facility.query}`);
    return images.slice(0, 3).map((image) => ({ facility: facility.name, ...image }));
  });
  return results.flat().filter(Boolean);
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
  return results;
}

async function scrapeGoogleImageQuery(query) {
  const url = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`;
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id, 25000);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['google-images-content.js'] });
    return await requestGoogleImages(tab.id, 5);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function verifyGoogleFacility(universityName, facilityQuery) {
  const query = `${universityName} ${facilityQuery}`;
  const tab = await chrome.tabs.create({ url: `https://www.google.com/search?q=${encodeURIComponent(query)}`, active: false });
  try {
    await waitForTabComplete(tab.id, 25000);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['google-facility-content.js'] });
    return await requestGoogleFacilityVerification(tab.id, universityName, facilityQuery, 3);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function requestGoogleFacilityVerification(tabId, universityName, facilityQuery, retries) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'VERIFY_GOOGLE_FACILITY', universityName, facilityQuery }, (response) => {
      if (!chrome.runtime.lastError && response && typeof response.available === 'boolean') {
        resolve(response);
        return;
      }
      if (retries > 0) {
        setTimeout(() => requestGoogleFacilityVerification(tabId, universityName, facilityQuery, retries - 1).then(resolve, reject), 500);
        return;
      }
      reject(new Error(chrome.runtime.lastError?.message || 'Facility verification did not respond.'));
    });
  });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Page navigation timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    const finish = (error) => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      error ? reject(error) : resolve();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((currentTab) => {
      if (currentTab.status === 'complete') finish();
    }).catch(() => {});
  });
}

function navigateTabAndWait(tabId, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`University result navigation timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete' || settled) return;
      finish(null, tab?.url || '');
    };
    const finish = (error, value = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      error ? reject(error) : resolve(value);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }).catch((error) => finish(error));
  });
}

async function scrapeAllCoursesForUniversity(universityName, universityUrl = null) {
  sendProgress('University page found. Opening Courses & Fees...');
  const resolvedUrl = universityUrl || await findCollegeduniaUniversity(universityName);
  const coursesUrl = `${resolvedUrl.replace(/\/courses-fees\/?$/i, '').replace(/\/$/, '')}/courses-fees`;
  const tab = await chrome.tabs.create({ url: coursesUrl, active: true });
  try {
    console.debug('[University Scraper][background] course target created', { tabId: tab.id, url: coursesUrl });
    await waitForTabComplete(tab.id, 30000);
    console.debug('[University Scraper][background] course target loaded', await chrome.tabs.get(tab.id));
    sendProgress('Courses & Fees page loaded. Reading course cards...');
    await ensureCourseContentScript(tab.id);
    return await requestAllCourseCards(tab.id, 8, true);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function prepareSingleCourseSelection(universityName) {
  sendProgress('University page found. Loading selectable course cards...');
  const universityUrl = await findCollegeduniaUniversity(universityName);
  const coursesUrl = `${universityUrl.replace(/\/courses-fees\/?$/i, '').replace(/\/$/, '')}/courses-fees`;
  const tab = await chrome.tabs.create({ url: coursesUrl, active: false });
  try {
    await waitForTabComplete(tab.id, 30000);
    sendProgress('Courses & Fees page loaded. Reading course cards quickly...');
    await ensureCourseContentScript(tab.id);
    const cards = await requestAllCourseCards(tab.id, 8, false);
    sendProgress(`${cards.length} course cards ready. Choose a card; only that card will load its streams.`);
    return { tabId: tab.id, cards };
  } catch (error) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  }
}

function ensureCourseContentScript(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'PING' }, (response) => {
      if (!chrome.runtime.lastError && response?.ok) {
        console.debug('[University Scraper][background] course-content PING succeeded', { tabId, response });
        resolve();
        return;
      }
      console.warn('[University Scraper][background] course-content PING unavailable; injecting scripts', { tabId, error: chrome.runtime.lastError?.message, response });
      chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js', 'course-content.js', 'stream-content.js']
      })
        .then((result) => {
          console.debug('[University Scraper][background] course scripts injected', { tabId, result });
          verifyCourseContentScript(tabId, 5).then(() => resolve(result), reject);
        })
        .catch((error) => {
          console.error('[University Scraper][background] course script injection failed', { tabId, error: error.message });
          reject(error);
        });
    });
  });
}

function verifyCourseContentScript(tabId, retries) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'PING' }, (response) => {
      const error = chrome.runtime.lastError?.message || '';
      if (!error && response?.ok) {
        console.debug('[University Scraper][background] course-content listener verified', { tabId, response });
        resolve(response);
        return;
      }
      if (retries > 0) {
        setTimeout(() => verifyCourseContentScript(tabId, retries - 1).then(resolve, reject), 300);
        return;
      }
      reject(new Error(error || 'Course content script listener was not available after injection.'));
    });
  });
}

async function findCollegeduniaUniversity(universityName) {
  const cacheKey = universityName.trim().toLowerCase();
  const cachedUrl = universityUrlCache.get(cacheKey);
  if (cachedUrl) return cachedUrl;
  const query = `site:collegedunia.com/university/ "${universityName}" courses fees`;
  const searchTab = await chrome.tabs.create({
    url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    active: true
  });
  try {
    await waitForTabComplete(searchTab.id, 25000);
    const extractCandidates = () => chrome.scripting.executeScript({
      target: { tabId: searchTab.id },
      func: () => {
        const links = [...document.querySelectorAll('a[href]')]
          .map((link) => link.href)
          .map((href) => {
            try {
              const url = new URL(href);
              const redirect = url.searchParams.get('q') || url.searchParams.get('url');
              return redirect ? new URL(redirect).href : url.href;
            } catch { return ''; }
          })
          .filter((href) => {
            try {
              const url = new URL(href);
              return (url.hostname === 'collegedunia.com' && /^\/university\/[^/?#]+/i.test(url.pathname))
                || (url.hostname.endsWith('google.com') && /\/goto(?:$|\?)/i.test(url.pathname));
            } catch { return false; }
          });
        return [...new Set(links)].slice(0, 8);
      }
    }).then(([{ result }]) => result || []);
    let candidates = await extractCandidates();
    const candidateDeadline = Date.now() + 8000;
    while (!candidates.length && Date.now() < candidateDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      candidates = await extractCandidates();
    }
    if (!candidates?.length) throw new Error(`No Collegedunia university page found for "${universityName}".`);
    sendProgress('Collegedunia result found. Verifying the university page...');
    for (const candidate of candidates) {
      try {
        const navigatedUrl = await navigateTabAndWait(searchTab.id, candidate, 25000);
        const resolvedTab = await chrome.tabs.get(searchTab.id);
        const resolvedUrl = navigatedUrl || resolvedTab.url || '';
        const [{ result: valid }] = await chrome.scripting.executeScript({
          target: { tabId: searchTab.id },
          func: () => {
            const text = (document.body?.innerText || '').slice(0, 4000);
            return !/404\s*\n|page not found|someone is so lost|page you were looking for/i.test(text);
          }
        });
        if (valid && /^https:\/\/collegedunia\.com\/university\/[^/?#]+/i.test(resolvedUrl)) {
          const baseUrl = resolvedUrl.split(/[?#]/)[0].replace(/\/(?:courses-fees|ranking|placement)\/?$/i, '');
          universityUrlCache.set(cacheKey, baseUrl);
          return baseUrl;
        }
      } catch {
        // Try the next Google result when this university URL is stale.
      }
    }
    throw new Error(`No working Collegedunia university page was found for "${universityName}".`);
  } finally {
    await chrome.tabs.remove(searchTab.id).catch(() => {});
  }
}

function requestAllCourseCards(tabId, retries, includeStreams = false) {
  return new Promise((resolve, reject) => {
    console.debug('[University Scraper][background] sending SCRAPE_ALL_CARDS', { tabId, retries, includeStreams });
    chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_ALL_CARDS', includeStreams }, (response) => {
      const runtimeError = chrome.runtime.lastError?.message || '';
      console.debug('[University Scraper][background] SCRAPE_ALL_CARDS response', { tabId, retries, runtimeError, response });
      if (!chrome.runtime.lastError && Array.isArray(response?.cards) && response.cards.length > 0) {
        response.cards.collectionComplete = response.complete !== false;
        resolve(response.cards);
        return;
      }
      if (retries > 0) {
        setTimeout(() => requestAllCourseCards(tabId, retries - 1, includeStreams).then(resolve, reject), 700);
        return;
      }
      reject(new Error(runtimeError || response?.error || 'No course cards were found on the Courses & Fees page.'));
    });
  });
}

function requestGoogleImages(tabId, retries) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_GOOGLE_IMAGES' }, (response) => {
      if (!chrome.runtime.lastError && Array.isArray(response?.images) && response.images.length > 0) {
        resolve(response.images);
        return;
      }
      if (retries > 0) {
        setTimeout(() => requestGoogleImages(tabId, retries - 1).then(resolve, reject), 500);
        return;
      }
      reject(new Error(chrome.runtime.lastError?.message || 'Google Images scraper did not respond.'));
    });
  });
}

async function scrapeRankingPage(url) {
  sendProgress('Ranking page loaded. Reading ranking tables...');
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    return await waitForRankingPage(tab.id);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForRankingPage(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Ranking page timed out.')), 25000);
    const handleUpdate = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') sendRankingRequest(tabId, finish, 5);
    };
    const finish = (error, value = '') => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(handleUpdate);
      error ? reject(error) : resolve(value);
    };
    chrome.tabs.onUpdated.addListener(handleUpdate);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') sendRankingRequest(tabId, finish, 5);
    }).catch(() => {});
  });
}

function sendRankingRequest(tabId, finish, retries) {
  chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_RANKING' }, (response) => {
    if (!chrome.runtime.lastError && Array.isArray(response?.ranking) && response.ranking.length > 0) {
      finish(null, response.ranking);
      return;
    }
    if (retries > 0) {
      setTimeout(() => sendRankingRequest(tabId, finish, retries - 1), 700);
    } else {
      finish(new Error(response?.error || 'Ranking parser returned no ranking rows.'));
    }
  });
}

async function scrapePlacementPage(url) {
  sendProgress('Placement page loaded. Reading placement tables...');
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    return await waitForPlacementPage(tab.id);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForPlacementPage(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Placement page timed out.')), 25000);
    const handleUpdate = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') preparePlacementTab(tabId, finish);
    };
    const finish = (error, value = '') => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(handleUpdate);
      error ? reject(error) : resolve(value);
    };
    chrome.tabs.onUpdated.addListener(handleUpdate);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') preparePlacementTab(tabId, finish);
    }).catch(() => {});
  });
}

function preparePlacementTab(tabId, finish) {
  chrome.scripting.executeScript({ target: { tabId }, files: ['placement-content.js'] })
    .then(() => sendPlacementRequest(tabId, finish, 3))
    .catch((error) => finish(new Error(`Unable to inject placement scraper: ${error.message}`)));
}

function sendPlacementRequest(tabId, finish, retries) {
  chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_PLACEMENT' }, (response) => {
    if (!chrome.runtime.lastError && response?.placement) {
      finish(null, response.placement);
      return;
    }
    if (!chrome.runtime.lastError && response?.error) {
      finish(new Error(`Placement parser failed: ${response.error}`));
      return;
    }
    if (retries <= 0) {
      const reason = chrome.runtime.lastError?.message || 'No response from placement scraper.';
      finish(new Error(`Unable to read placement data: ${reason}`));
      return;
    }
    const retry = () => setTimeout(() => sendPlacementRequest(tabId, finish, retries - 1), 400);
    retry();
  });
}

async function scrapeAllCourseDetails(courses, runId) {
  const allDiscoveredStreams = courses.flatMap((card) => card.courses || []);
  const allStreams = [...new Map(allDiscoveredStreams
    .map((course, index) => [canonicalStreamKey(course, index), course])).values()];
  sendProgress(`Starting detail pages for ${allStreams.length} streams across ${courses.length} course cards...`);
  const detailsByUrl = new Map();
  let completedStreams = 0;
  await mapWithConcurrency(allStreams, STREAM_SCRAPE_CONCURRENCY, async (stream) => {
    if (runId !== activeAllCourseDetailsRun) throw new Error('This stream scrape was superseded by a newer run.');
    try {
      if (!isSupportedCourseUrl(stream.url)) throw new Error('This stream has no supported Collegedunia URL.');
      const details = await scrapeCourseWithRetry(stream, 2);
      detailsByUrl.set(canonicalStreamKey(stream), { details });
    } catch (error) {
      detailsByUrl.set(canonicalStreamKey(stream), { details: null, scrapeError: error.message });
    }
    completedStreams += 1;
    chrome.runtime.sendMessage({
      type: 'ALL_COURSE_DETAILS_PROGRESS',
      completed: completedStreams,
      total: allStreams.length,
      course: stream.name,
      concurrent: STREAM_SCRAPE_CONCURRENCY
    }).catch(() => {});
  });
  const detailsSucceeded = [...detailsByUrl.values()].filter((value) => value.details).length;
  const detailsFailed = allStreams.length - detailsSucceeded;
  const streamExtractionFailures = courses.filter((course) => Number(course.streamCount) > 0 && !(course.courses || []).length).length;
  const enrichedCourses = await generateCourseDescriptions(courses);
  const preparedCourses = courses.map((course, index) => enrichedCourses[index] || course);
  const detailedCourses = preparedCourses.map((card) => ({
    ...card,
    courses: (card.courses || []).map((stream, index) => ({ ...stream, ...(detailsByUrl.get(canonicalStreamKey(stream, index)) || { scrapeError: 'Stream was not processed.' }) }))
  }));
  const describedCourses = await generateStreamDescriptions(detailedCourses);
  const streamDescriptions = describedCourses.flatMap((card) => card.courses || []).filter((stream) => stream.details?.description).length;
  return {
    courses: describedCourses,
    completeness: {
      parentCoursesDiscovered: courses.length,
      parentCoursesExported: describedCourses.length,
      streamsDiscovered: allDiscoveredStreams.length,
      uniqueStreamUrls: allStreams.filter((stream) => isSupportedCourseUrl(stream.url)).length,
      streamPagesSucceeded: detailsSucceeded,
      streamPagesFailed: detailsFailed,
      streamExtractionFailures,
      courseDescriptionBatchesFailed: enrichedCourses.descriptionBatchFailures || 0,
      streamDescriptionBatchesFailed: describedCourses.descriptionBatchFailures || 0,
      complete: courses.collectionComplete !== false && courses.length === describedCourses.length
        && detailsFailed === 0 && streamExtractionFailures === 0
        && !enrichedCourses.descriptionBatchFailures && !describedCourses.descriptionBatchFailures
    }
  };
}

function canonicalStreamKey(stream, index = 0) {
  try {
    const url = new URL(stream?.url || '', 'https://collegedunia.com');
    url.hash = '';
    return `${url.href.replace(/\/$/, '').toLowerCase()}|${String(stream?.name || '').trim().toLowerCase()}`;
  } catch {
    return `missing-url|${String(stream?.name || '').trim().toLowerCase()}`;
  }
}

async function generateStreamDescriptions(courseCards) {
  const streams = [...new Map(courseCards.flatMap((card) => card.courses || [])
    .filter((stream) => stream.details && !stream.scrapeError)
    .map((stream, index) => [canonicalStreamKey(stream, index), stream])).values()];
  if (!streams.length) return courseCards;
  sendProgress(`Opening Gemini to write ${streams.length} stream descriptions...`);
  const descriptionsByUrl = new Map();
  let failedBatches = 0;
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: true });
    await waitForTabComplete(tab.id, 30000);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['gemini-content.js'] });
    const batchSize = 6;
    for (let start = 0; start < streams.length; start += batchSize) {
      const batchId = `${Date.now()}-${start}`;
      const batch = streams.slice(start, start + batchSize).map((stream, offset) => ({
        index: start + offset,
        stream_name: stream.name || stream.details.stream_name || '',
        course: stream.details.course || '',
        duration: stream.details.duration || '',
        mode: stream.details.mode || '',
        intake: stream.details.intake || '',
        tuition_fee: stream.details.tuition_fee || '',
        hostel_fee: stream.details.hostel_fee || '',
        admission_fee: stream.details.admission_fee || '',
        total_fee: stream.details.total_fee || '',
        min_fee: stream.details.min_fee || '',
        max_fee: stream.details.max_fee || '',
        seat_availability: stream.details.seat_availability || '',
        min_qualification: stream.details.min_qualification || '',
        min_percentage: stream.details.min_percentage || '',
        entrance_exams: stream.details.entrance_exams || '',
        admission_status: stream.details.admissionStatus || '',
        admission_dates: stream.details.admission_dates || []
      }));
      try {
        await requestGemini(tab.id, { type: 'FILL_STREAM_DESCRIPTION_PROMPT', batchId, streams: batch }, 5);
        const response = validateDescriptionBatch(await waitForGeminiCourseResponse(tab.id, batchId, 60), batch, batchId);
        for (const item of response.descriptions || []) {
          const stream = streams[item.index];
          if (stream && typeof item.description === 'string') descriptionsByUrl.set(stream.url, item.description.trim());
        }
      } catch (error) {
        failedBatches += 1;
        sendProgress(`Gemini stream descriptions batch ${Math.floor(start / batchSize) + 1} failed; leaving those descriptions blank.`);
      }
      chrome.runtime.sendMessage({
        type: 'STREAM_DESCRIPTIONS_PROGRESS',
        completed: Math.min(start + batch.length, streams.length),
        total: streams.length
      }).catch(() => {});
    }
  } catch (error) {
    sendProgress(`Gemini stream descriptions could not be generated; leaving descriptions blank (${error.message}).`);
  } finally {
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
  }
  const output = courseCards.map((card) => ({
    ...card,
    courses: (card.courses || []).map((stream) => ({
      ...stream,
      details: stream.details ? { ...stream.details, description: descriptionsByUrl.get(stream.url) || '' } : stream.details
    }))
  }));
  output.descriptionBatchFailures = failedBatches;
  return output;
}

async function scrapeCourseDetails(courses, parentUrl, courseCard = {}) {
  sendProgress(`Starting detail pages for ${courses.length} streams...`);
  const output = [];
  const uniqueCourses = [...new Map(courses.filter((course) => course.url).map((course, index) => [canonicalStreamKey(course, index), course])).values()];
  let completed = 0;
  await mapWithConcurrency(uniqueCourses, SINGLE_CARD_SCRAPE_CONCURRENCY, async (course) => {
    if (!course.url.startsWith('https://collegedunia.com/')) return;
    try {
      const details = await scrapeCourseWithRetry(course, 2);
      output.push({ ...course, details });
    } catch (error) {
      output.push({ ...course, details: null, scrapeError: error.message });
    }
    completed += 1;
    chrome.runtime.sendMessage({ type: 'DETAILS_PROGRESS', completed, total: uniqueCourses.length, course: course.name, concurrent: SINGLE_CARD_SCRAPE_CONCURRENCY }).catch(() => {});
  });
  const [streamCard] = await generateStreamDescriptions([{ courses: output }]);
  return { courses: streamCard?.courses || output, parentDetails: null };
}

async function scrapeCourseWithRetry(course, attempts) {
  if (!isSupportedCourseUrl(course.url)) throw new Error('This stream link is not a supported Collegedunia page.');
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const tab = await chrome.tabs.create({ url: course.url, active: false });
    try {
      await waitForTabComplete(tab.id, 45000);
      await ensureDetailContentScript(tab.id);
      return await waitForDetailPage(tab.id, course);
    } catch (error) {
      lastError = error;
    } finally {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
  throw lastError || new Error('Unable to scrape course page.');
}

function ensureDetailContentScript(tabId) {
  return chrome.tabs.get(tabId).then((tab) => {
    if (!isSupportedCourseUrl(tab.url)) throw new Error('The stream page is not a supported Collegedunia page.');
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, (response) => {
      if (!chrome.runtime.lastError && response?.ok) {
        resolve();
        return;
      }
      chrome.scripting.executeScript({ target: { tabId }, files: ['content.js', 'stream-content.js'] })
        .then(resolve)
        .catch(reject);
      });
    });
  });
}

function isSupportedCourseUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && (parsed.hostname === 'collegedunia.com' || parsed.hostname.endsWith('.collegedunia.com'));
  } catch {
    return false;
  }
}

function waitForDetailPage(tabId, course) {
  return new Promise((resolve, reject) => {
    let requestStarted = false;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Detail page timed out.')), 25000);
    const handleUpdate = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') requestOnce();
    };
    const finish = (error, value = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(handleUpdate);
      error ? reject(error) : resolve(value);
    };
    const requestOnce = () => {
      if (requestStarted || settled) return;
      requestStarted = true;
      sendDetailRequest(tabId, finish, 5, course);
    };
    chrome.tabs.onUpdated.addListener(handleUpdate);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') requestOnce();
    }).catch(() => {});
  });
}

function sendDetailRequest(tabId, finish, retries, course) {
  chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_DETAIL_PAGE', fallback: course }, (response) => {
    if (!chrome.runtime.lastError && isUsableStreamDetails(response?.details)) {
      finish(null, response.details);
      return;
    }
    if (retries > 0) {
      setTimeout(() => sendDetailRequest(tabId, finish, retries - 1, course), 1000);
      return;
    }
    finish(new Error(chrome.runtime.lastError?.message || `No details were returned for ${course.name || 'this stream'}.`));
  });
}

function isUsableStreamDetails(details) {
  if (!details || typeof details !== 'object') return false;
  const populatedFields = [
    details.duration,
    details.mode,
    details.intake,
    details.tuition_fee,
    details.hostel_fee,
    details.admission_fee,
    details.total_fee,
    details.min_qualification,
    details.min_percentage,
    details.entrance_exams,
    details.admissionStatus,
    Array.isArray(details.admission_dates) && details.admission_dates.length ? 'dates' : ''
  ].filter(Boolean).length;
  return populatedFields >= 2;
}
