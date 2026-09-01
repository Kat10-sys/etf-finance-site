(function () {
  const btn = document.getElementById('navToggle');
  const links = document.getElementById('navLinks');
  if (!btn || !links) return;

  function setOpen(open) {
    links.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
  }

  btn.addEventListener('click', () => setOpen(!links.classList.contains('open')));
  links.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
  window.addEventListener('resize', () => {
    if (window.innerWidth > 720) setOpen(false);
  });
})();
