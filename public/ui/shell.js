(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ProductShell = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function setActiveNavigation(root, pathname) {
    if (!root) return;
    root.querySelectorAll('[data-shell-route]').forEach(link => {
      const active = pathname === link.getAttribute('href')
        || pathname.startsWith(link.dataset.shellRoute || '__never__');
      link.toggleAttribute('aria-current', active);
    });
  }

  function toggleMenu(button, panel) {
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    panel.hidden = expanded;
  }

  return { setActiveNavigation, toggleMenu };
});
