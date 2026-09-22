(() => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'SCRAPE_PLACEMENT') return;
    extractPlacementData()
      .then((placement) => sendResponse?.({ placement }))
      .catch((error) => sendResponse?.({ error: error.message || 'Placement parser failed.' }));
    return true;
  });

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  async function extractPlacementData() {
    const pageTitle = normalize(document.querySelector('h1')?.innerText || document.title || '');
    const universityName = pageTitle.replace(/\s+Placement(?:\s+20\d{2})?.*$/i, '').trim();
    const summary = {};
    const universitySummary = {};
    const yearlyStats = [];
    const collegeStats = [];
    const recruiters = new Set();
    const tablesData = [];

    for (const table of document.querySelectorAll('table')) {
      const rows = [...table.querySelectorAll('tr')]
        .map((row) => [...row.children].map((cell) => normalize(cell.innerText)))
        .filter((row) => row.some(Boolean));
      if (rows.length < 2) continue;
      const headers = rows[0];
      const body = rows.slice(1);
      const sectionHeading = findSectionHeading(table);
      tablesData.push({ headers, rows: body, section_heading: sectionHeading });
      if (/^year$/i.test(headers[0])) {
        body.forEach((row) => yearlyStats.push({
          ...Object.fromEntries(headers.map((header, index) => [header || `column_${index + 1}`, row[index] || ''])),
          section_heading: sectionHeading
        }));
      } else if (/^college$/i.test(headers[0])) {
        body.forEach((row) => collegeStats.push({
          ...Object.fromEntries(headers.map((header, index) => [header || `column_${index + 1}`, row[index] || ''])),
          section_heading: sectionHeading
        }));
      } else if (/^companies?$/i.test(headers[0])) {
        body.flat().filter(Boolean).forEach((company) => recruiters.add(company));
      } else if (/^(particular|particulars)$/i.test(headers[0]) && /^(statistics|values)$/i.test(headers[1] || '')) {
        const isUniversitySummary = !Object.keys(universitySummary).length;
        body.forEach((row) => {
          if (row[0] && row[1]) summary[row[0]] = row[1];
          if (isUniversitySummary && row[0] && row[1]) universitySummary[row[0]] = row[1];
          if (/recruiters/i.test(row[0] || '')) row[1].split(/,|\n/).map(normalize).filter(Boolean).forEach((company) => recruiters.add(company));
        });
      }
    }

    const totalStudents = Number.parseInt(universitySummary['Total Students'], 10);
    const studentsPlaced = Number.parseInt(universitySummary['Number of Students Placed'], 10);
    const placementRate = Number.isFinite(totalStudents) && Number.isFinite(studentsPlaced) && totalStudents > 0
      ? ((studentsPlaced / totalStudents) * 100).toFixed(2)
      : '';
    const makeRecord = (values = {}) => ({
      university_name: universityName,
      course: '',
      stream: '',
      academic_year: '',
      placement_rate: '',
      highest_package: '',
      average_package: '',
      median_package: '',
      students_placed: '',
      students_eligible: '',
      company_name: '',
      industry: '',
      ...values
    });
    const records = [makeRecord({
      course: 'All Courses',
      stream: 'Overall University Placement',
      placement_rate: placementRate,
      median_package: universitySummary['Median Package (3-year UG)'] || '',
      students_placed: universitySummary['Number of Students Placed'] || '',
      students_eligible: universitySummary['Total Students'] || '',
      company_name: universitySummary['Top Recruiters'] || ''
    })];
    yearlyStats.forEach((row) => {
      const match = row.section_heading.match(/\b(UG|PG)\s+(\d+)-Year/i);
      const eligible = Number.parseInt(row['Total Number of Students'], 10);
      const placed = Number.parseInt(row['No. of Students Placed'], 10);
      records.push(makeRecord({
        course: match?.[1]?.toUpperCase() || '',
        stream: match ? `${match[1].toUpperCase()} ${match[2]}-Year Placement` : row.section_heading,
        academic_year: row.Year || '',
        placement_rate: Number.isFinite(eligible) && eligible > 0 && Number.isFinite(placed) ? ((placed / eligible) * 100).toFixed(2) : '',
        median_package: row['Median Salary Package'] || '',
        students_placed: row['No. of Students Placed'] || '',
        students_eligible: row['Total Number of Students'] || ''
      }));
    });
    collegeStats.forEach((row) => records.push(makeRecord({
      course: 'All Courses',
      stream: row.College || '',
      highest_package: row['Highest Package'] || '',
      average_package: row['Average Package'] || ''
    })));
    tablesData.filter((table) => /^(particular|particulars)$/i.test(table.headers[0]) && /^(statistics|values)$/i.test(table.headers[1] || '') && !/Delhi University Placement Highlight/i.test(table.section_heading)).forEach((table) => {
      const metrics = Object.fromEntries(table.rows.filter((row) => row[0] && row[1]).map((row) => [row[0], row[1]]));
      records.push(makeRecord({
        course: 'All Courses',
        stream: table.section_heading.replace(/\s+Placement(?:\s+Report)?$/i, ''),
        highest_package: metrics['Highest Package'] || '',
        average_package: metrics['Average Package'] || '',
        median_package: metrics['Median Package'] || metrics['Median Package (UG 3 Year)'] || '',
        students_placed: metrics['Student Placed'] || '',
        students_eligible: metrics['Students Graduated'] || '',
        company_name: metrics['Top Recruiters'] || ''
      }));
    });
    return records;
  }

  function findSectionHeading(table) {
    return [...document.querySelectorAll('h2, h3, h4')]
      .filter((heading) => heading.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING)
      .pop()?.innerText ? normalize([...document.querySelectorAll('h2, h3, h4')]
        .filter((heading) => heading.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING)
        .pop().innerText) : '';
  }
})();
