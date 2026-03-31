/**
 * OpenShelf EPUB Parser
 * Parses EPUB files using JSZip — handles container.xml → content.opf → spine → chapters
 */

const JSZIP_CDN = 'https://esm.sh/jszip@3.10.1';
let JSZip = null;

async function loadJSZip() {
  if (JSZip) return JSZip;
  const mod = await import(JSZIP_CDN);
  JSZip = mod.default || mod;
  return JSZip;
}

/**
 * Parse an EPUB file from a File/Blob object
 * Returns: { id, title, author, cover, chapters: [{id, title, href, html}], toc }
 */
export async function parseEpub(file) {
  const Zip = await loadJSZip();
  const arrayBuffer = await file.arrayBuffer();
  const zip = await Zip.loadAsync(arrayBuffer);

  // 1. Find container.xml to locate the .opf file
  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXml) throw new Error('Invalid EPUB: missing container.xml');

  const parser = new DOMParser();
  const containerDoc = parser.parseFromString(containerXml, 'application/xml');
  const rootfilePath = containerDoc.querySelector('rootfile')?.getAttribute('full-path');
  if (!rootfilePath) throw new Error('Invalid EPUB: no rootfile found');

  const opfDir = rootfilePath.substring(0, rootfilePath.lastIndexOf('/') + 1);

  // 2. Parse the OPF (content.opf)
  const opfXml = await zip.file(rootfilePath)?.async('text');
  if (!opfXml) throw new Error('Invalid EPUB: cannot read OPF file');
  const opfDoc = parser.parseFromString(opfXml, 'application/xml');

  // 3. Extract metadata
  const title = getMetaContent(opfDoc, 'title') || file.name.replace(/\.epub$/i, '');
  const author = getMetaContent(opfDoc, 'creator') || 'Unknown Author';

  // 4. Build manifest map (id → {href, mediaType})
  const manifestMap = {};
  const manifestItems = opfDoc.querySelectorAll('manifest > item');
  manifestItems.forEach(item => {
    manifestMap[item.getAttribute('id')] = {
      href: item.getAttribute('href'),
      mediaType: item.getAttribute('media-type')
    };
  });

  // 5. Get spine order
  const spineItems = opfDoc.querySelectorAll('spine > itemref');
  const spineOrder = [];
  spineItems.forEach(ref => {
    const idref = ref.getAttribute('idref');
    if (manifestMap[idref]) {
      spineOrder.push({
        id: idref,
        href: manifestMap[idref].href,
        mediaType: manifestMap[idref].mediaType
      });
    }
  });

  // 6. Parse TOC (NCX or NAV)
  const toc = await parseToc(zip, opfDoc, manifestMap, opfDir);

  // 7. Load chapter content — merge spine items that belong to the same logical chapter
  const rawSpineContent = [];
  for (let i = 0; i < spineOrder.length; i++) {
    const item = spineOrder[i];
    const chapterPath = opfDir + item.href;
    let html = await zip.file(chapterPath)?.async('text');
    
    if (html) {
      html = await processImages(html, zip, opfDir, item.href);
      html = await processCSS(html, zip, opfDir, item.href);
    }

    rawSpineContent.push({
      id: item.id,
      href: item.href,
      html: html || '',
      tocTitle: findTocTitle(toc, item.href)
    });
  }

  // Merge strategy: each spine item that has a TOC entry starts a new chapter.
  // Spine items without a TOC entry are appended to the previous chapter.
  // This handles EPUBs that split one logical chapter across multiple XHTML files.
  const chapters = [];
  let chapterCounter = 0;

  for (let i = 0; i < rawSpineContent.length; i++) {
    const item = rawSpineContent[i];
    const bodyHtml = extractBody(item.html);
    const hasTocEntry = !!item.tocTitle;
    const hasHeading = !!extractHeading(item.html);
    // A spine item starts a new chapter if it has a TOC entry, or has a heading
    // and isn't just a continuation fragment (very short items without headings merge)
    const startsNewChapter = hasTocEntry || hasHeading || chapters.length === 0;

    if (startsNewChapter || chapters.length === 0) {
      chapterCounter++;
      const title = item.tocTitle || extractHeading(item.html) || `Chapter ${chapterCounter}`;
      chapters.push({
        id: item.id,
        href: item.href,
        title: title,
        html: bodyHtml || '<p>Empty chapter</p>'
      });
    } else {
      // Merge into previous chapter with a separator
      const prev = chapters[chapters.length - 1];
      prev.html += '\n<hr class="epub-section-break" style="margin:1.5em 0;border:none;border-top:1px solid currentColor;opacity:0.15;"/>\n' + bodyHtml;
    }
  }

  // 8. Extract cover image
  const cover = await extractCover(zip, opfDoc, manifestMap, opfDir);

  return {
    id: generateId(),
    title,
    author,
    cover,
    chapters,
    toc,
    progress: 0,
    currentChapter: 0,
    lastRead: Date.now()
  };
}

// ===== HELPER FUNCTIONS =====

function getMetaContent(doc, name) {
  // Try dc:title, dc:creator etc.
  const el = doc.querySelector(`metadata > *|${name}, metadata ${name}`);
  return el?.textContent?.trim() || null;
}

async function parseToc(zip, opfDoc, manifestMap, opfDir) {
  const toc = [];

  // Try NCX first
  const ncxId = opfDoc.querySelector('spine')?.getAttribute('toc');
  if (ncxId && manifestMap[ncxId]) {
    const ncxPath = opfDir + manifestMap[ncxId].href;
    const ncxXml = await zip.file(ncxPath)?.async('text');
    if (ncxXml) {
      const parser = new DOMParser();
      const ncxDoc = parser.parseFromString(ncxXml, 'application/xml');
      const navPoints = ncxDoc.querySelectorAll('navMap > navPoint');
      navPoints.forEach(np => {
        const label = np.querySelector('navLabel > text')?.textContent?.trim();
        const src = np.querySelector('content')?.getAttribute('src');
        if (label && src) {
          toc.push({ title: label, href: src.split('#')[0], fragment: src.includes('#') ? src.split('#')[1] : null });
          // Nested nav points
          const subPoints = np.querySelectorAll(':scope > navPoint');
          subPoints.forEach(snp => {
            const subLabel = snp.querySelector('navLabel > text')?.textContent?.trim();
            const subSrc = snp.querySelector('content')?.getAttribute('src');
            if (subLabel && subSrc) {
              toc.push({ title: subLabel, href: subSrc.split('#')[0], fragment: subSrc.includes('#') ? subSrc.split('#')[1] : null, nested: true });
            }
          });
        }
      });
    }
  }

  // Try NAV (EPUB3)
  if (toc.length === 0) {
    for (const [id, item] of Object.entries(manifestMap)) {
      if (item.mediaType === 'application/xhtml+xml') {
        const navPath = opfDir + item.href;
        const navHtml = await zip.file(navPath)?.async('text');
        if (navHtml && navHtml.includes('epub:type="toc"')) {
          const parser = new DOMParser();
          const navDoc = parser.parseFromString(navHtml, 'application/xhtml+xml');
          const navElement = navDoc.querySelector('[epub\\:type="toc"], nav');
          if (navElement) {
            const links = navElement.querySelectorAll('a');
            links.forEach(a => {
              const href = a.getAttribute('href');
              if (href) {
                toc.push({
                  title: a.textContent.trim(),
                  href: href.split('#')[0],
                  fragment: href.includes('#') ? href.split('#')[1] : null
                });
              }
            });
          }
          break;
        }
      }
    }
  }

  return toc;
}

/**
 * Extract body content from an XHTML document — strips <html>, <head>, <body> wrappers
 */
function extractBody(html) {
  if (!html) return '';
  // Greedy match to capture ALL content within body
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) return bodyMatch[1].trim();
  
  // If no body tag, try stripping head from html wrapper
  const htmlMatch = html.match(/<html[^>]*>([\s\S]*)<\/html>/i);
  if (htmlMatch) {
    const inner = htmlMatch[1];
    const innerBody = inner.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (innerBody) return innerBody[1].trim();
    return inner.replace(/<head[^>]*>[\s\S]*<\/head>/i, '').trim();
  }
  
  // Return as-is if no wrappers detected
  return html.trim();
}

function findTocTitle(toc, href) {
  const cleanHref = href.split('#')[0];
  const entry = toc.find(t => t.href === cleanHref || t.href.endsWith('/' + cleanHref));
  return entry?.title || null;
}

function extractHeading(html) {
  if (!html) return null;
  const match = html.match(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/i);
  if (match) {
    return match[1].replace(/<[^>]+>/g, '').trim().substring(0, 80);
  }
  return null;
}

async function processImages(html, zip, opfDir, chapterHref) {
  const chapterDir = chapterHref.substring(0, chapterHref.lastIndexOf('/') + 1);
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  const svgImageRegex = /<image[^>]+(?:xlink:)?href=["']([^"']+)["'][^>]*>/gi;
  
  let result = html;
  const matches = [...html.matchAll(imgRegex), ...html.matchAll(svgImageRegex)];

  for (const match of matches) {
    const src = match[1];
    if (src.startsWith('data:')) continue;
    
    const imgPath = resolveHref(opfDir + chapterDir, src);
    const imgFile = zip.file(imgPath);
    if (imgFile) {
      try {
        const imgData = await imgFile.async('base64');
        const ext = src.split('.').pop().toLowerCase();
        const mimeTypes = { 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'svg': 'image/svg+xml', 'webp': 'image/webp' };
        const mime = mimeTypes[ext] || 'image/png';
        const dataUri = `data:${mime};base64,${imgData}`;
        result = result.replace(match[0], match[0].replace(src, dataUri));
      } catch (e) {
        // Skip if image can't be loaded
      }
    }
  }

  return result;
}

async function processCSS(html, zip, opfDir, chapterHref) {
  const chapterDir = chapterHref.substring(0, chapterHref.lastIndexOf('/') + 1);
  const linkRegex = /<link[^>]+href=["']([^"']+\.css)["'][^>]*\/?>/gi;
  
  let result = html;
  const matches = [...html.matchAll(linkRegex)];
  
  for (const match of matches) {
    const cssHref = match[1];
    const cssPath = resolveHref(opfDir + chapterDir, cssHref);
    const cssFile = zip.file(cssPath);
    if (cssFile) {
      try {
        // Skip external CSS — we override with our own styles
        result = result.replace(match[0], '');
      } catch (e) {}
    }
  }
  
  // Also remove <style> tags from EPUB content
  result = result.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  
  return result;
}

function resolveHref(base, href) {
  if (href.startsWith('/')) return href.substring(1);
  
  const parts = base.split('/').filter(Boolean);
  const hrefParts = href.split('/');
  
  for (const part of hrefParts) {
    if (part === '..') {
      parts.pop();
    } else if (part !== '.') {
      parts.push(part);
    }
  }
  
  return parts.join('/');
}

async function extractCover(zip, opfDoc, manifestMap, opfDir) {
  // Method 1: meta cover
  const coverMeta = opfDoc.querySelector('meta[name="cover"]');
  if (coverMeta) {
    const coverId = coverMeta.getAttribute('content');
    if (manifestMap[coverId]) {
      return await getImageDataUri(zip, opfDir + manifestMap[coverId].href);
    }
  }

  // Method 2: item with properties="cover-image"
  const coverItem = opfDoc.querySelector('item[properties~="cover-image"]');
  if (coverItem) {
    const href = coverItem.getAttribute('href');
    return await getImageDataUri(zip, opfDir + href);
  }

  // Method 3: look for common cover filenames
  const coverNames = ['cover.jpg', 'cover.jpeg', 'cover.png', 'Cover.jpg', 'Cover.jpeg', 'Cover.png', 'images/cover.jpg', 'Images/cover.jpg'];
  for (const name of coverNames) {
    const coverPath = opfDir + name;
    if (zip.file(coverPath)) {
      return await getImageDataUri(zip, coverPath);
    }
  }

  // Method 4: find any item with 'cover' in id
  for (const [id, item] of Object.entries(manifestMap)) {
    if (id.toLowerCase().includes('cover') && item.mediaType?.startsWith('image/')) {
      return await getImageDataUri(zip, opfDir + item.href);
    }
  }

  return null;
}

async function getImageDataUri(zip, path) {
  const file = zip.file(path);
  if (!file) return null;
  try {
    const data = await file.async('base64');
    const ext = path.split('.').pop().toLowerCase();
    const mimeTypes = { 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'svg': 'image/svg+xml', 'webp': 'image/webp' };
    const mime = mimeTypes[ext] || 'image/png';
    return `data:${mime};base64,${data}`;
  } catch (e) {
    return null;
  }
}

function generateId() {
  return 'book_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
}

/**
 * Extract plain text from a chapter's HTML for TTS
 */
export function extractTextFromHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  
  // Remove script and style elements
  div.querySelectorAll('script, style, nav, header, footer').forEach(el => el.remove());
  
  const text = div.textContent || div.innerText || '';
  // Clean up whitespace
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Split text into sentences for TTS processing
 */
export function splitIntoSentences(text) {
  if (!text) return [];
  
  // Split on sentence boundaries, keeping the punctuation
  const raw = text.match(/[^.!?]+[.!?]+[\s]*/g) || [text];
  
  // Filter out very short fragments and trim
  return raw
    .map(s => s.trim())
    .filter(s => s.length > 2);
}
