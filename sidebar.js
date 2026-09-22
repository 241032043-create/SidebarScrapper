const selectorInput = document.querySelector('#selector-input');
const pickButton = document.querySelector('#pick-button');
const scrapeButton = document.querySelector('#scrape-button');
const resultsBox = document.querySelector('#results');
const resultCount = document.querySelector('#result-count');
const targetState = document.querySelector('#target-state');
const selectorHint = document.querySelector('#selector-hint');
const copyButton = document.querySelector('#copy-button');

let lastResults = [];

chrome.storage.local.get(['selectors', 'selector'], ({ selectors, selector }) => {
  const savedSelectors = selectors?.length ? selectors : (selector ? [selector] : []);
  if (savedSelectors.length) selectorInput.value = savedSelectors.join('\n');
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'selector-picked') return;
  const selectors = getSelectors();
  if (!selectors.includes(message.selector)) selectors.push(message.selector);
  selectorInput.value = selectors.join('\n');
  targetState.textContent = 'Selected';
  selectorHint.textContent = `${selectors.length} selector${selectors.length === 1 ? '' : 's'} selected. Keep picking or scrape the combined results.`;
  chrome.storage.local.set({ selectors, selector: selectors[0] });
});

function getSelectors() {
  return selectorInput.value.split('\n').map((selector) => selector.trim()).filter(Boolean);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active tab is available.');
  return tab;
}

pickButton.addEventListener('click', async () => {
  pickButton.disabled = true;
  targetState.textContent = 'Pick on page';
  selectorHint.textContent = 'Move over an element, then click to select it.';
  try {
    const tab = await getActiveTab();
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: startPicker });
  } catch (error) {
    showError(error.message || 'Could not start the page picker. Try a regular webpage tab.');
    targetState.textContent = 'Error';
  } finally {
    pickButton.disabled = false;
  }
});

scrapeButton.addEventListener('click', async () => {
  const selectors = getSelectors();
  if (!selectors.length) return showError('Enter a CSS selector or pick an element first.');
  scrapeButton.disabled = true;
  targetState.textContent = 'Scraping';
  try {
    const tab = await getActiveTab();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractText,
      args: [selectors]
    });
    if (result?.error) throw new Error(result.error);
    renderResults(result || []);
    chrome.storage.local.set({ selectors, selector: selectors[0] });
    targetState.textContent = result?.length ? 'Complete' : 'No matches';
  } catch (error) {
    showError(error.message || 'Could not scrape this page.');
    targetState.textContent = 'Error';
  } finally {
    scrapeButton.disabled = false;
  }
});

copyButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(lastResults.join('\n'));
  copyButton.textContent = 'Copied';
  setTimeout(() => { copyButton.textContent = 'Copy results'; }, 1200);
});

function renderResults(items) {
  lastResults = items;
  resultCount.textContent = items.length;
  copyButton.disabled = !items.length;
  if (!items.length) {
    resultsBox.innerHTML = '<div class="empty-state"><span class="empty-icon" aria-hidden="true">×</span><p>No elements matched this selector.</p></div>';
    return;
  }
  const fragment = document.createDocumentFragment();
  items.forEach((text, index) => {
    const row = document.createElement('div');
    row.className = 'result-item';
    row.innerHTML = `<span class="result-number">${String(index + 1).padStart(2, '0')}</span><span class="result-text"></span>`;
    row.querySelector('.result-text').textContent = text;
    fragment.appendChild(row);
  });
  resultsBox.replaceChildren(fragment);
}

function showError(message) {
  lastResults = [];
  resultCount.textContent = '0';
  copyButton.disabled = true;
  resultsBox.innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function startPicker() {
  if (window.__sidebarScraperPicker) return;
  window.__sidebarScraperPicker = true;
  const previousCursor = document.documentElement.style.cursor;
  const previousOutline = new Map();
  const dynamicClass = /^(jsx|css|sc|emotion|styled|ng-|svelte-|astro-|_[a-z0-9]{5,}|[a-z0-9]{1,4}_[a-z0-9]{5,})/i;
  const stableClass = (name) => name && name.length < 50 && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name) && !dynamicClass.test(name);
  const cssEscape = (value) => window.CSS?.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');

  function getCleanSelector(element) {
    if (element.id && /^[a-zA-Z][\w-]*$/.test(element.id)) {
      const idSelector = `#${cssEscape(element.id)}`;
      if (document.querySelectorAll(idSelector).length === 1) return idSelector;
    }
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.body) {
      let part = current.tagName.toLowerCase();
      const classes = [...current.classList].filter(stableClass).slice(0, 3);
      const classSelector = classes.length ? `${part}${classes.map((name) => `.${cssEscape(name)}`).join('')}` : '';
      if (classSelector && document.querySelectorAll(classSelector).length > 1) return classSelector;
      if (classes.length) part = classSelector;
      const siblings = current.parentElement ? [...current.parentElement.children].filter((child) => child.tagName === current.tagName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      const candidate = parts.join(' > ');
      if (document.querySelectorAll(candidate).length === 1) return candidate;
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function highlight(event) {
    const element = event.target;
    if (!(element instanceof Element)) return;
    if (!previousOutline.has(element)) previousOutline.set(element, element.style.outline);
    element.style.outline = '2px solid #0c7772';
  }
  function unhighlight(event) {
    const element = event.target;
    if (element instanceof Element && previousOutline.has(element)) element.style.outline = previousOutline.get(element);
  }
  function choose(event) {
    event.preventDefault();
    event.stopPropagation();
    const selector = getCleanSelector(event.target);
    chrome.runtime.sendMessage({ type: 'selector-picked', selector });
  }
  function cancel(event) {
    if (event.key === 'Escape') cleanup();
  }
  function cleanup() {
    document.removeEventListener('mouseover', highlight, true);
    document.removeEventListener('mouseout', unhighlight, true);
    document.removeEventListener('click', choose, true);
    document.removeEventListener('keydown', cancel, true);
    previousOutline.forEach((outline, element) => { element.style.outline = outline; });
    document.documentElement.style.cursor = previousCursor;
    window.__sidebarScraperPicker = false;
  }
  document.documentElement.style.cursor = 'crosshair';
  document.addEventListener('mouseover', highlight, true);
  document.addEventListener('mouseout', unhighlight, true);
  document.addEventListener('click', choose, true);
  document.addEventListener('keydown', cancel, true);
}

function extractText(selector) {
  try {
    const selectors = Array.isArray(selector) ? selector : [selector];
    return selectors.flatMap((currentSelector) => [...document.querySelectorAll(currentSelector)])
      .map((element) => element.innerText.trim()).filter(Boolean);
  } catch (error) {
    return { error: `Invalid CSS selector: ${error.message}` };
  }
}
