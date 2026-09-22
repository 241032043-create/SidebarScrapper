(() => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'SCRAPE_RANKING') return;
    extractRankingData().then((ranking) => sendResponse?.({ ranking })).catch((error) => sendResponse?.({ error: error.message || 'Ranking parser failed.' }));
    return true;
  });

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function extractRankingData() {
    await revealRankingContent();
    const pageTitle = normalize(document.querySelector('h1')?.innerText || document.title || '');
    const universityName = pageTitle.replace(/\s+Ranking(?:\s+20\d{2})?.*$/i, '').replace(/\s+Ranking\s+20\d{2}:.*$/i, '').trim();
    const agencies = [
      { type: 'NIRF', match: 'NIRF', body: 'Ministry Of Education, India' },
      { type: 'India Today', match: 'India Today', body: 'India Today' },
      { type: 'Outlook', match: 'Outlook India', body: 'Outlook India' },
      { type: 'IIRF', match: 'IIRF', body: 'IIRF' },
      { type: 'TOI', match: 'The Times Of India', body: 'The Times Of India' },
      { type: 'NIRF Innovation', match: 'National Institutional Ranking Framework Innovation', body: 'National Institutional Ranking Framework Innovation' },
      { type: 'QS', match: 'QS World University', body: 'QS World University' },
      { type: 'Collegedunia', match: 'Collegedunia.com', body: 'Collegedunia.com' }
    ];
    const entries = [];
    const pageText = normalize(document.body?.innerText || '');
    for (const agency of agencies) {
      const pattern = new RegExp(`${escapeRegExp(universityName)}\\s+([^.!?]{1,100}?)\\s+ranking\\s+by\\s+${escapeRegExp(agency.match)}\\s+is\\s+([\\d-]+)\\s+out\\s+of\\s+[\\d,]+[^.]*?in\\s+(20\\d{2})(?:\\s+and\\s+it\\s+was\\s+([\\d-]+)[^.]*?in\\s+(20\\d{2}))?`, 'gi');
      let match;
      while ((match = pattern.exec(pageText))) {
        const stream = normalize(match[1]);
        if (/ranking|top streams|top agencies|compare|courses|fees/i.test(stream)) continue;
        entries.push({ agency, stream, rank: match[2], year: match[3], previousRank: match[4] || '' });
      }
    }
    const tableAgencies = [
      { heading: 'Collegedunia Ranking', type: 'Collegedunia', body: 'Collegedunia.com' }, { heading: 'Indiatoday Ranking', type: 'India Today', body: 'India Today' },
      { heading: 'NIRF Ranking', type: 'NIRF', body: 'Ministry Of Education, India' }, { heading: 'Outlook Ranking', type: 'Outlook', body: 'Outlook India' },
      { heading: 'IIRF Ranking', type: 'IIRF', body: 'IIRF' }, { heading: 'TOI Ranking', type: 'TOI', body: 'The Times Of India' },
      { heading: 'NIRF Innovation Ranking', type: 'NIRF Innovation', body: 'National Institutional Ranking Framework Innovation' }, { heading: 'QS Ranking', type: 'QS', body: 'QS World University' }
    ];
    const rankingTables = [...document.querySelectorAll('#listing-article table, .cdcms_ranking table')];
    for (const [tableIndex, table] of rankingTables.entries()) {
      const context = normalize(table.parentElement?.innerText || table.innerText);
      const scope = table.closest('#listing-article, section, article');
      const heading = [...(scope?.querySelectorAll('h2, h3, h4') || [])]
        .find((element) => element.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING);
      const headingText = normalize(heading?.innerText || context);
      const agency = tableAgencies.find((candidate) => new RegExp(candidate.type.replace(/\s+/g, '\\s*'), 'i').test(`${headingText} ${context}`))
        || ([0, 1].includes(tableIndex) ? tableAgencies.find((candidate) => candidate.type === 'NIRF') : null)
        || (tableIndex === 2 ? tableAgencies.find((candidate) => candidate.type === 'India Today') : null);
      if (!agency) continue;
      const rows = [...table.querySelectorAll('tbody tr')];
      const headerCells = [...(rows.shift()?.children || [])].map((cell) => normalize(cell.innerText));
      const headerYears = headerCells.map((text) => text.match(/20\d{2}/)?.[0] || '');
      for (const row of rows) {
        const cells = [...row.children].map((cell) => normalize(cell.innerText));
        const stream = cells[0]?.replace(/\s*Compare\s*$/i, '').trim();
        if (!stream) continue;
        const rankedCells = cells.slice(1).map((text, index) => {
          const match = text.match(/#?\s*([\d-]+(?:st|nd|rd|th)?)\s*(?:out\s+of\s+[\d,]+\s+in\s+(?:India|International)\s+)?(20\d{2})?/i);
          return match ? { rank: match[1].replace(/(?:st|nd|rd|th)$/i, ''), year: match[2] || headerYears[index + 1] || `20${25 - index}`, index } : null;
        }).filter(Boolean);
        rankedCells.forEach((current) => { const previous = rankedCells.find((candidate) => candidate.index > current.index); entries.push({ agency, stream, rank: current.rank, year: current.year, previousRank: previous?.rank || '' }); });
      }
    }
    const unique = new Map(entries.map((entry) => [`${entry.agency.type}|${entry.stream}|${entry.year}|${entry.rank}`, entry]));
    return [...unique.values()].map((entry) => {
      const rank = Number.parseInt(entry.rank, 10); const previous = Number.parseInt(entry.previousRank, 10); const change = Number.isFinite(rank) && Number.isFinite(previous) ? `${previous - rank >= 0 ? '+' : ''}${previous - rank}` : 'N/A'; const band = entry.rank.includes('-');
      return { university_name: universityName, ranking_year: entry.year, ranking_type: entry.agency.type, ranking_body: entry.agency.body, rank_position: entry.rank, previous_rank: entry.previousRank || 'N/A', change, stream: entry.stream, score: 'N/A', subtitle: band ? `Placed in the official ${entry.rank} rank band` : `Ranked ${entry.rank} in the official ${entry.agency.type} ranking`, highlight: band ? `Secured a position within the official ${entry.rank} ${entry.agency.type} rank band.` : `Secured rank ${entry.rank} in the official ${entry.agency.type} ranking.` };
    });
  }

  async function revealRankingContent() {
    for (const headingText of ['Top Streams:', 'Top Agencies:']) {
      const heading = [...document.querySelectorAll('h2, h3, h4')].find((element) => normalize(element.innerText) === headingText);
      const control = heading?.parentElement?.nextElementSibling?.querySelector('button');
      if (control && /^All$/i.test(normalize(control.innerText)) && !control.classList.contains('active')) { control.click(); await wait(500); }
    }
    const originalPosition = window.scrollY; let previousHeight = 0;
    for (let attempt = 0; attempt < 30; attempt += 1) { window.scrollTo(0, document.body.scrollHeight); await wait(350); const height = document.body.scrollHeight; if (height === previousHeight && window.innerHeight + window.scrollY >= height - 5) break; previousHeight = height; }
    window.scrollTo(0, originalPosition); await wait(250);
  }
})();
