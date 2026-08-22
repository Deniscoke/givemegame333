(function educatorShellModule(root, factory) {
  'use strict';

  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EduShell = api;
})(typeof window !== 'undefined' ? window : null, function createEducatorShell(root) {
  'use strict';

  const STUDENT_ITEMS = Object.freeze([
    Object.freeze({ href: '/student/', label: 'Prehľad', group: 'primary' }),
    Object.freeze({ href: '/student/#activities', label: 'Moje aktivity', group: 'primary' }),
    Object.freeze({ href: '/student/#progress', label: 'Pokrok', group: 'primary' }),
  ]);

  const EDUCATOR_ITEMS = Object.freeze([
    Object.freeze({ href: '/edu/index.html', label: 'Prehľad', group: 'primary' }),
    Object.freeze({ href: '/index.html', label: 'Vytvoriť aktivitu', group: 'primary' }),
    Object.freeze({ href: '/index.html', label: 'Knižnica a živé hry', group: 'primary' }),
    Object.freeze({ href: '/edu/classes.html', label: 'Triedy', group: 'primary' }),
    Object.freeze({ href: '/edu/assessments.html', label: 'Assessmenty', group: 'primary' }),
    Object.freeze({ href: '/institution/', label: 'Výsledky INVOK', group: 'primary' }),
    Object.freeze({ href: '/account.html', label: 'Účet', group: 'primary' }),
    Object.freeze({ href: '/edu/gradebook.html', label: 'Klasifikácia', group: 'school' }),
    Object.freeze({ href: '/edu/attendance.html', label: 'Dochádzka', group: 'school' }),
    Object.freeze({ href: '/edu/members.html', label: 'Členovia', group: 'school' }),
    Object.freeze({ href: '/edu/perk-requests.html', label: 'Odmeny', group: 'school' }),
  ]);

  function itemsForRole(role) {
    const source = role === 'student'
      ? STUDENT_ITEMS
      : role === 'teacher' || role === 'admin'
        ? EDUCATOR_ITEMS
        : [];
    return source.map((item) => ({ ...item }));
  }

  function canonicalPath(pathname) {
    const path = String(pathname || '/').split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
    if (path === '/edu' || path === '/edu/index.html') return '/edu/';
    if (path === '/student' || path === '/student/index.html') return '/student/';
    if (path === '/institution' || path === '/institution/index.html') return '/institution/';
    return path;
  }

  function appendLink(document, list, item, activeItem) {
    const listItem = document.createElement('li');
    const link = document.createElement('a');
    link.setAttribute('href', item.href);
    link.setAttribute('data-shell-route', '');
    link.textContent = item.label;
    if (item === activeItem) {
      link.className = 'active';
      link.setAttribute('aria-current', 'page');
    }
    listItem.append(link);
    list.append(listItem);
  }

  function activeItemFor(items, pathname, role) {
    const current = canonicalPath(pathname);
    if (role === 'student' && current === '/edu/assessments.html') {
      return items.find((item) => item.label === 'Moje aktivity') || null;
    }
    return items.find((item) => canonicalPath(item.href) === current) || null;
  }

  function appendGroup(document, nav, items, group, label, activeItem) {
    const groupedItems = items.filter((item) => item.group === group);
    if (!groupedItems.length) return;

    const section = document.createElement('div');
    section.className = 'edu-nav-group';
    if (label) {
      const heading = document.createElement('p');
      heading.className = 'edu-nav-group-label';
      heading.textContent = label;
      section.append(heading);
    }
    const list = document.createElement('ul');
    list.className = 'edu-sidebar-nav';
    groupedItems.forEach((item) => appendLink(document, list, item, activeItem));
    section.append(list);
    nav.append(section);
  }

  function mount({ root: mountRoot, role, pathname } = {}) {
    if (!mountRoot || typeof mountRoot.replaceChildren !== 'function') return null;
    const document = mountRoot.ownerDocument || (root && root.document);
    if (!document || typeof document.createElement !== 'function') return null;

    const resolvedRole = role || root?.EduAuth?.getProfile?.()?.school?.role || null;
    const items = itemsForRole(resolvedRole);
    const activeItem = activeItemFor(items, pathname || root?.location?.pathname || '/', resolvedRole);
    const nav = document.createElement('nav');
    nav.className = 'edu-sidebar';
    nav.setAttribute('aria-label', 'Navigácia EDU');
    nav.setAttribute('data-current-path', pathname || root?.location?.pathname || '/');

    const brand = document.createElement('a');
    brand.className = 'edu-sidebar-brand';
    brand.setAttribute('href', resolvedRole === 'student' ? '/student/' : '/edu/');
    brand.setAttribute('aria-label', 'gIVEME EDU domov');
    const title = document.createElement('span');
    title.className = 'edu-sidebar-title';
    title.textContent = 'gIVEME';
    const badge = document.createElement('strong');
    badge.className = 'brand-badge';
    badge.textContent = canonicalPath(pathname) === '/institution/' ? 'INVOK' : 'EDU';
    brand.append(title, badge);
    nav.append(brand);

    appendGroup(document, nav, items, 'primary', 'Hlavná navigácia', activeItem);
    appendGroup(document, nav, items, 'school', 'Správa školy', activeItem);

    const footer = document.createElement('div');
    footer.className = 'edu-sidebar-footer';
    const back = document.createElement('a');
    back.setAttribute('href', '/index.html');
    back.textContent = '← gIVEMEGAME';
    footer.append(back);
    nav.append(footer);

    const toggle = document.createElement('button');
    toggle.className = 'edu-shell-toggle';
    toggle.setAttribute('type', 'button');
    toggle.setAttribute('aria-label', 'Otvoriť navigáciu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = 'Menu';
    if (typeof toggle.addEventListener === 'function') {
      toggle.addEventListener('click', () => {
        const open = nav.classList.toggle('open');
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? 'Zavrieť navigáciu' : 'Otvoriť navigáciu');
      });
    }

    mountRoot.replaceChildren(nav, toggle);
    return nav;
  }

  async function loadRoleWithoutRedirect() {
    const cachedRole = root?.EduAuth?.getProfile?.()?.school?.role;
    if (cachedRole) return cachedRole;
    if (!root?.EduAuth?.getAccessToken || typeof root.fetch !== 'function') return null;

    try {
      const token = await root.EduAuth.getAccessToken();
      if (!token) return null;
      const response = await root.fetch('/api/edu/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;
      const profile = await response.json();
      return profile?.school?.role || null;
    } catch (_error) {
      return null;
    }
  }

  async function autoMount() {
    const mountRoot = root?.document?.querySelector?.('[data-edu-shell][data-edu-shell-autoload]');
    if (!mountRoot) return;
    mount({ root: mountRoot, role: null, pathname: root.location?.pathname });
    const role = await loadRoleWithoutRedirect();
    if (role) mount({ root: mountRoot, role, pathname: root.location?.pathname });
  }

  if (root?.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', autoMount, { once: true });
    } else {
      autoMount();
    }
  }

  return Object.freeze({ itemsForRole, mount });
});
