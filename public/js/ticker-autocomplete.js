(function () {
  // Wires a text input to a <datalist> populated from /api/ticker-search,
  // debounced so typing doesn't fire a request per keystroke. Falls back
  // silently to plain typing if the lookup fails -- this is a convenience,
  // not something the input should ever depend on.
  window.enableTickerAutocomplete = function (input, datalistId) {
    let datalist = document.getElementById(datalistId);
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = datalistId;
      document.body.appendChild(datalist);
    }
    input.setAttribute('list', datalistId);
    input.setAttribute('autocomplete', 'off');

    let debounceTimer = null;
    let lastQuery = null;
    input.addEventListener('input', () => {
      const q = input.value.trim();
      if (q === lastQuery) return;
      clearTimeout(debounceTimer);
      if (q.length < 1) {
        datalist.innerHTML = '';
        lastQuery = q;
        return;
      }
      debounceTimer = setTimeout(async () => {
        lastQuery = q;
        try {
          const res = await fetch(`/api/ticker-search?q=${encodeURIComponent(q)}`);
          const data = await res.json();
          // Two lookups can be in flight at once if the user paused just
          // over the debounce delay twice in a row -- if a slower, now-
          // stale response lands after a newer query already replaced it,
          // applying it here would silently show suggestions for text the
          // input no longer has.
          if (input.value.trim() !== q) return;
          datalist.innerHTML = '';
          (data.results || []).forEach((r) => {
            const opt = document.createElement('option');
            opt.value = r.symbol;
            if (r.name) opt.textContent = r.name;
            datalist.appendChild(opt);
          });
        } catch (e) {
          // ignore -- suggestions are best-effort
        }
      }, 250);
    });
  };
})();
