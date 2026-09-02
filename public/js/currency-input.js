(function () {
  // Formats a plain-number text input with thousands separators as the user
  // types (e.g. "1000000" -> "1,000,000"), while still allowing a single
  // decimal point. Kept as text/inputmode="decimal" rather than
  // type="number", since number inputs reject the comma characters outright.
  function formatMoneyLike(raw) {
    let cleaned = String(raw || '').replace(/[^\d.]/g, '');
    const firstDot = cleaned.indexOf('.');
    if (firstDot !== -1) {
      cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '').slice(0, 2);
    }
    const [intPart, decPart] = cleaned.split('.');
    const formattedInt = (intPart || '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return decPart !== undefined ? `${formattedInt}.${decPart}` : formattedInt;
  }

  window.enableThousandsFormatting = function (input) {
    input.addEventListener('input', () => {
      const cursorFromEnd = input.value.length - input.selectionStart;
      input.value = formatMoneyLike(input.value);
      const pos = Math.max(0, input.value.length - cursorFromEnd);
      input.setSelectionRange(pos, pos);
    });
  };

  // Exposed so callers can format a value programmatically (e.g. right
  // after setting input.value from a URL param, which doesn't fire the
  // 'input' event above).
  window.formatThousands = formatMoneyLike;

  // Reads a formatted input's value back out as a plain number, the same
  // way Number(input.value) would work on a real number input.
  window.parseFormattedNumber = function (value) {
    return Number(String(value || '').replace(/,/g, '')) || 0;
  };
})();
