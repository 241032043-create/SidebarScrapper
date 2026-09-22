let latestData = null;
let latestAllCourses = [];

const selectButton = document.querySelector('#selectCard');
const scrapeAllButton = document.querySelector('#scrapeAllCourses');
const scrapeRankingButton = document.querySelector('#scrapeRanking');
const scrapePlacementButton = document.querySelector('#scrapePlacement');
const scrapeGoogleImagesButton = document.querySelector('#scrapeGoogleImages');
const scrapeEverythingButton = document.querySelector('#scrapeEverything');
const workflowPipeline = document.querySelector('#workflowPipeline');
const universityNameInput = document.querySelector('#universityNameInput');
const universitySuggestions = document.querySelector('#universitySuggestions');
const singleCardPicker = document.querySelector('#singleCardPicker');
const singleCardOptions = document.querySelector('#singleCardOptions');
const statusElement = document.querySelector('#status');
const resultElement = document.querySelector('#result');
const allCoursesResult = document.querySelector('#allCoursesResult');
const titleElement = document.querySelector('#courseTitle');
const summaryElement = document.querySelector('#summary');
const coursesElement = document.querySelector('#courses');
const countElement = document.querySelector('#courseCount');
const allCoursesCount = document.querySelector('#allCoursesCount');
const allCoursesList = document.querySelector('#allCoursesList');
const statusDot = document.querySelector('#statusDot');
const activityLog = document.querySelector('#activityLog');
const detailButton = document.querySelector('#scrapeDetails');
const fetchAllDescriptionsButton = document.querySelector('#fetchAllDescriptions');
const rankingResult = document.querySelector('#rankingResult');
const rankingJson = document.querySelector('#rankingJson');
const copyRankingButton = document.querySelector('#copyRankingJson');
const placementResult = document.querySelector('#placementResult');
const placementJson = document.querySelector('#placementJson');
const copyPlacementButton = document.querySelector('#copyPlacementJson');
const googleImagesResult = document.querySelector('#googleImagesResult');
const googleImagesJson = document.querySelector('#googleImagesJson');
const copyGoogleImagesButton = document.querySelector('#copyGoogleImagesJson');
const downloadGoogleImagesButton = document.querySelector('#downloadGoogleImages');
const googleImagesCards = document.querySelector('#googleImagesCards');
const openOverviewButton = document.querySelector('#openOverview');
const overviewResult = document.querySelector('#overviewResult');
const overviewJson = document.querySelector('#overviewJson');
const copyOverviewButton = document.querySelector('#copyOverviewJson');
const admissionButton = document.querySelector('#admissionNav');
let latestRanking = null;
let latestPlacement = null;
let latestGoogleImages = null;
let latestOverview = null;
let activeWorkflowStep = null;
let fullScrapeRunning = false;
let currentStatusMessage = '';
let statusStartedAt = 0;

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

function renderLiveStatus() {
  statusElement.textContent = currentStatusMessage
    ? `${currentStatusMessage} (${formatElapsed(Date.now() - statusStartedAt)})`
    : '';
}

setInterval(renderLiveStatus, 1000);

function resetWorkflowPipeline() {
  workflowPipeline.classList.remove('hidden');
  activeWorkflowStep = null;
  workflowPipeline.querySelectorAll('.workflow-step').forEach((step) => {
    step.className = 'workflow-step';
    step.querySelector('.workflow-state').textContent = 'Waiting';
    step.querySelector('small').textContent = '';
  });
}

function setWorkflowStep(stepName, state, message = '') {
  const step = workflowPipeline.querySelector(`[data-workflow-step="${stepName}"]`);
  if (!step) return;
  step.classList.remove('is-running', 'is-success', 'is-error');
  if (state) step.classList.add(`is-${state}`);
  step.querySelector('.workflow-state').textContent = state === 'running' ? 'In progress' : state === 'success' ? 'Successfully scraped' : state === 'error' ? 'Scrape failed' : 'Waiting';
  step.querySelector('small').textContent = message;
  if (state === 'running') activeWorkflowStep = stepName;
}

function setWorkflowControlsDisabled(disabled) {
  document.querySelectorAll('.button-group button').forEach((button) => { button.disabled = disabled; });
}

function waitForRuntimeMessage(type, errorType, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`${type} timed out.`)), timeoutMs);
    function finish(error, message) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);
      error ? reject(error) : resolve(message);
    }
    const listener = (message) => {
      if (message.type === errorType) {
        finish(new Error(message.message || `${type} failed.`));
        return;
      }
      if (message.type !== type) return;
      finish(null, message);
    };
    chrome.runtime.onMessage.addListener(listener);
  });
}

async function runWorkflowStage(stepName, start, resultType, errorType, successMessage, timeoutMs = 120000) {
  setWorkflowStep(stepName, 'running');
  try {
    const resultPromise = waitForRuntimeMessage(resultType, errorType, timeoutMs);
    await start(1);
    const result = await resultPromise;
    setWorkflowStep(stepName, 'success', typeof successMessage === 'function' ? successMessage(result) : successMessage);
    return result;
  } catch (error) {
    setWorkflowStep(stepName, 'error', error.message || `${stepName} failed.`);
    setStatus(`${stepName} failed. Continuing to the next step.`, 'error');
    return null;
  }
}

async function runFullScrape() {
  const universityName = getUniversityName();
  if (!universityName) {
    setStatus('Enter a university or campus name.', 'error');
    universityNameInput.focus();
    return;
  }
  setWorkflowControlsDisabled(true);
  resetWorkflowPipeline();
  fullScrapeRunning = true;
  const files = {};
  let coursesStreamsComplete = true;
  try {
    setStatus('1/7 Fetching university overview...');
    const overviewMessage = await runWorkflowStage('overview', () => chrome.runtime.sendMessage({ type: 'FETCH_GEMINI_OVERVIEW', universityName }), 'GEMINI_OVERVIEW_RESULT', 'GEMINI_OVERVIEW_ERROR', 'Overview JSON ready.');
    if (overviewMessage) files['university-overview.json'] = overviewMessage.overview;

    setStatus('2/7 Scraping all parent courses and streams...');
    const coursesMessage = await runWorkflowStage('courses', () => chrome.runtime.sendMessage({ type: 'SCRAPE_ALL_COURSES_FOR_UNIVERSITY', universityName }), 'ALL_COURSES_RESULT', 'ALL_COURSES_ERROR', () => `${latestAllCourses.length} parent course cards found.`);
    if (!coursesMessage || !latestAllCourses.length) throw new Error('No parent courses were discovered.');
    const detailsMessage = await runWorkflowStage('streams', () => chrome.runtime.sendMessage({ type: 'SCRAPE_ALL_COURSE_DETAILS', courses: latestAllCourses }), 'ALL_COURSE_DETAILS_RESULT', 'ALL_COURSE_DETAILS_ERROR', (result) => {
      const summary = result.completeness;
      return summary?.complete ? `${summary.streamPagesSucceeded} stream pages ready.` : `Incomplete: ${summary?.streamPagesFailed || 0} stream pages failed.`;
    }, 600000);
    if (!detailsMessage) throw new Error('Courses and streams processing did not complete.');
    latestAllCourses = detailsMessage.courses || latestAllCourses;
    files['all-courses.json'] = latestAllCourses.map(toSingleCourseFormat);
    files['all-streams.json'] = latestAllCourses.flatMap((course) => (course.courses || []).map(toStreamExport));
    coursesStreamsComplete = detailsMessage.completeness?.complete === true;
    if (!coursesStreamsComplete) {
      setWorkflowStep('streams', 'error', 'Incomplete; failed records were retained in the export.');
      setStatus('Courses + Streams export is incomplete; failed records were retained.', 'error');
    }

    setStatus('3-5/7 Scraping ranking, images, and placement in parallel...');
    const [rankingMessage, imagesMessage, placementMessage] = await Promise.all([
      runWorkflowStage('ranking', () => chrome.runtime.sendMessage({ type: 'SCRAPE_RANKING_PAGE', universityName }), 'RANKING_RESULT', 'RANKING_ERROR', (result) => `${result.ranking?.length || 0} ranking rows ready.`),
      runWorkflowStage('images', () => chrome.runtime.sendMessage({ type: 'SCRAPE_GOOGLE_IMAGES', universityName }), 'GOOGLE_IMAGES_RESULT', 'GOOGLE_IMAGES_ERROR', (result) => `${result.images?.length || 0} image records ready.`),
      runWorkflowStage('placement', () => chrome.runtime.sendMessage({ type: 'SCRAPE_PLACEMENT_PAGE', universityName }), 'PLACEMENT_RESULT', 'PLACEMENT_ERROR', 'Placement JSON ready.')
    ]);
    if (rankingMessage) files['nirf-ranking.json'] = rankingMessage.ranking;
    if (imagesMessage) files['university-images.json'] = imagesMessage.images;
    if (placementMessage) files['placement-data.json'] = placementMessage.placement;

    setStatus('6/7 Checking admission data availability...');
    setWorkflowStep('admission', 'running', 'Checking admission scraper...');
    files['admission-data.json'] = {
      university: universityName,
      status: 'The admission scraper is not configured yet.'
    };
    setWorkflowStep('admission', 'waiting', 'Admission scraper is not configured yet.');
    activeWorkflowStep = null;

    setStatus('7/7 All data collected. Preparing the university JSON folder...');
    await downloadJsonBundle(universityName, files);
    setStatus(coursesStreamsComplete
      ? `${universityName} JSON folder downloaded successfully.`
      : `${universityName} JSON folder downloaded with incomplete Courses + Streams data.`, coursesStreamsComplete ? 'success' : 'error');
  } catch (error) {
    if (activeWorkflowStep) setWorkflowStep(activeWorkflowStep, 'error', error.message);
    setStatus(`Complete scrape stopped: ${error.message}`, 'error');
  } finally {
    fullScrapeRunning = false;
    setWorkflowControlsDisabled(false);
  }
}

function sanitizeFolderName(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'university';
}

async function downloadJsonBundle(universityName, files) {
  const folder = sanitizeFolderName(universityName);
  const entries = Object.entries(files).map(([name, value]) => ({
    name: `${folder}/${name}`,
    data: new TextEncoder().encode(JSON.stringify(value, null, 2))
  }));
  const zip = createStoredZip(entries);
  const blob = new Blob([zip], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename: `${folder}.zip`,
      conflictAction: 'uniquify',
      saveAs: false
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const checksum = crc32(entry.data);
    const local = new Uint8Array(30 + name.length + entry.data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x800, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, entry.data.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x800, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  return joinUint8Arrays([...localParts, ...centralParts, end]);
}

function joinUint8Arrays(parts) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ (0xedb88320 & -(checksum & 1));
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

scrapeEverythingButton.addEventListener('click', runFullScrape);

function setStatus(message, tone = 'default') {
  currentStatusMessage = message;
  statusStartedAt = Date.now();
  renderLiveStatus();
  statusDot.style.background = tone === 'error' ? '#d64545' : tone === 'success' ? '#078b52' : '#f0a120';
  if (message && activityLog) {
    const item = document.createElement('li');
    item.textContent = message;
    activityLog.prepend(item);
    while (activityLog.children.length > 5) activityLog.lastElementChild.remove();
  }
}

function getUniversityName() {
  return universityNameInput.value.trim();
}

async function fetchOverview() {
  const universityName = getUniversityName();
  if (!universityName) {
    setStatus('Enter a university or campus name.', 'error');
    universityNameInput.focus();
    return;
  }
  openOverviewButton.disabled = true;
  setStatus('Fetching a verified university overview from Gemini...');
  try {
    await chrome.runtime.sendMessage({ type: 'FETCH_GEMINI_OVERVIEW', universityName });
  } catch (error) {
    openOverviewButton.disabled = false;
    setStatus(`Could not start Gemini: ${error.message}`, 'error');
  }
}

openOverviewButton.addEventListener('click', fetchOverview);

admissionButton.addEventListener('click', () => {
  setStatus('The admission scraper is not configured yet.', 'default');
});

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function ensureInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  }
}

selectButton.addEventListener('click', async () => {
  if (latestData) {
    selectButton.disabled = true;
    setStatus('Showing the already loaded course cards...');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SHOW_CACHED_SINGLE_COURSE_CARDS' });
      if (!response?.ok) throw new Error(response?.message || 'The cached course cards are no longer available.');
      renderSingleCardOptions(response.cards || []);
      singleCardPicker.classList.remove('hidden');
      resultElement.classList.add('hidden');
      selectButton.disabled = false;
      setStatus('Choose another course card. Its streams will load after selection.');
    } catch (error) {
      selectButton.disabled = false;
      setStatus(error.message, 'error');
    }
    return;
  }
  const universityName = getUniversityName();
  if (!universityName) {
    setStatus('Enter a university or campus name.', 'error');
    universityNameInput.focus();
    return;
  }
  selectButton.disabled = true;
  setStatus(`Finding the Collegedunia Courses & Fees page for ${universityName}...`);
  try {
    const response = await chrome.runtime.sendMessage({ type: 'PREPARE_SINGLE_COURSE_SELECTION', universityName });
    if (!response?.ok) throw new Error(response?.message || 'Could not load course cards.');
    renderSingleCardOptions(response.cards || []);
    singleCardPicker.classList.remove('hidden');
    setStatus(response.cards?.length ? 'Choose a course card below to continue.' : 'No course cards were detected on the page.', response.cards?.length ? 'default' : 'error');
  } catch (error) {
    selectButton.disabled = false;
    setStatus(`Could not load course cards: ${error.message}`, 'error');
  }
});

singleCardOptions.addEventListener('click', async (event) => {
  const option = event.target.closest('[data-card-index]');
  if (!option) return;
  singleCardOptions.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  setStatus(`Opening ${option.dataset.cardTitle || 'the selected course'}...`);
  try {
    const response = await chrome.runtime.sendMessage({ type: 'SELECT_SINGLE_COURSE', index: Number(option.dataset.cardIndex) });
    if (!response?.ok) throw new Error(response?.message || 'The selected course could not be opened.');
  } catch (error) {
    singleCardOptions.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    setStatus(`Could not select the course card: ${error.message}`, 'error');
  }
});

scrapeAllButton.addEventListener('click', async () => {
  const universityName = getUniversityName();
  if (!universityName) {
    setStatus('Enter a university or campus name.', 'error');
    universityNameInput.focus();
    return;
  }
  try {
    setStatus(`Finding the Collegedunia Courses & Fees page for ${universityName}...`);
    scrapeAllButton.disabled = true;
    await chrome.runtime.sendMessage({ type: 'SCRAPE_ALL_COURSES_FOR_UNIVERSITY', universityName });
  } catch (error) {
    scrapeAllButton.disabled = false;
    setStatus(`Could not start the course scrape: ${error.message}`, 'error');
  }
});

scrapeRankingButton.addEventListener('click', async () => {
  try {
    const universityName = getUniversityName();
    if (!universityName) {
      setStatus('Enter a university or campus name first.', 'error');
      universityNameInput.focus();
      return;
    }
    scrapeRankingButton.disabled = true;
    setStatus(`Finding the ranking page for ${universityName}...`);
    await chrome.runtime.sendMessage({ type: 'SCRAPE_RANKING_PAGE', universityName });
  } catch {
    scrapeRankingButton.disabled = false;
    setStatus('Could not start the ranking scrape.', 'error');
  }
});

scrapePlacementButton.addEventListener('click', async () => {
  try {
    const universityName = getUniversityName();
    if (!universityName) {
      setStatus('Enter a university or campus name first.', 'error');
      universityNameInput.focus();
      return;
    }
    scrapePlacementButton.disabled = true;
    setStatus(`Finding the placement page for ${universityName}...`);
    await chrome.runtime.sendMessage({ type: 'SCRAPE_PLACEMENT_PAGE', universityName });
  } catch {
    scrapePlacementButton.disabled = false;
    setStatus('Could not start the placement scrape.', 'error');
  }
});

async function scrapeGoogleImages() {
  const universityName = getUniversityName();
  if (!universityName) {
    setStatus('Enter a university or campus name.', 'error');
    universityNameInput.focus();
    return;
  }
  scrapeGoogleImagesButton.disabled = true;
  setStatus('Collecting university images from Google Images...');
  try {
    await chrome.runtime.sendMessage({ type: 'SCRAPE_GOOGLE_IMAGES', universityName });
  } catch (error) {
    scrapeGoogleImagesButton.disabled = false;
    setStatus(`Could not start the Google Images scrape: ${error.message}`, 'error');
  }
}

scrapeGoogleImagesButton.addEventListener('click', scrapeGoogleImages);
universityNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') fetchOverview();
});

let suggestionTimer = null;
universityNameInput.addEventListener('input', () => {
  clearTimeout(suggestionTimer);
  const query = universityNameInput.value.trim();
  if (query.length < 2) {
    universitySuggestions.classList.add('hidden');
    universitySuggestions.innerHTML = '';
    return;
  }
  suggestionTimer = setTimeout(async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_UNIVERSITY_SUGGESTIONS', query });
      renderUniversitySuggestions(response?.suggestions || []);
    } catch {
      universitySuggestions.classList.add('hidden');
    }
  }, 220);
});

function renderUniversitySuggestions(suggestions) {
  universitySuggestions.innerHTML = suggestions.slice(0, 6).map((suggestion) =>
    `<button class="suggestion" type="button" role="option">${escapeHtml(suggestion)}</button>`
  ).join('');
  universitySuggestions.classList.toggle('hidden', !suggestions.length);
}

universitySuggestions.addEventListener('click', (event) => {
  const suggestion = event.target.closest('.suggestion');
  if (!suggestion) return;
  universityNameInput.value = suggestion.textContent;
  universitySuggestions.classList.add('hidden');
  universityNameInput.focus();
  setStatus(`Selected ${suggestion.textContent}. Choose an action to continue.`);
});

fetchAllDescriptionsButton.addEventListener('click', async () => {
  if (!latestAllCourses.length) return;
  fetchAllDescriptions();
});

async function fetchAllDescriptions() {
  fetchAllDescriptionsButton.disabled = true;
  setStatus('Fetching descriptions from all course detail pages...');
  await chrome.runtime.sendMessage({
    type: 'SCRAPE_ALL_PARENT_DESCRIPTIONS',
    courses: latestAllCourses
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SCRAPE_PROGRESS') {
    setStatus(message.message);
    if (activeWorkflowStep) setWorkflowStep(activeWorkflowStep, 'running', message.message);
  }
  if (message.type === 'SELECTION_STARTED') {
    setStatus('Choose a course card from the page.');
  }
  if (message.type === 'SCRAPE_STARTED') {
    setStatus('Expanding the selected card and collecting courses...');
  }
  if (message.type === 'SCRAPE_RESULT') {
    latestData = message.data;
    singleCardPicker.classList.add('hidden');
    selectButton.disabled = false;
    renderResult(message.data);
    detailButton.disabled = message.data.courses.length === 0;
    setStatus(`${message.data.courses.length} streams collected. Fetching stream details...`);
    selectButton.textContent = 'Select another card';
    if (message.data.courses.length) fetchCourseDetails();
  }
  if (message.type === 'SCRAPE_ERROR') {
    singleCardPicker.classList.add('hidden');
    selectButton.disabled = false;
    setStatus(message.message, 'error');
  }
  if (message.type === 'DETAILS_RESULT') {
    const detailsByUrl = new Map(message.courses.map((course) => [course.url, { details: course.details, scrapeError: course.scrapeError }]));
    latestData.courses = latestData.courses.map((course) => ({ ...course, ...(detailsByUrl.get(course.url) || {}) }));
    latestData.parentDetails = message.parentDetails || null;
    renderResult(latestData);
    detailButton.disabled = false;
    setStatus('Course detail page data collected.', 'success');
  }
  if (message.type === 'DETAILS_ERROR') {
    detailButton.disabled = false;
    setStatus(`Detail scraping incomplete: ${message.message}`, 'error');
  }
  if (message.type === 'DETAILS_PROGRESS') {
    setStatus(`Detail pages: ${message.completed}/${message.total} processed...`);
  }
  if (message.type === 'ALL_DESCRIPTIONS_PROGRESS') {
    setStatus(`Descriptions: ${message.completed}/${message.total} (${message.title || ''})...`);
  }
  if (message.type === 'COURSE_DESCRIPTIONS_PROGRESS') {
    const phase = message.phase === 'failed' ? 'failed' : 'completed';
    const batchText = message.batch ? `Batch ${message.batch}/${message.totalBatches}: ${phase}. ` : '';
    setStatus(`Gemini descriptions: ${batchText}${message.completed}/${message.total} courses (${formatElapsed(message.elapsedMs || 0)} total).`);
    if (activeWorkflowStep === 'streams') setWorkflowStep('streams', 'running', `Gemini descriptions: ${batchText}${message.completed}/${message.total} processed.`);
  }
  if (message.type === 'ALL_COURSE_DETAILS_PROGRESS') {
    setStatus(`Streams: ${message.completed}/${message.total} (${message.course || ''})...`);
    if (activeWorkflowStep === 'streams') setWorkflowStep('streams', 'running', `Streams: ${message.completed}/${message.total} processed...`);
  }
  if (message.type === 'ALL_COURSE_DETAILS_RESULT') {
    latestAllCourses = Array.isArray(message.courses) ? message.courses : latestAllCourses;
    renderAllCourses(latestAllCourses);
    if (message.completeness && !message.completeness.complete) {
      setStatus(`Courses + Streams incomplete: ${message.completeness.streamPagesFailed} stream pages failed.`, 'error');
    }
  }
  if (message.type === 'ALL_COURSES_RESULT') {
    scrapeAllButton.disabled = false;
    latestAllCourses = Array.isArray(message.cards) ? message.cards : [];
    renderAllCourses(latestAllCourses);
    if (latestAllCourses.length) {
      if (!fullScrapeRunning) fetchAllDescriptions();
    } else {
      setStatus('No valid parent course cards were found on the Courses & Fees page.', 'error');
    }
  }
  if (message.type === 'ALL_COURSES_ERROR') {
    scrapeAllButton.disabled = false;
    setStatus(`Course scraping failed: ${message.message}`, 'error');
  }
  if (message.type === 'ALL_DESCRIPTIONS_RESULT') {
    latestAllCourses = message.courses;
    renderAllCourses(latestAllCourses);
    fetchAllDescriptionsButton.disabled = false;
    setStatus(`All descriptions updated (${latestAllCourses.length} courses)!`, 'success');
  }
  if (message.type === 'ALL_DESCRIPTIONS_ERROR') {
    if (Array.isArray(message.courses)) {
      latestAllCourses = message.courses;
      renderAllCourses(latestAllCourses);
    }
    fetchAllDescriptionsButton.disabled = false;
    const failed = message.summary?.failedDescriptions;
    setStatus(`Descriptions fetch incomplete: ${message.message}${Number.isInteger(failed) ? ` ${failed} descriptions missing.` : ''}`, 'error');
  }
  if (message.type === 'RANKING_RESULT') {
    latestRanking = Array.isArray(message.ranking) ? message.ranking : [message.ranking];
    rankingJson.textContent = JSON.stringify(latestRanking, null, 2);
    rankingResult.classList.remove('hidden');
    scrapeRankingButton.disabled = false;
    setStatus(`${latestRanking.length} rankings collected.`, 'success');
  }
  if (message.type === 'RANKING_ERROR') {
    scrapeRankingButton.disabled = false;
    setStatus(`Ranking scrape incomplete: ${message.message}`, 'error');
  }
  if (message.type === 'PLACEMENT_RESULT') {
    latestPlacement = message.placement;
    placementJson.textContent = JSON.stringify(latestPlacement, null, 2);
    placementResult.classList.remove('hidden');
    scrapePlacementButton.disabled = false;
    setStatus('Placement data collected.', 'success');
  }
  if (message.type === 'PLACEMENT_ERROR') {
    scrapePlacementButton.disabled = false;
    setStatus(`Placement scrape incomplete: ${message.message}`, 'error');
  }
  if (message.type === 'GOOGLE_IMAGES_RESULT') {
    latestGoogleImages = message.images;
    googleImagesJson.textContent = JSON.stringify(latestGoogleImages, null, 2);
    renderGoogleImageCards(latestGoogleImages);
    googleImagesResult.classList.remove('hidden');
    scrapeGoogleImagesButton.disabled = false;
    setStatus(`${latestGoogleImages.length} university images collected.`, 'success');
  }
  if (message.type === 'GOOGLE_IMAGES_ERROR') {
    scrapeGoogleImagesButton.disabled = false;
    setStatus(`Google Images scrape incomplete: ${message.message}`, 'error');
  }
  if (message.type === 'GEMINI_OVERVIEW_RESULT') {
    latestOverview = message.overview;
    overviewJson.textContent = JSON.stringify(latestOverview, null, 2);
    overviewResult.classList.remove('hidden');
    openOverviewButton.disabled = false;
    setStatus('Gemini overview JSON collected.', 'success');
  }
  if (message.type === 'GEMINI_OVERVIEW_ERROR') {
    openOverviewButton.disabled = false;
    setStatus(`Gemini overview incomplete: ${message.message}`, 'error');
  }
});

copyRankingButton.addEventListener('click', async () => {
  if (!latestRanking) return;
  await navigator.clipboard.writeText(JSON.stringify(latestRanking, null, 2));
  setStatus('Ranking JSON copied to the clipboard.', 'success');
});

copyPlacementButton.addEventListener('click', async () => {
  if (!latestPlacement) return;
  await navigator.clipboard.writeText(JSON.stringify(latestPlacement, null, 2));
  setStatus('Placement JSON copied to the clipboard.', 'success');
});

copyGoogleImagesButton.addEventListener('click', async () => {
  if (!latestGoogleImages) return;
  await navigator.clipboard.writeText(JSON.stringify(latestGoogleImages, null, 2));
  setStatus('Google Images JSON copied to the clipboard.', 'success');
});

copyOverviewButton.addEventListener('click', async () => {
  if (!latestOverview) return;
  await navigator.clipboard.writeText(JSON.stringify(latestOverview, null, 2));
  setStatus('Overview JSON copied to the clipboard.', 'success');
});

downloadGoogleImagesButton.addEventListener('click', async () => {
  if (!latestGoogleImages?.length) return;
  downloadGoogleImagesButton.disabled = true;
  try {
    await Promise.all(latestGoogleImages.map((item) => chrome.runtime.sendMessage({ type: 'DOWNLOAD_GOOGLE_IMAGE', image: item.image, heading: item.heading, facility: item.facility })));
    setStatus('Downloads for all facility images have started.', 'success');
  } catch (error) {
    setStatus(`Images could not be downloaded: ${error.message}`, 'error');
  } finally {
    downloadGoogleImagesButton.disabled = false;
  }
});

function renderGoogleImageCards(images) {
  googleImagesCards.innerHTML = images.map((item, index) => `
    <article class="google-image-card">
      <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.heading)}" loading="lazy">
      <div class="google-image-card-body">
        <strong>${escapeHtml(item.facility || 'University facility')}</strong>
        <p>${escapeHtml(item.heading)}</p>
        <small>${item.width || 0} x ${item.height || 0}</small>
        <button class="icon-button download-image-button" data-image-index="${index}" type="button">Download image</button>
      </div>
    </article>`).join('');
  googleImagesCards.querySelectorAll('.download-image-button').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = latestGoogleImages[Number(button.dataset.imageIndex)];
      if (!item) return;
      await chrome.runtime.sendMessage({ type: 'DOWNLOAD_GOOGLE_IMAGE', image: item.image, heading: item.heading, facility: item.facility });
      setStatus(`${item.facility} image download started.`, 'success');
    });
  });
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

async function fetchCourseDetails() {
  try {
    if (!latestData?.courses.length) return;
    detailButton.disabled = true;
    setStatus('Opening stream pages and collecting complete details...');
    const response = await chrome.runtime.sendMessage({
      type: 'SCRAPE_COURSE_DETAILS',
      parentUrl: latestData.parentUrl,
      courses: latestData.courses,
      courseCard: { title: latestData.title, summary: latestData.summary, courses: latestData.courses }
    });
    if (!response?.ok) throw new Error(response?.message || 'The stream detail scrape could not start.');
  } catch {
    setStatus('Could not start detail scraping.', 'error');
    detailButton.disabled = false;
  }
}

detailButton.addEventListener('click', fetchCourseDetails);

function renderSingleCardOptions(cards) {
  singleCardOptions.innerHTML = cards.length
    ? cards.map((card, index) => {
      const summary = card.summary || {};
      const metadata = [summary.duration, summary.fees, summary.mode].filter(Boolean).join(' • ');
      return `<button class="single-card-option" type="button" data-card-index="${index}" data-card-title="${escapeHtml(card.title)}">
        <span class="single-card-option-title">${escapeHtml(card.title || 'Untitled course')}</span>
        <span class="single-card-option-meta">${escapeHtml(metadata || 'Course details available')} • ${card.streamCount || card.courses?.length || 0} streams available</span>
      </button>`;
    }).join('')
    : '<p class="empty">No selectable course cards were found on the Courses & Fees page.</p>';
}

function renderResult(data) {
  allCoursesResult.classList.add('hidden');
  resultElement.classList.remove('hidden');
  titleElement.textContent = data.title || 'Untitled course';
  countElement.textContent = data.courses.length;
  summaryElement.innerHTML = Object.entries(data.summary)
    .filter(([, value]) => value)
    .map(([label, value]) => `<div class="summary-row"><span class="summary-label">${escapeHtml(label)}</span><span class="summary-value">${escapeHtml(value)}</span></div>`)
    .join('');
  coursesElement.innerHTML = data.courses.length
    ? data.courses.map((course) => `<article class="course-row"><p class="course-name">${escapeHtml(course.name)}</p><div class="course-meta"><span>${escapeHtml(course.rating || course.views || 'Details captured')}</span><span class="course-fee">${escapeHtml(course.fee || 'Fee not found')}</span></div>${course.details ? `<p class="course-detail">${escapeHtml(formatDetails(course.details))}</p>` : course.scrapeError ? `<p class="course-detail">${escapeHtml(course.scrapeError)}</p>` : ''}</article>`).join('')
    : '<p class="empty">No courses found in the expanded section.</p>';
}

function renderAllCourses(cards) {
  resultElement.classList.add('hidden');
  allCoursesResult.classList.remove('hidden');
  allCoursesCount.textContent = cards.length;

  allCoursesList.innerHTML = cards.length
    ? cards.map((card) => {
      const obj = toSingleCourseFormat(card);
      return `<article class="course-row">
        <p class="course-name" style="font-size: 13px; font-weight: 700;">${escapeHtml(card.title)}</p>
        <div class="course-meta" style="margin-top: 4px;">
          <span>${escapeHtml(obj.duration || 'Duration N/A')} • ${escapeHtml(obj.course_type)}</span>
          <span class="course-fee">${escapeHtml(obj.total_fees || 'Fee not found')}</span>
        </div>
        <div class="course-meta" style="margin-top: 4px; font-size: 10px; color: var(--muted);">
          <span>${escapeHtml(obj.category)} (${escapeHtml(obj.degree_level)})</span>
          <span>Status: ${escapeHtml(obj.admission_status || 'Open')}</span>
        </div>
        ${obj.description ? `<p class="course-detail">${escapeHtml(obj.description)}</p>` : ''}
      </article>`;
    }).join('')
    : '<p class="empty">No course cards found on the page.</p>';
}

function formatDetails(details) {
  if (typeof details === 'string') return details;
  return Object.entries(details).filter(([, value]) => value && (!Array.isArray(value) || value.length))
    .map(([label, value]) => {
      if (!Array.isArray(value) && typeof value === 'object') return `${label}: ${formatDetails(value)}`;
      if (!Array.isArray(value)) return `${label}: ${value}`;
      return `${label}: ${value.map((row) => typeof row === 'object' ? `${row.component || row.category} = ${row.amount || row.seats}` : row).join('; ')}`;
    }).join(' | ');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

document.querySelector('#copyJson').addEventListener('click', async () => {
  if (!latestData) return;
  const exportData = {
    course: toParentCourseExport(latestData),
    streams: latestData.courses.map(toStreamExport)
  };
  await navigator.clipboard.writeText(JSON.stringify(exportData, null, 2));
  setStatus('JSON copied to the clipboard.', 'success');
});

document.querySelector('#copyAllJson').addEventListener('click', async () => {
  if (!latestAllCourses.length) return;
  const exportData = latestAllCourses.map(toSingleCourseFormat);
  await navigator.clipboard.writeText(JSON.stringify(exportData, null, 2));
  setStatus(`JSON for ${exportData.length} courses copied to the clipboard!`, 'success');
});

function toParentCourseExport(data) {
  const title = data.title || '';
  const courseName = inferCourseName(title);
  const levelInfo = card.summary?.category || card.summary?.degree_level
    ? { category: card.summary.category || '', degree_level: card.summary.degree_level || '' }
    : inferCategoryAndLevel(title);
  const admissionStatus = data.courses.map((course) => course.details?.admissionStatus || '').find(Boolean) || (data.summary?.applicationDate ? 'Open' : '');
  return {
    course_name: courseName,
    category: levelInfo.category,
    degree_level: levelInfo.degree_level,
    course_type: normalizeStudyType(data.summary?.mode) || 'Full-time',
    duration: normalizeDuration(data.summary?.duration || ''),
    total_fees: data.summary?.fees || '',
    mode: inferDeliveryMode(data.summary?.mode),
    admission_status: admissionStatus ? admissionStatus.charAt(0).toUpperCase() + admissionStatus.slice(1).toLowerCase() : '',
    description: data.parentDetails?.description || ''
  };
}

function toSingleCourseFormat(card) {
  const title = card.title || '';
  const courseName = inferCourseName(title);
  const summary = card.summary || {};
  const duration = normalizeDuration(summary.duration || '');
  const courseType = normalizeStudyType(summary.mode) || 'Full-time';
  const totalFees = summary.fees || '';
  const mode = inferDeliveryMode(summary.mode);
  const levelInfo = inferCategoryAndLevel(title);
  const status = inferAdmissionStatus(summary.applicationDate || '') || (summary.applicationDate ? 'Open' : '');

  return {
    course_name: courseName,
    category: levelInfo.category,
    degree_level: levelInfo.degree_level,
    course_type: courseType,
    duration: duration,
    total_fees: totalFees,
    mode: mode,
    admission_status: status ? (status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()) : '',
    description: card.description || ''
  };
}

function toStreamExport(course) {
  const details = course.details && typeof course.details === 'object' ? course.details : toEmptyStreamExport(course);
  return {
    stream_name: details.stream_name || course.name || '',
    course: details.course || inferCourseName(course.name || ''),
    duration: details.duration || '',
    mode: normalizeDeliveryMode(details.mode),
    intake: details.intake || '',
    description: details.description || '',
    tuition_fee: details.tuition_fee || '',
    hostel_fee: details.hostel_fee || '',
    admission_fee: details.admission_fee || '',
    total_fee: details.total_fee || '',
    min_fee: details.min_fee || '',
    max_fee: details.max_fee || '',
    seat_availability: details.seat_availability || '',
    age_limit: details.age_limit || '',
    seat_distribution: details.seat_distribution || [],
    min_qualification: details.min_qualification || '',
    min_percentage: details.min_percentage || '',
    entrance_exams: Array.isArray(details.entrance_exams) ? details.entrance_exams : details.entrance_exams ? [details.entrance_exams] : [],
    admission_status: details.admissionStatus || '',
    admission_dates: details.admission_dates || [],
    source_url: details.source_url || course.url || ''
  };
}

function toEmptyStreamExport(course) {
  return {
    stream_name: course.name || '',
    course: inferCourseName(course.name || ''),
    duration: '',
    mode: '',
    intake: '',
    description: '',
    tuition_fee: '',
    hostel_fee: '',
    admission_fee: '',
    total_fee: '',
    min_fee: '',
    max_fee: '',
    seat_availability: '',
    age_limit: '',
    seat_distribution: [],
    min_qualification: '',
    min_percentage: '',
    entrance_exams: [],
    admission_status: '',
    admission_dates: [],
    source_url: course.url || ''
  };
}

function inferCourseName(value) {
  const str = String(value || '').trim();
  const bracketMatch = str.match(/\[([^\]]+)\]/);
  const suffixMatch = bracketMatch && str.slice(bracketMatch.index + bracketMatch[0].length).match(/^\s*(?:\{([^}]+)\}|\(([^)]+)\))/);
  if (bracketMatch) {
    const base = bracketMatch[1].trim();
    const suffix = suffixMatch?.[1] || suffixMatch?.[2];
    if (suffix) {
      return `${base} (${suffix.trim()})`;
    }
    return base;
  }
  const integratedMatch = str.match(/\b(BBA|BCA|BA|B\.?Com|B\.?Tech)\s*\+\s*(MBA|MCA|LLB)\b/i);
  if (integratedMatch) return `${integratedMatch[1]} + ${integratedMatch[2]}`;
  const match = str.match(/\b(B\.?Tech|B\.?E\.?|B\.?Sc|MBA|M\.?Tech|MBBS|BCA|BBA|MCA|B\.?Com|B\.?A|M\.?A|M\.?Sc|Ph\.?D)\b/i);
  return match ? match[1].replace(/\./g, '.') : str;
}

function inferCategoryAndLevel(title) {
  const t = String(title).toLowerCase();
  if (/\b(m\.?tech|mba|mca|m\.?sc|m\.?com|m\.?des|m\.?arch|llm|m\.?pharm|mpt|md|ms|master)\b/i.test(t)) {
    return { category: 'Post Graduation', degree_level: 'Masters' };
  }
  if (/\b(ph\.?d|doctorate|m\.?phil)\b/i.test(t)) {
    return { category: 'Doctorate', degree_level: 'Doctorate' };
  }
  if (/\b(pg diploma|post graduate diploma)\b/i.test(t)) {
    return { category: 'PG Diploma', degree_level: 'PG Diploma' };
  }
  if (/\b(diploma|polytechnic)\b/i.test(t)) {
    return { category: 'Diploma', degree_level: 'Diploma' };
  }
  if (/\b(b\.?tech|b\.?e\.?|b\.?sc|bba|bca|b\.?com|b\.?a\.?|ba|mbbs|bachelor)\b/i.test(t)) {
    return { category: 'Graduation', degree_level: 'Bachelors' };
  }
  return { category: '', degree_level: '' };
}

function normalizeDuration(value) {
  const match = String(value).match(/(\d+)\s*[- ]?year/i);
  return match ? `${match[1]} Years` : String(value || '');
}

function normalizeStudyType(value) {
  if (/part\s*[- ]?time/i.test(String(value))) return 'Part-time';
  if (/online|distance/i.test(String(value))) return 'Online';
  if (/full\s*[- ]?time/i.test(String(value))) return 'Full-time';
  return '';
}

function inferDeliveryMode(value) {
  if (/online|distance/i.test(String(value))) return 'Online';
  return 'Offline';
}

function normalizeDeliveryMode(value) {
  if (/online|distance/i.test(String(value))) return 'Online';
  if (/offline|on[- ]?campus|full[- ]?time|part[- ]?time/i.test(String(value))) return 'Full-time';
  return '';
}

function inferAdmissionStatus(value) {
  const match = String(value).match(/\b(open|closed|ongoing)\b/i);
  return match ? match[1] : '';
}
