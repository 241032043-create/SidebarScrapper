# University Course Scraper

A Manifest V3 Chrome Side Panel extension for scraping Collegedunia university courses and marketplace data.

## Features

1. **Select a single card (with streams)**:
   - Click to select any course card on the page (e.g. `B.Tech`, `B.Sc`).
   - Expands nested courses/streams (CSE, Biotechnology, etc.).
   - Scrapes stream detail pages with fees, qualification, exams, and descriptions.
   - Exports `{ course: {...}, streams: [...] }`.

2. **Scrape all courses on page**:
   - One-click extraction of all course cards visible on the page (e.g. B.Tech, BCA, MBA, B.Sc, etc.).
   - Extracts `course_name`, `category`, `degree_level`, `course_type`, `duration`, `total_fees`, `mode`, `admission_status`, and `description`.
   - Optional button to fetch expanded "Read More" descriptions for all parent courses.
   - Exports the array `[...]` of all courses in the marketplace format.

## How to use

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `SidebarScraper` folder (or click Reload if already loaded).
4. Go to any Collegedunia university courses page.
5. Open the extension side panel and choose either:
   - **Select a single card (with streams)**, or
   - **Scrape all courses on page**
