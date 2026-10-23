/* Kyrie: Claude-written cards through this site's own server (server.mjs).
   The site owner's API key stays on the server; visitors need no key. */
(function () {
  R.ai = {
    status: { ai: false },

    // Is Claude set up on this site? (No server, e.g. opened as a file: no.)
    check() {
      return (R.ai.ready = fetch('api/status', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { ai: false }))
        .catch(() => ({ ai: false }))
        .then((j) => (R.ai.status = { ai: !!j.ai })));
    },
    enabled: () => R.ai.status.ai,

    // sources: [{ name, text, images }] -> { title, cards }
    async generate(sources, { count = 'auto', focus = '', status, signal } = {}) {
      const body = {
        count,
        focus,
        sources: sources.map((s) => ({
          name: s.name,
          text: s.text || '',
          images: (s.images || []).map((img) => ({ mediaType: img.mediaType, data: img.dataUrl.split(',')[1] })),
        })),
      };
      status?.('Claude is reading your material');
      let res;
      try {
        res = await fetch('api/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new Error('Could not reach the server. Check your connection and try again.');
      }
      if (!res.ok || !res.body) {
        let msg = '';
        try {
          msg = (await res.json()).message;
        } catch (_) {}
        throw new Error(msg || `The server returned an error (${res.status}).`);
      }

      // One JSON object per line: progress updates, then done or error.
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        buf += dec.decode(value || new Uint8Array(), { stream: !done });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch (_) {
            continue;
          }
          if (msg.type === 'progress') status?.(msg.of > 1 ? `Claude is writing cards (part ${msg.part} of ${msg.of})` : 'Claude is reading your material and writing cards');
          if (msg.type === 'error') throw new Error(msg.message);
          if (msg.type === 'done') return { title: msg.title, cards: msg.cards.map(R.newCard) };
        }
        if (done) break;
      }
      throw new Error('The connection closed before the cards were ready. Try again.');
    },
  };
})();
