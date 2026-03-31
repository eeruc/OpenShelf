/**
 * OpenShelf — Main Application
 * Library, Reader, Settings, TTS integration
 */

import { parseEpub, extractTextFromHtml, splitIntoSentences } from './epub-parser.js';
import { ttsEngine, VOICES, SPEED_OPTIONS } from './tts-engine.js';
import { loadBooks, saveBook, deleteBookFromDB, loadSettings, saveSettings } from './db.js';

// ===== APP STATE (persisted via IndexedDB) =====
const AppState = {
  books: [],
  settings: {
    fontSize: 18,
    lineHeight: 1.7,
    fontFamily: 'serif',
    theme: 'system',
    ttsVoice: 'af_heart',  // Locked to Heart voice
    ttsSpeed: 1.0,
    modelDtype: 'fp16'
  },
  currentBook: null,
  currentChapter: 0,
  currentScreen: 'library',
  readerHeaderVisible: true,
  sortBy: 'recent'
};

// Debounced settings persistence
let _settingsTimer = null;
function persistSettings() {
  clearTimeout(_settingsTimer);
  _settingsTimer = setTimeout(() => saveSettings(AppState.settings), 300);
}

// ===== ICONS (SVG strings) =====
const Icons = {
  book: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  chevronLeft: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
  chevronRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
  menu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,
  x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`,
  skipForward: `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2" fill="none"/></svg>`,
  skipBack: `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="5" x2="5" y2="19" stroke="currentColor" stroke-width="2" fill="none"/></svg>`,
  headphones: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  bookOpen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
  type: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
  volume2: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
  list: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  waveform: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="8" x2="4" y2="16"/><line x1="8" y1="5" x2="8" y2="19"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="16" y1="5" x2="16" y2="19"/><line x1="20" y1="8" x2="20" y2="16"/></svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
};

// ===== INITIALIZATION =====
document.addEventListener('DOMContentLoaded', async () => {
  // Restore persisted settings
  try {
    const saved = await loadSettings();
    if (saved) {
      Object.assign(AppState.settings, saved);
    }
  } catch (e) { /* use defaults */ }

  initTheme();

  // Restore persisted books
  try {
    const books = await loadBooks();
    if (books.length > 0) {
      AppState.books = books;
    }
  } catch (e) { /* empty library */ }

  renderLibrary();
  bindEvents();
  setupServiceWorker();
});

function setupServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// ===== THEME MANAGEMENT =====
function initTheme() {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (AppState.settings.theme === 'system') {
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', AppState.settings.theme);
  }
}

function setTheme(theme) {
  AppState.settings.theme = theme;
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

function getCurrentThemeIcon() {
  const current = document.documentElement.getAttribute('data-theme');
  return current === 'dark' ? Icons.sun : Icons.moon;
}

function toggleThemeQuick() {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
  // Update toggle icon
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.innerHTML = getCurrentThemeIcon();
}

// ===== SCREEN NAVIGATION =====
function showScreen(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(`${screen}-screen`);
  if (el) el.classList.add('active');
  AppState.currentScreen = screen;
}

// ===== LIBRARY SCREEN =====
function renderLibrary() {
  const content = document.getElementById('library-content');
  const countEl = document.getElementById('book-count');
  
  if (!content) return;

  const books = getSortedBooks();
  
  if (countEl) {
    countEl.textContent = books.length === 0 ? '' : `${books.length} book${books.length !== 1 ? 's' : ''}`;
  }

  if (books.length === 0) {
    content.innerHTML = renderEmptyState();
    return;
  }

  content.innerHTML = `
    <div class="book-grid">
      ${books.map((book, i) => renderBookCard(book, i)).join('')}
    </div>
  `;

  // Bind card events
  content.querySelectorAll('.book-card').forEach(card => {
    const bookId = card.dataset.bookId;
    card.addEventListener('click', () => openBook(bookId));
    
    // Long press for context menu
    let pressTimer;
    card.addEventListener('touchstart', (e) => {
      pressTimer = setTimeout(() => {
        e.preventDefault();
        showContextMenu(bookId, e.touches[0].clientX, e.touches[0].clientY);
      }, 500);
    }, { passive: false });
    card.addEventListener('touchend', () => clearTimeout(pressTimer));
    card.addEventListener('touchmove', () => clearTimeout(pressTimer));
    
    // Right click
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(bookId, e.clientX, e.clientY);
    });
  });
}

function getSortedBooks() {
  const books = [...AppState.books];
  switch (AppState.sortBy) {
    case 'title': return books.sort((a, b) => a.title.localeCompare(b.title));
    case 'author': return books.sort((a, b) => a.author.localeCompare(b.author));
    case 'recent': default: return books.sort((a, b) => (b.lastRead || 0) - (a.lastRead || 0));
  }
}

function renderEmptyState() {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">${Icons.bookOpen}</div>
      <h2>Your library is empty</h2>
      <p>Import an EPUB file to start reading. OpenShelf works entirely in your browser — your books stay private.</p>
      <button class="btn-primary" onclick="document.getElementById('file-input').click()">
        ${Icons.plus}
        Add Your First Book
      </button>
    </div>
  `;
}

function renderBookCard(book, index) {
  const progress = book.progress || 0;
  const coverHtml = book.cover
    ? `<img src="${book.cover}" alt="${escapeHtml(book.title)} cover" loading="lazy">`
    : `<div class="book-cover-placeholder">
        <div class="book-icon">${Icons.book}</div>
        <div class="book-title-small">${escapeHtml(book.title)}</div>
      </div>`;

  return `
    <div class="book-card" data-book-id="${book.id}" style="animation-delay: ${index * 0.05}s">
      <div class="book-cover-wrapper">
        ${coverHtml}
        ${progress > 0 ? `
          <div class="book-progress-bar">
            <div class="book-progress-fill" style="width: ${progress}%"></div>
          </div>
        ` : ''}
      </div>
      <div class="book-info">
        <div class="book-title">${escapeHtml(book.title)}</div>
        <div class="book-author">${escapeHtml(book.author)}</div>
      </div>
    </div>
  `;
}

// ===== CONTEXT MENU =====
function showContextMenu(bookId, x, y) {
  closeContextMenu();
  
  const book = AppState.books.find(b => b.id === bookId);
  if (!book) return;

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'context-menu';
  
  // Adjust position to stay on screen
  const menuWidth = 180;
  const menuHeight = 100;
  const adjustedX = Math.min(x, window.innerWidth - menuWidth - 16);
  const adjustedY = Math.min(y, window.innerHeight - menuHeight - 16);
  
  menu.style.left = `${adjustedX}px`;
  menu.style.top = `${adjustedY}px`;
  
  menu.innerHTML = `
    <button class="context-menu-item" data-action="open">
      ${Icons.bookOpen} Open
    </button>
    <button class="context-menu-item danger" data-action="delete">
      ${Icons.trash} Remove from Library
    </button>
  `;

  document.body.appendChild(menu);

  menu.querySelector('[data-action="open"]').addEventListener('click', () => {
    closeContextMenu();
    openBook(bookId);
  });

  menu.querySelector('[data-action="delete"]').addEventListener('click', () => {
    closeContextMenu();
    deleteBook(bookId);
  });

  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
    document.addEventListener('touchstart', closeContextMenu, { once: true });
  }, 10);
}

function closeContextMenu() {
  const menu = document.getElementById('context-menu');
  if (menu) menu.remove();
}

// ===== BOOK OPERATIONS =====
async function importBook() {
  const input = document.getElementById('file-input');
  if (!input.files?.length) return;
  
  const file = input.files[0];
  if (!file.name.toLowerCase().endsWith('.epub')) {
    showToast('Please select an EPUB file');
    return;
  }

  showImportLoader(true);
  
  try {
    const book = await parseEpub(file);
    AppState.books.push(book);
    await saveBook(book);
    renderLibrary();
    showToast(`"${book.title}" added to your library`);
  } catch (error) {
    console.error('Import error:', error);
    showToast('Failed to import book. Please try another EPUB file.');
  } finally {
    showImportLoader(false);
    input.value = '';
  }
}

function deleteBook(bookId) {
  const idx = AppState.books.findIndex(b => b.id === bookId);
  if (idx === -1) return;
  const title = AppState.books[idx].title;
  AppState.books.splice(idx, 1);
  deleteBookFromDB(bookId);
  renderLibrary();
  showToast(`"${title}" removed`);
}

function openBook(bookId) {
  const book = AppState.books.find(b => b.id === bookId);
  if (!book) return;
  
  AppState.currentBook = book;
  AppState.currentChapter = book.currentChapter || 0;
  book.lastRead = Date.now();
  saveBook(book);  // persist lastRead timestamp
  
  showScreen('reader');
  renderReader();
}

// ===== READER SCREEN =====
function renderReader() {
  const book = AppState.currentBook;
  if (!book) return;

  const chapter = book.chapters[AppState.currentChapter];
  if (!chapter) return;

  // Update header
  document.getElementById('reader-book-title').textContent = book.title;
  document.getElementById('reader-chapter-title').textContent = chapter.title;

  // Render chapter content
  const body = document.getElementById('reader-body');
  body.innerHTML = extractBodyContent(chapter.html);

  // Apply reader settings
  applyReaderSettings();

  // Update navigation
  updateReaderNav();

  // Restore scroll position if we have one for this chapter, otherwise scroll to top
  const container = document.getElementById('reader-content');
  const savedScroll = book.scrollPositions?.[AppState.currentChapter];
  if (savedScroll && savedScroll > 0) {
    // Defer so the browser calculates scrollHeight after content renders
    requestAnimationFrame(() => {
      container.scrollTop = savedScroll * container.scrollHeight;
    });
  } else {
    container.scrollTop = 0;
  }

  // Update progress
  updateProgress();

  // Update TOC active state
  updateTocActive();
}

function extractBodyContent(html) {
  // Extract content from <body> tag if present — use greedy match to capture all content
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) return bodyMatch[1];
  
  // Otherwise check for content within html tags
  const htmlMatch = html.match(/<html[^>]*>([\s\S]*)<\/html>/i);
  if (htmlMatch) {
    const inner = htmlMatch[1];
    const innerBody = inner.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (innerBody) return innerBody[1];
    // Strip <head> if present
    return inner.replace(/<head[^>]*>[\s\S]*<\/head>/i, '');
  }
  
  return html;
}

function applyReaderSettings() {
  const body = document.getElementById('reader-body');
  if (!body) return;

  body.style.fontSize = `${AppState.settings.fontSize}px`;
  body.style.lineHeight = AppState.settings.lineHeight;
  body.style.fontFamily = AppState.settings.fontFamily === 'serif'
    ? 'var(--font-reading)'
    : 'var(--font-body)';
}

function updateReaderNav() {
  const book = AppState.currentBook;
  if (!book) return;

  const prevBtn = document.getElementById('prev-chapter-btn');
  const nextBtn = document.getElementById('next-chapter-btn');
  const progressText = document.getElementById('reader-progress-text');

  if (prevBtn) prevBtn.disabled = AppState.currentChapter <= 0;
  if (nextBtn) nextBtn.disabled = AppState.currentChapter >= book.chapters.length - 1;
  
  if (progressText) {
    progressText.textContent = `${AppState.currentChapter + 1} / ${book.chapters.length}`;
  }
}

function goToChapter(index) {
  const book = AppState.currentBook;
  if (!book || index < 0 || index >= book.chapters.length) return;
  
  // Save scroll position of current chapter before leaving it
  const container = document.getElementById('reader-content');
  if (container) saveScrollPosition(container);
  
  // Stop TTS if playing
  if (ttsEngine.isPlaying) {
    ttsEngine.stop();
    updateTTSBar();
  }
  
  AppState.currentChapter = index;
  book.currentChapter = index;
  saveBook(book);  // persist reading position
  renderReader();
}

function prevChapter() {
  goToChapter(AppState.currentChapter - 1);
}

function nextChapter() {
  goToChapter(AppState.currentChapter + 1);
}

function updateProgress() {
  const book = AppState.currentBook;
  if (!book) return;
  const progress = Math.round(((AppState.currentChapter + 1) / book.chapters.length) * 100);
  book.progress = progress;
  saveBook(book);  // persist progress
}

function goBackToLibrary() {
  // Save scroll position before leaving
  const container = document.getElementById('reader-content');
  if (container) saveScrollPosition(container);
  
  // Stop TTS
  if (ttsEngine.isPlaying) {
    ttsEngine.stop();
    updateTTSBar();
    clearHighlight();
  }
  
  showScreen('library');
  renderLibrary();
}

// Reader header auto-hide + scroll position persistence
let lastScrollTop = 0;
let _scrollSaveTimer = null;

function handleReaderScroll(e) {
  const st = e.target.scrollTop;
  const header = document.querySelector('.reader-header');
  const footer = document.querySelector('.reader-footer');
  
  // Persist scroll position (debounced)
  clearTimeout(_scrollSaveTimer);
  _scrollSaveTimer = setTimeout(() => saveScrollPosition(e.target), 500);
  
  if (Math.abs(st - lastScrollTop) < 5) return;
  
  if (st > lastScrollTop && st > 60) {
    // Scrolling down
    header?.classList.add('hidden');
    footer?.classList.add('hidden');
    AppState.readerHeaderVisible = false;
  } else {
    // Scrolling up
    header?.classList.remove('hidden');
    footer?.classList.remove('hidden');
    AppState.readerHeaderVisible = true;
  }
  lastScrollTop = st;
}

function saveScrollPosition(container) {
  const book = AppState.currentBook;
  if (!book || !container) return;
  const scrollHeight = container.scrollHeight;
  if (scrollHeight <= 0) return;
  const percent = container.scrollTop / scrollHeight;
  if (!book.scrollPositions) book.scrollPositions = {};
  book.scrollPositions[AppState.currentChapter] = percent;
  // Also save current TTS sentence index if TTS is active
  if (ttsEngine.isPlaying || ttsEngine.isPaused) {
    if (!book.ttsSentencePositions) book.ttsSentencePositions = {};
    book.ttsSentencePositions[AppState.currentChapter] = ttsEngine.currentSentenceIndex;
  }
  saveBook(book);
}

function toggleReaderUI() {
  const header = document.querySelector('.reader-header');
  const footer = document.querySelector('.reader-footer');
  
  if (AppState.readerHeaderVisible) {
    header?.classList.add('hidden');
    footer?.classList.add('hidden');
    AppState.readerHeaderVisible = false;
  } else {
    header?.classList.remove('hidden');
    footer?.classList.remove('hidden');
    AppState.readerHeaderVisible = true;
  }
}

// ===== TABLE OF CONTENTS =====
function openToc() {
  const drawer = document.getElementById('toc-drawer');
  const overlay = document.getElementById('toc-overlay');
  
  renderTocList();
  
  drawer?.classList.add('open');
  overlay?.classList.add('open');
}

function closeToc() {
  document.getElementById('toc-drawer')?.classList.remove('open');
  document.getElementById('toc-overlay')?.classList.remove('open');
}

function renderTocList() {
  const list = document.getElementById('toc-list');
  const book = AppState.currentBook;
  if (!list || !book) return;

  // If TOC from EPUB is available, use it
  if (book.toc && book.toc.length > 0) {
    list.innerHTML = book.toc.map((entry, i) => {
      const chapterIdx = book.chapters.findIndex(c => c.href === entry.href || c.href.endsWith(entry.href));
      const isActive = chapterIdx === AppState.currentChapter;
      return `
        <button class="toc-item ${isActive ? 'active' : ''} ${entry.nested ? 'nested' : ''}"
                data-chapter-idx="${chapterIdx}" ${chapterIdx === -1 ? 'disabled' : ''}>
          ${escapeHtml(entry.title)}
        </button>
      `;
    }).join('');
  } else {
    // Fallback: use chapter titles
    list.innerHTML = book.chapters.map((ch, i) => `
      <button class="toc-item ${i === AppState.currentChapter ? 'active' : ''}"
              data-chapter-idx="${i}">
        ${escapeHtml(ch.title)}
      </button>
    `).join('');
  }

  // Bind click events
  list.querySelectorAll('.toc-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.chapterIdx);
      if (idx >= 0) {
        closeToc();
        goToChapter(idx);
      }
    });
  });
}

function updateTocActive() {
  document.querySelectorAll('.toc-item').forEach(item => {
    const idx = parseInt(item.dataset.chapterIdx);
    item.classList.toggle('active', idx === AppState.currentChapter);
  });
}

// ===== SETTINGS PANEL =====
function openSettings() {
  const overlay = document.getElementById('settings-overlay');
  const panel = document.getElementById('settings-panel');
  
  renderSettingsContent();
  
  overlay?.classList.add('open');
  panel?.classList.add('open');
}

function closeSettings() {
  document.getElementById('settings-overlay')?.classList.remove('open');
  document.getElementById('settings-panel')?.classList.remove('open');
}

function renderVoiceGroups(activeVoice) {
  const groups = [
    { label: 'American Female', voices: VOICES.filter(v => v.accent === 'US' && v.gender === 'F') },
    { label: 'American Male', voices: VOICES.filter(v => v.accent === 'US' && v.gender === 'M') },
    { label: 'British Female', voices: VOICES.filter(v => v.accent === 'UK' && v.gender === 'F') },
    { label: 'British Male', voices: VOICES.filter(v => v.accent === 'UK' && v.gender === 'M') },
  ];

  return groups.map(g => `
    <div class="voice-group-label">${g.label}</div>
    <div class="voice-grid" style="margin-bottom: var(--space-3);">
      ${g.voices.map(v => `
        <button class="voice-option ${activeVoice === v.id ? 'active' : ''}" data-voice="${v.id}">
          <span class="voice-icon">${v.emoji}</span>
          <span class="voice-name">${v.name}</span>
          <span class="voice-grade">${v.grade}</span>
        </button>
      `).join('')}
    </div>
  `).join('');
}

function renderSettingsContent() {
  const container = document.getElementById('settings-content');
  if (!container) return;

  const s = AppState.settings;
  const currentThemeAttr = document.documentElement.getAttribute('data-theme');

  container.innerHTML = `
    <!-- Reading Section -->
    <div class="settings-section">
      <div class="settings-section-title">Reading</div>
      
      <div class="setting-row">
        <span class="setting-label">Theme</span>
      </div>
      <div class="theme-selector" style="margin-bottom: var(--space-4);">
        <button class="theme-option theme-light ${currentThemeAttr === 'light' ? 'active' : ''}" data-set-theme="light">
          <div class="theme-option-preview"></div>
          Light
        </button>
        <button class="theme-option theme-sepia ${currentThemeAttr === 'sepia' ? 'active' : ''}" data-set-theme="sepia">
          <div class="theme-option-preview"></div>
          Sepia
        </button>
        <button class="theme-option theme-dark ${currentThemeAttr === 'dark' ? 'active' : ''}" data-set-theme="dark">
          <div class="theme-option-preview"></div>
          Dark
        </button>
      </div>

      <div class="setting-row">
        <span class="setting-label">Font</span>
      </div>
      <div class="font-selector" style="margin-bottom: var(--space-4);">
        <button class="font-option serif ${s.fontFamily === 'serif' ? 'active' : ''}" data-set-font="serif">Serif</button>
        <button class="font-option sans ${s.fontFamily === 'sans' ? 'active' : ''}" data-set-font="sans">Sans-serif</button>
      </div>

      <div class="setting-row">
        <span class="setting-label">Font Size</span>
        <span class="setting-value" id="font-size-value">${s.fontSize}px</span>
      </div>
      <div style="padding: var(--space-1) 0 var(--space-3);">
        <input type="range" class="setting-slider" id="font-size-slider"
               min="14" max="28" step="1" value="${s.fontSize}" style="width: 100%;">
      </div>

      <div class="setting-row">
        <span class="setting-label">Line Height</span>
        <span class="setting-value" id="line-height-value">${s.lineHeight}</span>
      </div>
      <div style="padding: var(--space-1) 0;">
        <input type="range" class="setting-slider" id="line-height-slider"
               min="1.2" max="2.2" step="0.1" value="${s.lineHeight}" style="width: 100%;">
      </div>
    </div>

    <!-- TTS Section -->
    <div class="settings-section">
      <div class="settings-section-title">Text-to-Speech</div>
      
      <div class="setting-row" style="margin-bottom: var(--space-3);">
        <span class="setting-label">Voice</span>
        <span class="setting-value">💛 Heart</span>
      </div>

      <div class="setting-row">
        <span class="setting-label">Speed</span>
        <span class="setting-value" id="tts-speed-value">${s.ttsSpeed}x</span>
      </div>
      <div style="padding: var(--space-1) 0 var(--space-3);">
        <input type="range" class="setting-slider" id="tts-speed-slider"
               min="0.75" max="2.0" step="0.25" value="${s.ttsSpeed}" style="width: 100%;">
      </div>

      <div class="setting-row">
        <span class="setting-label">Model Quality</span>
      </div>
      <div class="model-selector">
        <button class="model-option ${s.modelDtype === 'q8' ? 'active' : ''}" data-model="q8">
          Standard
          <small>~92MB, good</small>
        </button>
        <button class="model-option ${s.modelDtype === 'fp16' ? 'active' : ''}" data-model="fp16">
          High
          <small>~163MB, natural</small>
        </button>
        <button class="model-option ${s.modelDtype === 'fp32' ? 'active' : ''}" data-model="fp32">
          Ultra
          <small>~326MB, best</small>
        </button>
      </div>
    </div>
  `;

  // Bind settings events
  bindSettingsEvents(container);
}

function bindSettingsEvents(container) {
  // Theme
  container.querySelectorAll('[data-set-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      setTheme(btn.dataset.setTheme);
      persistSettings();
      renderSettingsContent(); // Refresh to show active state
      const toggleBtn = document.getElementById('theme-toggle');
      if (toggleBtn) toggleBtn.innerHTML = getCurrentThemeIcon();
    });
  });

  // Font family
  container.querySelectorAll('[data-set-font]').forEach(btn => {
    btn.addEventListener('click', () => {
      AppState.settings.fontFamily = btn.dataset.setFont;
      persistSettings();
      applyReaderSettings();
      renderSettingsContent();
    });
  });

  // Font size
  const fontSizeSlider = container.querySelector('#font-size-slider');
  if (fontSizeSlider) {
    fontSizeSlider.addEventListener('input', (e) => {
      AppState.settings.fontSize = parseInt(e.target.value);
      document.getElementById('font-size-value').textContent = `${e.target.value}px`;
      persistSettings();
      applyReaderSettings();
    });
  }

  // Line height
  const lineHeightSlider = container.querySelector('#line-height-slider');
  if (lineHeightSlider) {
    lineHeightSlider.addEventListener('input', (e) => {
      AppState.settings.lineHeight = parseFloat(e.target.value);
      document.getElementById('line-height-value').textContent = parseFloat(e.target.value).toFixed(1);
      persistSettings();
      applyReaderSettings();
    });
  }

  // Voice
  container.querySelectorAll('[data-voice]').forEach(btn => {
    btn.addEventListener('click', () => {
      AppState.settings.ttsVoice = btn.dataset.voice;
      ttsEngine.setVoice(btn.dataset.voice);
      persistSettings();
      renderSettingsContent();
    });
  });

  // TTS Speed
  const speedSlider = container.querySelector('#tts-speed-slider');
  if (speedSlider) {
    speedSlider.addEventListener('input', (e) => {
      const speed = parseFloat(e.target.value);
      AppState.settings.ttsSpeed = speed;
      ttsEngine.setSpeed(speed);
      persistSettings();
      document.getElementById('tts-speed-value').textContent = `${speed}x`;
    });
  }

  // Model
  container.querySelectorAll('[data-model]').forEach(btn => {
    btn.addEventListener('click', () => {
      AppState.settings.modelDtype = btn.dataset.model;
      ttsEngine.shutdown(); // Kill old worker & force re-init with new dtype
      persistSettings();
      renderSettingsContent();
    });
  });
}

// ===== TTS INTEGRATION =====

/**
 * Global audio unlock: register touch/click/key listeners on the document
 * that will pre-warm the AudioContext on the very first user interaction.
 * This is critical for iOS Safari where AudioContext must be unlocked during
 * a user gesture BEFORE any async work (like model download) happens.
 */
let _globalAudioUnlockBound = false;
function setupGlobalAudioUnlock() {
  if (_globalAudioUnlockBound) return;
  _globalAudioUnlockBound = true;

  const events = ['touchstart', 'touchend', 'click', 'keydown'];
  const unlock = () => {
    ttsEngine.ensureAudioContext();
    // Keep listeners active — iOS can re-suspend AudioContext after screen lock
    // We'll re-unlock on every interaction to be safe
  };

  events.forEach(evt => {
    document.addEventListener(evt, unlock, { capture: true, passive: true });
  });
}

// Activate global unlock as soon as the module loads
setupGlobalAudioUnlock();

// Set up Media Session lock screen controls (play/pause/skip from lock screen)
let _mediaSessionSetup = false;
function setupMediaSession() {
  if (_mediaSessionSetup) return;
  _mediaSessionSetup = true;

  ttsEngine.setupMediaSessionHandlers({
    onPlay: () => {
      if (ttsEngine.isPaused) {
        ttsEngine.resume();
        updateTTSBar();
      } else if (!ttsEngine.isPlaying) {
        startTTS();
      }
    },
    onPause: () => {
      if (ttsEngine.isPlaying && !ttsEngine.isPaused) {
        ttsEngine.pause();
        updateTTSBar();
      }
    },
    onStop: () => {
      stopTTS();
    },
    onNextTrack: () => {
      // Skip to next chapter
      if (AppState.currentBook && AppState.currentChapter < AppState.currentBook.chapters.length - 1) {
        ttsEngine.stop();
        nextChapter();
        setTimeout(() => startTTS(), 300);
      } else {
        skipTTSForward();
      }
    },
    onPrevTrack: () => {
      // Skip to previous chapter
      if (AppState.currentBook && AppState.currentChapter > 0) {
        ttsEngine.stop();
        prevChapter();
        setTimeout(() => startTTS(), 300);
      } else {
        skipTTSBackward();
      }
    }
  });
}

async function startTTS() {
  const book = AppState.currentBook;
  if (!book) return;

  const chapter = book.chapters[AppState.currentChapter];
  if (!chapter) return;

  // CRITICAL: Create AudioContext immediately on user gesture
  // Browsers block audio playback unless AudioContext is created during a user interaction.
  // On iOS Safari, we must also play a silent buffer to "warm up" the hardware.
  // If we wait until after async model init, the gesture context is lost.
  ttsEngine.ensureAudioContext();

  // Initialize engine if needed
  if (!ttsEngine.isReady) {
    // Show a lightweight toast initially — will upgrade to full overlay if downloading
    showToast('Loading AI voice model...');
    let showedOverlay = false;
    let downloadCheckTimer = null;
    
    ttsEngine.onProgress = (progress) => {
      // If we detect an actual download (not cached), show the full overlay
      if (ttsEngine.isDownloading && !showedOverlay) {
        showedOverlay = true;
        showTTSLoading(true);
      }
      if (showedOverlay) {
        updateTTSLoadingProgress(progress);
      }
    };

    ttsEngine.onError = (error) => {
      showTTSLoading(false);
      showTTSError(error);
    };

    try {
      await ttsEngine.initialize(AppState.settings.modelDtype);
    } catch (e) {
      showTTSLoading(false);
      showTTSError(e);
      return;
    }
    
    showTTSLoading(false);
    if (!ttsEngine.isReady) return;
    
    if (!showedOverlay) {
      showToast('AI voice ready');
    }
  }

  // Extract and split text
  const text = extractTextFromHtml(chapter.html);
  const sentences = splitIntoSentences(text);
  
  if (sentences.length === 0) {
    showToast('No readable text in this chapter');
    return;
  }

  // Set up Media Session lock screen controls + metadata
  setupMediaSession();
  const chapterTitle = chapter.title || `Chapter ${AppState.currentChapter + 1}`;
  ttsEngine.setMediaSessionMetadata(
    book.title || 'Untitled Book',
    chapterTitle,
    book.coverUrl || null
  );

  // Set up callbacks
  ttsEngine.setVoice(AppState.settings.ttsVoice);
  ttsEngine.setSpeed(AppState.settings.ttsSpeed);

  ttsEngine.onSentenceStart = (index, sentence) => {
    ttsEngine.currentSentenceIndex = index;
    highlightSentence(sentence);
    updateTTSBarText(sentence);
    // Persist reading position during TTS playback
    if (book) {
      if (!book.ttsSentencePositions) book.ttsSentencePositions = {};
      book.ttsSentencePositions[AppState.currentChapter] = index;
      saveBook(book);
    }
  };

  ttsEngine.onSentenceEnd = (index) => {
    // Progress update
  };

  ttsEngine.onComplete = () => {
    clearHighlight();
    updateTTSBar();
    
    // Auto-advance to next chapter
    if (AppState.currentChapter < book.chapters.length - 1) {
      nextChapter();
      setTimeout(() => startTTS(), 500);
    }
  };

  ttsEngine.onStateChange = (state) => {
    updateTTSBar();
  };

  // Re-unlock AudioContext right before playback (iOS may have re-suspended it
  // during the async model init period)
  ttsEngine.ensureAudioContext();
  const ctx = ttsEngine.audioContext;
  if (ctx) {
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      try { await ctx.resume(); } catch (e) { /* */ }
    }
    // If context is STILL not running, try the nuclear option: suspend then resume
    if (ctx.state !== 'running') {
      try {
        await ctx.suspend();
        await ctx.resume();
      } catch (e) { /* */ }
    }
  }

  // Start playing
  await ttsEngine.playSentences(sentences);
  updateTTSBar();
}

function toggleTTSPlayPause() {
  if (ttsEngine.isPlaying && !ttsEngine.isPaused) {
    ttsEngine.pause();
  } else if (ttsEngine.isPaused) {
    ttsEngine.resume();
  } else {
    startTTS();
  }
  updateTTSBar();
}

function stopTTS() {
  ttsEngine.stop();
  clearHighlight();
  updateTTSBar();
}

function skipTTSForward() {
  ttsEngine.skipForward();
}

function skipTTSBackward() {
  ttsEngine.skipBackward();
}

function cycleTTSSpeed() {
  const currentIdx = SPEED_OPTIONS.indexOf(AppState.settings.ttsSpeed);
  const nextIdx = (currentIdx + 1) % SPEED_OPTIONS.length;
  AppState.settings.ttsSpeed = SPEED_OPTIONS[nextIdx];
  ttsEngine.setSpeed(SPEED_OPTIONS[nextIdx]);
  updateTTSBar();
}

function updateTTSBar() {
  const bar = document.getElementById('tts-bar');
  if (!bar) return;

  if (ttsEngine.isPlaying || ttsEngine.isPaused) {
    bar.classList.add('active');
    
    const playBtn = document.getElementById('tts-play-btn');
    if (playBtn) {
      playBtn.innerHTML = ttsEngine.isPaused ? Icons.play : Icons.pause;
    }
    
    const speedBtn = document.getElementById('tts-speed-btn');
    if (speedBtn) {
      speedBtn.textContent = `${AppState.settings.ttsSpeed}x`;
    }

    const statusEl = document.getElementById('tts-status');
    if (statusEl) {
      statusEl.textContent = ttsEngine.isPaused ? 'Paused' : 'Reading aloud';
    }

    const engineLabel = document.getElementById('tts-engine-label');
    if (engineLabel) {
      engineLabel.textContent = ttsEngine.engineLabel;
    }
  } else {
    bar.classList.remove('active');
    const engineLabel = document.getElementById('tts-engine-label');
    if (engineLabel) engineLabel.textContent = '';
  }
}

function updateTTSBarText(sentence) {
  const el = document.getElementById('tts-current-text');
  if (el) {
    el.textContent = sentence.length > 80 ? sentence.substring(0, 80) + '...' : sentence;
  }
}

// Sentence highlighting
function highlightSentence(sentence) {
  clearHighlight();
  
  const body = document.getElementById('reader-body');
  if (!body) return;

  // Walk text nodes and find the sentence
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const cleanSentence = sentence.trim();
  let found = false;
  
  while (walker.nextNode() && !found) {
    const node = walker.currentNode;
    const text = node.textContent;
    
    // Try to find at least the first 30 chars of the sentence
    const searchStr = cleanSentence.substring(0, Math.min(30, cleanSentence.length));
    const idx = text.indexOf(searchStr);
    
    if (idx !== -1) {
      // Found the sentence text — wrap in highlight span
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, Math.min(idx + cleanSentence.length, text.length));
      
      const span = document.createElement('span');
      span.className = 'tts-highlight';
      try {
        range.surroundContents(span);
        
        // Scroll into view if needed
        span.scrollIntoView({ behavior: 'smooth', block: 'center' });
        found = true;
      } catch (e) {
        // Range may cross element boundaries — skip highlighting
      }
    }
  }
}

function clearHighlight() {
  const highlights = document.querySelectorAll('.tts-highlight');
  highlights.forEach(span => {
    const parent = span.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(span.textContent), span);
      parent.normalize();
    }
  });
}

// TTS Loading Screen
function showTTSLoading(show) {
  const overlay = document.getElementById('tts-loading');
  if (overlay) {
    overlay.classList.toggle('active', show);
  }
}

function updateTTSLoadingProgress(progress) {
  const fill = document.getElementById('tts-progress-fill');
  const text = document.getElementById('tts-progress-msg');
  
  if (fill) fill.style.width = `${progress.percent}%`;
  if (text) text.textContent = progress.message;
}

function cancelTTSLoading() {
  ttsEngine.cancelLoading();
  showTTSLoading(false);
}

function showTTSError(error) {
  const errorEl = document.getElementById('tts-error');
  if (errorEl) {
    // Show a more helpful message if offline
    if (!navigator.onLine) {
      const msgEl = errorEl.querySelector('p') || errorEl;
      msgEl.textContent = 'TTS requires the AI model to be downloaded first. Connect to the internet and try again.';
    }
    errorEl.classList.add('active');
    setTimeout(() => errorEl.classList.remove('active'), 8000);
  }
  console.error('TTS Error:', error);
}

// ===== UI HELPERS =====
function showImportLoader(show) {
  const loader = document.getElementById('import-loader');
  if (loader) loader.classList.toggle('active', show);
}

let _toastTimer = null;
function showToast(message) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  
  // Clear any existing timer so toasts don't get stuck
  if (_toastTimer) clearTimeout(_toastTimer);
  
  toast.classList.remove('show');
  toast.textContent = message;
  
  // Force reflow to restart transition
  void toast.offsetWidth;
  toast.classList.add('show');
  
  _toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    _toastTimer = null;
  }, 3000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== TAP-ON-WORD TTS RESUME =====

/**
 * Get the word at a specific screen coordinate using Range/caret APIs.
 * Works by using caretPositionFromPoint (standard) or caretRangeFromPoint (WebKit).
 */
function getWordAtPoint(x, y) {
  let range = null;
  let textNode = null;
  let offset = 0;

  // Standard API
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos && pos.offsetNode && pos.offsetNode.nodeType === Node.TEXT_NODE) {
      textNode = pos.offsetNode;
      offset = pos.offset;
    }
  }
  // WebKit fallback (Safari, Chrome)
  else if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
    if (range && range.startContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
      textNode = range.startContainer;
      offset = range.startOffset;
    }
  }

  if (!textNode) return null;

  const text = textNode.textContent;
  if (!text || offset >= text.length) return null;

  // Find word boundaries around the offset
  let start = offset;
  let end = offset;

  while (start > 0 && /\S/.test(text[start - 1])) start--;
  while (end < text.length && /\S/.test(text[end])) end++;

  const word = text.substring(start, end).trim();
  return word.length > 0 ? word : null;
}

/**
 * Find the sentence containing the tapped word and restart TTS from that sentence.
 */
function resumeTTSFromWord(word) {
  if (!ttsEngine.sentences || ttsEngine.sentences.length === 0) return;

  const cleanWord = word.toLowerCase().replace(/[^a-z0-9']/g, '');
  if (cleanWord.length < 2) return;

  // Find the first sentence that contains this word
  let targetIndex = -1;
  for (let i = 0; i < ttsEngine.sentences.length; i++) {
    const sentenceLower = ttsEngine.sentences[i].toLowerCase();
    if (sentenceLower.includes(cleanWord)) {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex === -1) return;

  // Stop current playback and restart from the target sentence
  ttsEngine.stop();
  clearHighlight();
  showToast(`Resuming from: "${word}..."`);

  // Brief delay so the stop() completes and toast shows
  setTimeout(() => {
    startTTSFromSentence(targetIndex);
  }, 100);
}

/**
 * Start TTS from a specific sentence index in the current chapter.
 */
async function startTTSFromSentence(sentenceIndex) {
  const book = AppState.currentBook;
  if (!book) return;

  const chapter = book.chapters[AppState.currentChapter];
  if (!chapter) return;

  ttsEngine.ensureAudioContext();

  if (!ttsEngine.isReady) {
    showToast('Loading AI voice model...');
    ttsEngine.onProgress = (progress) => {
      if (ttsEngine.isDownloading) showTTSLoading(true);
      updateTTSLoadingProgress(progress);
    };
    try {
      await ttsEngine.initialize(AppState.settings.modelDtype);
    } catch (e) {
      showTTSLoading(false);
      showTTSError(e);
      return;
    }
    showTTSLoading(false);
    if (!ttsEngine.isReady) return;
  }

  const text = extractTextFromHtml(chapter.html);
  const sentences = splitIntoSentences(text);
  if (sentences.length === 0 || sentenceIndex >= sentences.length) return;

  setupMediaSession();
  const chapterTitle = chapter.title || `Chapter ${AppState.currentChapter + 1}`;
  ttsEngine.setMediaSessionMetadata(book.title || 'Untitled Book', chapterTitle, book.coverUrl || null);
  ttsEngine.setVoice(AppState.settings.ttsVoice);
  ttsEngine.setSpeed(AppState.settings.ttsSpeed);

  ttsEngine.onSentenceStart = (index, sentence) => {
    ttsEngine.currentSentenceIndex = index;
    highlightSentence(sentence);
    updateTTSBarText(sentence);
    if (book) {
      if (!book.ttsSentencePositions) book.ttsSentencePositions = {};
      book.ttsSentencePositions[AppState.currentChapter] = index;
      saveBook(book);
    }
  };

  ttsEngine.onSentenceEnd = (index) => {};

  ttsEngine.onComplete = () => {
    clearHighlight();
    updateTTSBar();
    if (AppState.currentChapter < book.chapters.length - 1) {
      nextChapter();
      setTimeout(() => startTTS(), 500);
    }
  };

  ttsEngine.onStateChange = (state) => {
    updateTTSBar();
  };

  ttsEngine.ensureAudioContext();
  const ctx = ttsEngine.audioContext;
  if (ctx) {
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      try { await ctx.resume(); } catch (e) { /* */ }
    }
    if (ctx.state !== 'running') {
      try { await ctx.suspend(); await ctx.resume(); } catch (e) { /* */ }
    }
  }

  await ttsEngine.playSentences(sentences, sentenceIndex);
  updateTTSBar();
}

// ===== EVENT BINDINGS =====
function bindEvents() {
  // File import
  const fileInput = document.getElementById('file-input');
  if (fileInput) {
    fileInput.addEventListener('change', importBook);
  }

  // Import button
  const importBtn = document.getElementById('import-btn');
  if (importBtn) {
    importBtn.addEventListener('click', () => fileInput?.click());
  }

  // Theme toggle
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.innerHTML = getCurrentThemeIcon();
    themeToggle.addEventListener('click', toggleThemeQuick);
  }

  // Sort tabs
  document.querySelectorAll('.sort-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sort-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      AppState.sortBy = tab.dataset.sort;
      renderLibrary();
    });
  });

  // Reader back button
  document.getElementById('reader-back-btn')?.addEventListener('click', goBackToLibrary);

  // Chapter navigation
  document.getElementById('prev-chapter-btn')?.addEventListener('click', prevChapter);
  document.getElementById('next-chapter-btn')?.addEventListener('click', nextChapter);

  // TOC
  document.getElementById('toc-btn')?.addEventListener('click', openToc);
  document.getElementById('toc-close-btn')?.addEventListener('click', closeToc);
  document.getElementById('toc-overlay')?.addEventListener('click', closeToc);

  // Settings
  document.getElementById('settings-btn')?.addEventListener('click', openSettings);
  document.getElementById('settings-reader-btn')?.addEventListener('click', openSettings);
  document.getElementById('settings-close-btn')?.addEventListener('click', closeSettings);
  document.getElementById('settings-overlay')?.addEventListener('click', closeSettings);

  // TTS controls
  document.getElementById('tts-btn')?.addEventListener('click', toggleTTSPlayPause);
  document.getElementById('tts-play-btn')?.addEventListener('click', toggleTTSPlayPause);
  document.getElementById('tts-skip-back')?.addEventListener('click', skipTTSBackward);
  document.getElementById('tts-skip-forward')?.addEventListener('click', skipTTSForward);
  document.getElementById('tts-speed-btn')?.addEventListener('click', cycleTTSSpeed);
  document.getElementById('tts-stop-btn')?.addEventListener('click', stopTTS);
  document.getElementById('tts-cancel-loading')?.addEventListener('click', cancelTTSLoading);

  // Reader scroll for auto-hide header
  const readerContent = document.getElementById('reader-content');
  if (readerContent) {
    readerContent.addEventListener('scroll', handleReaderScroll, { passive: true });
  }

  // Tap on reader body: if TTS is active and user taps a word, resume from that word.
  // Otherwise, toggle the reader UI (header/footer visibility).
  document.getElementById('reader-body')?.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') return;
    // Only toggle if not selecting text
    if (window.getSelection()?.toString()) return;
    
    // If TTS is playing or paused, try to find the tapped word and resume from it
    if ((ttsEngine.isPlaying || ttsEngine.isPaused) && ttsEngine.sentences && ttsEngine.sentences.length > 0) {
      const tappedWord = getWordAtPoint(e.clientX, e.clientY);
      if (tappedWord && tappedWord.trim().length > 0) {
        resumeTTSFromWord(tappedWord);
        return;
      }
    }
    
    toggleReaderUI();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (AppState.currentScreen !== 'reader') return;
    
    switch (e.key) {
      case ' ':
        if (ttsEngine.isPlaying || ttsEngine.isPaused) {
          e.preventDefault();
          toggleTTSPlayPause();
        }
        break;
      case 'Escape':
        if (document.querySelector('.settings-panel.open')) {
          closeSettings();
        } else if (document.querySelector('.drawer.open')) {
          closeToc();
        } else {
          goBackToLibrary();
        }
        break;
    }
  });

  // Swipe/tap-to-change-chapter gestures intentionally removed.
  // Users navigate chapters using the prev/next buttons in the footer.
}

// ===== OFFLINE DETECTION =====
function updateOfflineStatus() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  
  if (!navigator.onLine) {
    banner.classList.add('visible');
  } else {
    banner.classList.remove('visible');
  }
}

window.addEventListener('online', () => {
  updateOfflineStatus();
  showToast('Back online');
});

window.addEventListener('offline', () => {
  updateOfflineStatus();
});

// Check on load
updateOfflineStatus();

// ===== PERSIST STATE ON APP CLOSE/HIDE =====
// visibilitychange fires reliably on mobile when switching apps or closing tabs
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushState();
  }
});

// beforeunload fires on desktop tab close / refresh
window.addEventListener('beforeunload', () => {
  flushState();
});

function flushState() {
  // Save current scroll position
  const container = document.getElementById('reader-content');
  if (container && AppState.currentBook) {
    saveScrollPosition(container);
  }
  // Settings are debounced — force an immediate save
  if (AppState.settings) {
    saveSettings(AppState.settings);
  }
}

// Service worker update detection
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // New service worker activated — app is up to date
  });
}

// Make functions available globally for inline event handlers
window.importBook = importBook;
window.openBook = openBook;
