(function () {
  // Keeps a toggle-button group's aria-pressed state in sync with the
  // 'active' CSS class that already drives its styling. These buttons
  // behave like a radio group (exactly one active at a time -- range,
  // currency, metric, and mode selectors across the site) but previously
  // exposed no state to assistive tech, which just heard several
  // identically-behaving buttons with no indication which was selected.
  window.setActiveButton = function (buttons, predicate) {
    buttons.forEach((b) => {
      const isActive = predicate(b);
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  };
})();
