/* Kyrie: turn uploaded files into study text (and images for Claude / OCR). */
(function () {
  const LIB = {
    pdf: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    mammoth: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
    jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  };

  const ext = (name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const readText = (file) => file.text();
  const readBuf = (file) => file.arrayBuffer();
  const readDataUrl = (blob) =>
    new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });

  // Shrink big photos so they OCR faster and fit in an API request.
  async function shrinkImage(dataUrl, max = 1600) {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('That image could not be read'));
      i.src = dataUrl;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { dataUrl: c.toDataURL('image/jpeg', 0.86), mediaType: 'image/jpeg' };
  }

  // HTML (from .docx, .html) to light markdown so headings, bold terms, lists and tables survive.
  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
    const out = [];
    const inline = (n) => {
      let s = '';
      for (const c of n.childNodes) {
        if (c.nodeType === 3) s += c.textContent;
        else if (c.nodeType === 1) {
          const t = c.tagName;
          if (t === 'BR') s += '\n';
          else if (t === 'STRONG' || t === 'B') {
            const inner = inline(c).trim();
            s += inner ? ` **${inner}** ` : '';
          } else s += inline(c);
        }
      }
      return s.replace(/[ \t]+/g, ' ');
    };
    const walk = (n) => {
      for (const c of n.children) {
        const t = c.tagName;
        if (/^H[1-6]$/.test(t)) out.push('', '#'.repeat(+t[1]) + ' ' + inline(c).replace(/\*\*/g, '').trim(), '');
        else if (t === 'P' || t === 'BLOCKQUOTE' || t === 'DT' || t === 'DD') out.push(inline(c).trim(), '');
        else if (t === 'LI') {
          const own = Array.from(c.childNodes).filter((x) => !(x.nodeType === 1 && /^(UL|OL)$/.test(x.tagName)));
          const tmp = document.createElement('div');
          own.forEach((x) => tmp.appendChild(x.cloneNode(true)));
          out.push('- ' + inline(tmp).trim());
          c.querySelectorAll(':scope > ul, :scope > ol').forEach(walk);
        } else if (t === 'TR') {
          const cells = Array.from(c.children).map((td) => inline(td).replace(/\*\*/g, '').trim()).filter(Boolean);
          if (cells.length === 2) out.push(`${cells[0]}: ${cells[1]}`);
          else if (cells.length) out.push(cells.join(' | '));
        } else if (t === 'TABLE' || t === 'TBODY' || t === 'THEAD' || t === 'UL' || t === 'OL' || t === 'DL' || t === 'DIV' || t === 'SECTION' || t === 'ARTICLE' || t === 'MAIN' || t === 'BODY') {
          walk(c);
          if (t === 'TABLE' || t === 'UL' || t === 'OL') out.push('');
        } else if (c.children.length) walk(c);
        else {
          const s = inline(c).trim();
          if (s) out.push(s, '');
        }
      }
    };
    walk(doc.body);
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  async function pdf(file, status) {
    await R.loadScript(LIB.pdf);
    pdfjsLib.GlobalWorkerOptions.workerSrc = LIB.pdfWorker;
    const doc = await pdfjsLib.getDocument({ data: await readBuf(file) }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      status?.(`Reading page ${p} of ${doc.numPages}`);
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      // Rebuild lines from positioned text runs, then find paragraph breaks from the
      // page's own line spacing (a gap clearly bigger than usual starts a new paragraph).
      const rows = [];
      let cur = null;
      for (const it of tc.items) {
        if (!('str' in it)) continue;
        const y = it.transform[5];
        const h = it.height || Math.abs(it.transform[3]) || 10;
        const x = it.transform[4];
        if (!cur || Math.abs(y - cur.y) > Math.max(2, h * 0.5)) {
          if (cur && cur.text.trim()) rows.push(cur);
          cur = { y, text: '', end: null };
        }
        // Pieces that touch belong to the same word; a visible gap means a space.
        const touching = cur.end !== null && x - cur.end < h * 0.12;
        cur.text += (cur.text && !touching && !cur.text.endsWith(' ') && !it.str.startsWith(' ') && it.str ? ' ' : '') + it.str;
        if (it.str) cur.end = x + (it.width || 0);
      }
      if (cur && cur.text.trim()) rows.push(cur);
      const gaps = rows.slice(1).map((r, k) => Math.abs(rows[k].y - r.y)).filter((g) => g > 0).sort((a, b) => a - b);
      const usual = gaps[Math.floor(gaps.length / 2)] || 12;
      const lines = [];
      rows.forEach((r, k) => {
        if (k && Math.abs(rows[k - 1].y - r.y) > usual * 1.45) lines.push('');
        lines.push(r.text.trim());
      });
      pages.push(lines.join('\n'));
    }
    const text = pages.join('\n\n');
    // Scanned PDF (no text layer): render pages so they can be read by OCR or Claude.
    if (text.replace(/\s/g, '').length < 40 * doc.numPages) {
      const images = [];
      const n = Math.min(doc.numPages, 24);
      for (let p = 1; p <= n; p++) {
        status?.(`Scanning page ${p} of ${n}`);
        const page = await doc.getPage(p);
        const vp = page.getViewport({ scale: 1.6 });
        const c = document.createElement('canvas');
        c.width = vp.width;
        c.height = vp.height;
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        images.push(await shrinkImage(c.toDataURL('image/jpeg', 0.9)));
      }
      return { text: '', images, note: `scanned, ${R.plural(n, 'page')}` };
    }
    return { text, note: R.plural(doc.numPages, 'page') };
  }

  async function docx(file) {
    await R.loadScript(LIB.mammoth);
    const res = await mammoth.convertToHtml({ arrayBuffer: await readBuf(file) });
    return { text: htmlToText(res.value) };
  }

  async function pptx(file, status) {
    await R.loadScript(LIB.jszip);
    const zip = await JSZip.loadAsync(await readBuf(file));
    const num = (p) => +(p.match(/(\d+)\.xml$/)?.[1] || 0);
    const slides = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => num(a) - num(b));
    const notes = Object.keys(zip.files).filter((p) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p));
    const parser = new DOMParser();
    const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const PNS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    const paras = (xml) => {
      const d = parser.parseFromString(xml, 'application/xml');
      const shapes = Array.from(d.getElementsByTagNameNS(PNS, 'sp'));
      const out = { title: '', body: [] };
      for (const sp of shapes) {
        const ph = sp.getElementsByTagNameNS(PNS, 'ph')[0];
        const type = ph?.getAttribute('type') || '';
        if (/sldNum|dt|ftr|hdr/.test(type)) continue;
        const ps = Array.from(sp.getElementsByTagNameNS(A, 'p'))
          .map((p) => Array.from(p.getElementsByTagNameNS(A, 't')).map((t) => t.textContent).join('').trim())
          .filter(Boolean);
        if (/title|ctrTitle/.test(type) && !out.title) out.title = ps.join(' ');
        else out.body.push(...ps);
      }
      return out;
    };
    const parts = [];
    for (let i = 0; i < slides.length; i++) {
      status?.(`Reading slide ${i + 1} of ${slides.length}`);
      const s = paras(await zip.file(slides[i]).async('string'));
      const n = notes.find((p) => num(p) === num(slides[i]));
      if (s.title) parts.push(`# ${s.title}`);
      parts.push(...s.body.map((b) => (b.length < 140 && !/[.!?]$/.test(b) ? `- ${b}` : b)));
      if (n) {
        const nt = paras(await zip.file(n).async('string')).body.filter((t) => !/^\d+$/.test(t));
        if (nt.length) parts.push('', ...nt);
      }
      parts.push('');
    }
    return { text: parts.join('\n'), note: R.plural(slides.length, 'slide') };
  }

  function csv(text, sep) {
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (sep === '\t') {
        rows.push(line.split('\t'));
        continue;
      }
      const cells = [];
      let cur = '';
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
          if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
          else if (ch === '"') q = false;
          else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === ',') cells.push(cur), (cur = '');
        else cur += ch;
      }
      cells.push(cur);
      rows.push(cells);
    }
    // Drop a header row like "term, definition".
    if (rows[0] && /^(term|terms|word|front|question|concept|vocab\w*|name)$/i.test(rows[0][0]?.trim()) && /^(definition|definitions|meaning|back|answer|description)$/i.test(rows[0][1]?.trim())) rows.shift();
    return rows
      .filter((r) => r.filter((c) => c.trim()).length >= 2)
      .map((r) => `${r[0].trim()}\t${r.slice(1).join(' ').trim()}`)
      .join('\n');
  }

  const rtf = (s) =>
    s
      .replace(/\\par[d]?/g, '\n')
      .replace(/\{\\\*[^{}]*\}/g, '')
      .replace(/\\'[0-9a-f]{2}/gi, '')
      .replace(/\\[a-z]+-?\d* ?/gi, '')
      .replace(/[{}]/g, '')
      .trim();

  R.parse = {
    accept: '.txt,.md,.markdown,.pdf,.docx,.pptx,.csv,.tsv,.html,.htm,.rtf,.json,image/*',

    // -> { name, text, images?, deck?, note? }
    async file(file, status) {
      const e = ext(file.name);
      const base = { name: file.name, size: file.size };
      if (file.type.startsWith('image/') || /^(png|jpe?g|gif|webp|bmp|heic)$/.test(e)) {
        const img = await shrinkImage(await readDataUrl(file));
        return { ...base, text: '', images: [img], note: 'image' };
      }
      if (e === 'pdf') return { ...base, ...(await pdf(file, status)) };
      if (e === 'docx') return { ...base, ...(await docx(file)) };
      if (e === 'pptx') return { ...base, ...(await pptx(file, status)) };
      if (e === 'doc' || e === 'ppt') throw new Error(`Old .${e} files are not supported. Save it as .${e}x or PDF first.`);
      const text = await readText(file);
      if (e === 'json') {
        try {
          const j = JSON.parse(text);
          if (j && (j.kyrie || j.recall) && Array.isArray(j.cards)) return { ...base, text: '', deck: j, note: R.plural(j.cards.length, 'card') };
        } catch (_) {}
        return { ...base, text };
      }
      if (e === 'csv') return { ...base, text: csv(text, ','), note: 'table' };
      if (e === 'tsv') return { ...base, text: csv(text, '\t'), note: 'table' };
      if (e === 'html' || e === 'htm') return { ...base, text: htmlToText(text) };
      if (e === 'rtf') return { ...base, text: rtf(text) };
      return { ...base, text };
    },

    // Read text out of images without any server (runs in the browser).
    async ocr(images, status) {
      await R.loadScript(LIB.tesseract);
      status?.('Loading text recognition');
      const worker = await Tesseract.createWorker('eng', 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') status?.(`Reading image text ${Math.round(m.progress * 100)}%`);
        },
      });
      const out = [];
      for (let i = 0; i < images.length; i++) {
        status?.(`Reading image ${i + 1} of ${images.length}`);
        const { data } = await worker.recognize(images[i].dataUrl);
        out.push(data.text);
      }
      await worker.terminate();
      return out.join('\n\n');
    },
  };
})();
