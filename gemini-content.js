(() => {
  const PROMPT_TEMPLATE = `Search and retrieve verified, real-time data for "{{UNIVERSITY_NAME}}" strictly referencing top education portals like Shiksha.com, Collegedunia.com, Careers360, and its official university website.

Return ONLY a raw JSON object (no setup conversational text) with these exact keys:

{
  "about": "Detailed about university summary based on top directory profiles",
  "why_choose_us": "Key USPs, NIRF rankings, placement records, and infrastructure highlights",
  "established": "Year of establishment (e.g. 2010)",
  "university_type": "Private University",
  "website_url": "Official website URL",
  "chancellor": "Name of Chancellor/Vice Chancellor",
  "campus_area": "Campus size in acres (e.g. 70 Acres)",
  "total_students": "Total enrolled students count (e.g. 25000)",
  "faculty": "Total faculty strength (e.g. 1000+)",
  "exams_accepted": "Exact list of accepted entrance exams as listed on Shiksha/Collegedunia",
  "application_fee": "Actual application fee amount in numbers (e.g. 1000)",
  "naac_score": "Latest NAAC Grade (e.g. A+)",
  "district": "District location",
  "state": "State location",
  "full_address": "Complete official campus physical address",
  "accreditations": ["UGC Approved", "NAAC A+", "AICTE Approved"],
  "scholarships": [{"title": "Exact Official Scholarship Name", "badge": "Merit / Sports / SC-ST", "description": "Specific criteria and fee waiver percentage", "priority": "1"}]
}`;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'FILL_GEMINI_PROMPT') {
      const prompt = PROMPT_TEMPLATE.replace('{{UNIVERSITY_NAME}}', message.universityName);
      fillPrompt(prompt)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, message: error.message }));
      return true;
    }
    if (message.type === 'FILL_COURSE_DESCRIPTION_PROMPT') {
      const prompt = buildCourseDescriptionPrompt(message.batchId, message.courses);
      fillPrompt(prompt)
        .then((diagnostics) => sendResponse({ ok: true, diagnostics }))
        .catch((error) => sendResponse({ ok: false, message: error.message }));
      return true;
    }
    if (message.type === 'FILL_STREAM_DESCRIPTION_PROMPT') {
      fillPrompt(buildStreamDescriptionPrompt(message.batchId, message.streams))
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, message: error.message }));
      return true;
    }
    if (message.type === 'READ_GEMINI_RESPONSE') {
      const result = findJsonResponse(message.expectedBatchId || '');
      sendResponse({ json: result.json, diagnostics: result.diagnostics });
    }
  });

  async function fillPrompt(prompt) {
    const input = document.querySelector('textarea[placeholder], textarea') || document.querySelector('[contenteditable="true"]');
    if (!input) throw new Error('Gemini prompt box was not found. Check Gemini login or page loading.');
    if (input.matches('textarea')) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, prompt);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      input.textContent = prompt;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    }
    input.focus();
    await waitForSendButtonAndClick(45000);
    return { promptChars: prompt.length, submittedAt: new Date().toISOString() };
  }

  async function waitForSendButtonAndClick(timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const sendButton = [...document.querySelectorAll('button')].find((button) => {
        const label = [button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-testid'), button.getAttribute('mattooltip')]
          .filter(Boolean).join(' ');
        return /send|submit/i.test(label) && !button.disabled && button.getAttribute('aria-busy') !== 'true';
      });
      if (sendButton) {
        sendButton.click();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Gemini send button was not ready after 45 seconds.');
  }

  function buildCourseDescriptionPrompt(batchId, courses) {
    return `Write natural, human-sounding, SEO-friendly English descriptions for the following university courses. Return exactly 80 to 120 words for each description. Use only the supplied metadata, do not invent rankings, placements, eligibility, facilities, career outcomes, or other facts. Do not mention Collegedunia, Gemini, AI, prompts, or these instructions. Each course variant must receive its own description, even when names repeat. Return ONLY a raw JSON object in this exact shape: {"batch_id":"${batchId}","descriptions":[{"index":0,"description":"..."}]}. Preserve every supplied index exactly once. Course metadata: ${JSON.stringify(courses)}`;
  }

  function buildStreamDescriptionPrompt(batchId, streams) {
    return `Write natural, human-sounding, SEO-friendly English descriptions for these university course streams. Return exactly 80 to 120 words for each stream. Use only the supplied dedicated-stream-page metadata. Do not invent rankings, placements, facilities, career outcomes, eligibility, seats, fees, dates, or other facts. Do not mention Collegedunia, Gemini, AI, prompts, or these instructions. Keep every stream variant separate and preserve each supplied index exactly once. Return ONLY a raw JSON object in this exact shape: {"batch_id":"${batchId}","descriptions":[{"index":0,"description":"..."}]}. Stream metadata: ${JSON.stringify(streams)}`;
  }

  function findJsonResponse(expectedBatchId = '') {
    const blocks = [...document.querySelectorAll('pre, code, .markdown, [data-message-author-role="model"]')];
    const diagnostics = { blockCount: blocks.length, responseBodyLength: 0, candidates: false, content: false, parts: false, finishReason: '', truncated: false, blocked: false, parseError: '', rawStart: '', rawEnd: '' };
    for (const block of blocks.reverse()) {
      const text = (block.innerText || block.textContent || '').trim();
      if (!text) continue;
      diagnostics.responseBodyLength = Math.max(diagnostics.responseBodyLength, text.length);
      diagnostics.candidates = true;
      diagnostics.content = true;
      diagnostics.parts = true;
      diagnostics.truncated = /truncated|incomplete|stopped before|maximum token/i.test(text);
      diagnostics.blocked = /blocked|safety|could not generate|can't help|unable to comply/i.test(text);
      diagnostics.rawStart = text.slice(0, 240);
      diagnostics.rawEnd = text.slice(-240);
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) continue;
      try {
        const json = JSON.parse(match[0]);
        if (!expectedBatchId || json?.batch_id === expectedBatchId) {
          console.debug('[University Scraper][gemini-content] JSON response extracted', { expectedBatchId, ...diagnostics, rawTextLength: match[0].length });
          return { json, diagnostics: { ...diagnostics, rawTextLength: match[0].length } };
        }
      } catch (error) {
        diagnostics.parseError = error.message;
        console.warn('[University Scraper][gemini-content] JSON response parse failed', { expectedBatchId, ...diagnostics });
      }
    }
    console.warn('[University Scraper][gemini-content] no matching JSON response', { expectedBatchId, ...diagnostics });
    return { json: null, diagnostics };
  }
})();
