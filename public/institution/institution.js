(function institutionModule(root, factory) {
  'use strict';

  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.InstitutionDashboard = api;
})(typeof window !== 'undefined' ? window : null, function createInstitutionModule(root) {
  'use strict';

  class InstitutionApiError extends Error {
    constructor(message, { status = 0, code = 'API_ERROR' } = {}) {
      super(message);
      this.name = 'InstitutionApiError';
      this.status = status;
      this.code = code;
    }
  }

  function appendQuery(path, filters = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    const suffix = query.toString();
    return suffix ? `${path}?${suffix}` : path;
  }

  function createInstitutionApi({ getAccessToken, fetchImpl = fetch } = {}) {
    if (typeof getAccessToken !== 'function') {
      throw new TypeError('createInstitutionApi requires getAccessToken');
    }
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('createInstitutionApi requires fetchImpl');
    }

    async function request(path, { accept = 'application/json', responseType = 'json' } = {}) {
      const token = await getAccessToken();
      if (!token) {
        throw new InstitutionApiError('Prihlásenie vypršalo. Prihláste sa znova.', {
          status: 401,
          code: 'AUTH_REQUIRED',
        });
      }

      const response = await fetchImpl(path, {
        method: 'GET',
        headers: {
          Accept: accept,
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        let body = {};
        try { body = await response.json(); } catch (_error) { /* non-JSON upstream error */ }
        throw new InstitutionApiError(body.error || 'Report sa nepodarilo načítať.', {
          status: response.status,
          code: body.code || 'API_ERROR',
        });
      }

      if (responseType === 'blob') {
        const disposition = response.headers.get('content-disposition') || '';
        const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
        return {
          blob: await response.blob(),
          filename: filenameMatch ? filenameMatch[1] : 'invok-report.csv',
        };
      }
      return response.json();
    }

    const schoolPath = (schoolId) => `/api/institution/schools/${encodeURIComponent(schoolId)}`;

    return Object.freeze({
      listSchools: () => request('/api/institution/me/schools'),
      getSchool: (schoolId) => request(schoolPath(schoolId)),
      listClasses: (schoolId) => request(`${schoolPath(schoolId)}/classes`),
      getAssessmentSummary: (schoolId, filters) => request(appendQuery(`${schoolPath(schoolId)}/assessment-summary`, filters)),
      getSchoolDeltas: (schoolId, filters) => request(appendQuery(`${schoolPath(schoolId)}/pre-post-deltas`, filters)),
      getClassDeltas: (schoolId, classId, filters) => request(appendQuery(
        `${schoolPath(schoolId)}/classes/${encodeURIComponent(classId)}/pre-post-deltas`,
        filters
      )),
      exportCsv: (schoolId, filters) => request(appendQuery(`${schoolPath(schoolId)}/export.csv`, filters), {
        accept: 'text/csv',
        responseType: 'blob',
      }),
    });
  }

  const MODULE_ORDER = Object.freeze([
    'entrepreneurship',
    'critical_media_thinking',
    'teamwork_digital_tools',
    'presentation_communication',
  ]);

  function summarizeModules(rows) {
    const groups = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!MODULE_ORDER.includes(row.module_key)) continue;
      const group = groups.get(row.module_key) || { count: 0, pre: 0, post: 0 };
      group.count += 1;
      group.pre += Number(row.pre_percent) || 0;
      group.post += Number(row.post_percent) || 0;
      groups.set(row.module_key, group);
    }

    const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
    return MODULE_ORDER.filter((key) => groups.has(key)).map((key) => {
      const group = groups.get(key);
      const avgPre = round(group.pre / group.count);
      const avgPost = round(group.post / group.count);
      return {
        module_key: key,
        pairs: group.count,
        avg_pre_percent: avgPre,
        avg_post_percent: avgPost,
        avg_delta_percent_points: round(avgPost - avgPre),
      };
    });
  }

  function sameExportContext(left, right) {
    return !!left && !!right
      && left.version === right.version
      && left.schoolId === right.schoolId
      && left.classId === right.classId;
  }

  async function exportForContext({ api, context, getCurrentContext }) {
    const filters = { scope: 'summary' };
    if (context.classId) filters.class_id = context.classId;
    try {
      const file = await api.exportCsv(context.schoolId, filters);
      if (!sameExportContext(context, getCurrentContext())) return { status: 'stale' };
      return { status: 'ready', file };
    } catch (error) {
      if (!sameExportContext(context, getCurrentContext())) return { status: 'stale' };
      throw error;
    }
  }

  const MODULE_LABELS = Object.freeze({
    entrepreneurship: 'Podnikavosť a inovácie',
    critical_media_thinking: 'Kritické a mediálne myslenie',
    teamwork_digital_tools: 'Tímová spolupráca a digitálne nástroje',
    presentation_communication: 'Prezentačné a komunikačné zručnosti',
  });

  function startDashboard() {
    const document = root.document;
    if (!document.getElementById('school-filter') || !root.EduAuth) return;

    const elements = {
      main: document.getElementById('main-content'),
      school: document.getElementById('school-filter'),
      class: document.getElementById('class-filter'),
      status: document.getElementById('status'),
      dashboard: document.getElementById('dashboard-content'),
      evidence: document.getElementById('evidence-view'),
      detailPanel: document.getElementById('detail-panel'),
      empty: document.getElementById('empty-state'),
      access: document.getElementById('access-state'),
      error: document.getElementById('error-state'),
      errorMessage: document.getElementById('error-message'),
      retry: document.getElementById('retry-load'),
      exportButton: document.getElementById('export-evidence'),
      trails: document.getElementById('impact-trails'),
      detailBody: document.getElementById('detail-body'),
      detailCount: document.getElementById('detail-count'),
      pairs: document.getElementById('metric-pairs'),
      pre: document.getElementById('metric-pre'),
      post: document.getElementById('metric-post'),
      delta: document.getElementById('metric-delta'),
      contextSchool: document.getElementById('context-school'),
      contextClass: document.getElementById('context-class'),
      contextAttempts: document.getElementById('context-attempts'),
      contextScore: document.getElementById('context-score'),
    };
    const state = { schools: [], classes: [], schoolDetail: null, reportReady: false, requestVersion: 0 };
    const api = createInstitutionApi({
      getAccessToken: () => root.EduAuth.getAccessToken(),
      fetchImpl: (...args) => root.fetch(...args),
    });

    const percent = (value) => value === null || value === undefined || !Number.isFinite(Number(value))
      ? '—'
      : `${Number(value).toLocaleString('sk-SK', { maximumFractionDigits: 2 })} %`;
    const signedPoints = (value) => {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
      const number = Number(value);
      const sign = number > 0 ? '+' : '';
      return `${sign}${number.toLocaleString('sk-SK', { maximumFractionDigits: 2 })} p. b.`;
    };

    const setStatus = (message) => { elements.status.textContent = message; };
    const currentContext = () => ({
      version: state.requestVersion,
      schoolId: elements.school.value,
      classId: elements.class.value,
    });
    const setBusy = (busy) => {
      elements.main.setAttribute('aria-busy', String(busy));
      elements.school.disabled = busy || state.schools.length === 0;
      elements.class.disabled = busy || state.classes.length === 0;
      elements.exportButton.disabled = busy || !state.reportReady;
    };
    const hideStates = () => {
      elements.empty.hidden = true;
      elements.access.hidden = true;
      elements.error.hidden = true;
    };
    const showError = (error) => {
      state.reportReady = false;
      elements.exportButton.disabled = true;
      elements.dashboard.hidden = true;
      elements.empty.hidden = true;
      if (error && error.code === 'NOT_EDUCATOR') {
        elements.error.hidden = true;
        elements.access.hidden = false;
        setStatus('Prístup k inštitucionálnym výsledkom je obmedzený na učiteľov a administrátorov.');
        return;
      }
      elements.access.hidden = true;
      elements.error.hidden = false;
      elements.errorMessage.textContent = error && error.code === 'AUTH_REQUIRED'
        ? 'Vaša relácia vypršala. Prihláste sa znova a potom report obnovte.'
        : 'Skontrolujte pripojenie a skúste report načítať znova.';
      setStatus(error && error.code === 'AUTH_REQUIRED' ? 'Vyžaduje sa prihlásenie.' : 'Načítanie reportu zlyhalo.');
    };

    const fillSelect = (select, rows, allLabel) => {
      select.replaceChildren();
      if (allLabel) {
        const all = document.createElement('option');
        all.value = '';
        all.textContent = allLabel;
        select.append(all);
      }
      for (const row of rows) {
        const option = document.createElement('option');
        option.value = row.id;
        option.textContent = row.name;
        select.append(option);
      }
    };

    const renderReport = (summaryResponse, deltaResponse) => {
      const summary = summaryResponse.summary || {};
      const deltaSummary = deltaResponse.summary || {};
      const modules = summarizeModules(deltaResponse.deltas);
      const selectedSchool = state.schools.find((school) => school.id === elements.school.value);
      const selectedClass = state.classes.find((classItem) => classItem.id === elements.class.value);

      hideStates();
      elements.dashboard.hidden = false;
      state.reportReady = true;
      elements.evidence.hidden = modules.length === 0;
      elements.detailPanel.hidden = modules.length === 0;
      elements.empty.hidden = modules.length !== 0;
      elements.pairs.textContent = String(deltaSummary.students_with_pairs ?? 0);
      elements.pre.textContent = percent(deltaSummary.avg_pre_percent);
      elements.post.textContent = percent(deltaSummary.avg_post_percent);
      elements.delta.textContent = signedPoints(deltaSummary.avg_delta_percent_points);
      elements.delta.className = Number(deltaSummary.avg_delta_percent_points) < 0 ? 'negative' : 'positive';
      elements.contextSchool.textContent = selectedSchool ? selectedSchool.name : '—';
      elements.contextClass.textContent = selectedClass ? selectedClass.name : 'Všetky triedy';
      elements.contextAttempts.textContent = String(summary.attempts_count ?? 0);
      elements.contextScore.textContent = percent(summary.avg_percent_score);
      elements.detailCount.textContent = `${modules.length} ${modules.length === 1 ? 'modul' : modules.length < 5 ? 'moduly' : 'modulov'}`;
      elements.trails.replaceChildren();
      elements.detailBody.replaceChildren();

      for (const module of modules) {
        const trail = document.createElement('article');
        trail.className = 'trail-row';
        const meta = document.createElement('div');
        meta.className = 'trail-meta';
        const title = document.createElement('h3');
        title.textContent = MODULE_LABELS[module.module_key];
        const delta = document.createElement('strong');
        delta.className = module.avg_delta_percent_points < 0 ? 'negative' : 'positive';
        delta.textContent = signedPoints(module.avg_delta_percent_points);
        meta.append(title, delta);

        const rail = document.createElement('div');
        rail.className = 'trail-rail';
        rail.setAttribute('role', 'img');
        rail.setAttribute('aria-label', `${title.textContent}: pred ${percent(module.avg_pre_percent)}, po ${percent(module.avg_post_percent)}, zmena ${delta.textContent}`);
        const prePosition = Math.max(2, Math.min(98, module.avg_pre_percent));
        const postPosition = Math.max(2, Math.min(98, module.avg_post_percent));
        rail.style.setProperty('--pre', `${prePosition}%`);
        rail.style.setProperty('--post', `${postPosition}%`);
        rail.style.setProperty('--start', `${Math.min(prePosition, postPosition)}%`);
        rail.style.setProperty('--distance', `${Math.abs(postPosition - prePosition)}%`);
        const line = document.createElement('span');
        line.className = 'trail-line';
        line.setAttribute('aria-hidden', 'true');
        const preMarker = document.createElement('span');
        preMarker.className = 'trail-marker pre';
        preMarker.setAttribute('aria-hidden', 'true');
        const postMarker = document.createElement('span');
        postMarker.className = 'trail-marker post';
        postMarker.setAttribute('aria-hidden', 'true');
        rail.append(line, preMarker, postMarker);

        const values = document.createElement('div');
        values.className = 'trail-values';
        const preValue = document.createElement('span');
        preValue.className = 'pre-value';
        preValue.textContent = `PRED ${percent(module.avg_pre_percent)}`;
        const pairValue = document.createElement('span');
        pairValue.textContent = `${module.pairs} párov`;
        const postValue = document.createElement('span');
        postValue.className = 'post-value';
        postValue.textContent = `PO ${percent(module.avg_post_percent)}`;
        values.append(preValue, pairValue, postValue);
        trail.append(meta, rail, values);
        elements.trails.append(trail);

        const row = document.createElement('tr');
        const moduleCell = document.createElement('th');
        moduleCell.scope = 'row';
        moduleCell.textContent = MODULE_LABELS[module.module_key];
        const pairCell = document.createElement('td');
        pairCell.textContent = String(module.pairs);
        const preCell = document.createElement('td');
        preCell.textContent = percent(module.avg_pre_percent);
        const postCell = document.createElement('td');
        postCell.textContent = percent(module.avg_post_percent);
        const deltaCell = document.createElement('td');
        deltaCell.className = module.avg_delta_percent_points < 0 ? 'negative' : 'positive';
        deltaCell.textContent = signedPoints(module.avg_delta_percent_points);
        row.append(moduleCell, pairCell, preCell, postCell, deltaCell);
        elements.detailBody.append(row);
      }

      elements.exportButton.disabled = false;
      setStatus(modules.length
        ? `Report je aktuálny. Zobrazené ${modules.length} ${modules.length === 1 ? 'meranie modulu' : 'merania modulov'}.`
        : 'Pre tento výber zatiaľ nie sú dostupné párované pre/post merania.');
    };

    const loadEvidence = async () => {
      const version = ++state.requestVersion;
      state.reportReady = false;
      setBusy(true);
      hideStates();
      setStatus('Počítam zmenu medzi vstupným a výstupným meraním…');
      const schoolId = elements.school.value;
      const classId = elements.class.value;
      const filters = classId ? { class_id: classId } : undefined;
      try {
        const [summary, deltas] = await Promise.all([
          api.getAssessmentSummary(schoolId, filters),
          classId ? api.getClassDeltas(schoolId, classId) : api.getSchoolDeltas(schoolId),
        ]);
        if (version !== state.requestVersion) return;
        renderReport(summary, deltas);
      } catch (error) {
        if (version !== state.requestVersion) return;
        showError(error);
      } finally {
        if (version === state.requestVersion) setBusy(false);
      }
    };

    const loadSchool = async () => {
      const version = ++state.requestVersion;
      state.reportReady = false;
      setBusy(true);
      hideStates();
      elements.dashboard.hidden = true;
      setStatus('Načítavam triedy a školský kontext…');
      const schoolId = elements.school.value;
      try {
        const [detail, classesResponse] = await Promise.all([
          api.getSchool(schoolId),
          api.listClasses(schoolId),
        ]);
        if (version !== state.requestVersion) return;
        state.schoolDetail = detail.school;
        state.classes = classesResponse.classes || [];
        fillSelect(elements.class, state.classes, 'Všetky triedy');
        setBusy(false);
        await loadEvidence();
      } catch (error) {
        if (version !== state.requestVersion) return;
        showError(error);
        setBusy(false);
      }
    };

    const loadSchools = async () => {
      const version = ++state.requestVersion;
      state.schoolDetail = null;
      state.reportReady = false;
      setBusy(true);
      hideStates();
      elements.dashboard.hidden = true;
      setStatus('Načítavam školy priradené k vášmu účtu…');
      try {
        const response = await api.listSchools();
        if (version !== state.requestVersion) return;
        state.schools = response.schools || [];
        fillSelect(elements.school, state.schools);
        if (!state.schools.length) {
          showError(new InstitutionApiError('No schools', { code: 'NO_SCHOOLS' }));
          elements.errorMessage.textContent = 'K tomuto účtu nie je priradená škola. Požiadajte správcu školy o členstvo.';
          setStatus('Nenašla sa žiadna priradená škola.');
          return;
        }
        setBusy(false);
        await loadSchool();
      } catch (error) {
        if (version !== state.requestVersion) return;
        showError(error);
      } finally {
        if (version === state.requestVersion) setBusy(false);
      }
    };

    elements.school.addEventListener('change', loadSchool);
    elements.class.addEventListener('change', loadEvidence);
    elements.retry.addEventListener('click', loadSchools);
    elements.exportButton.addEventListener('click', async () => {
      const exportContext = currentContext();
      elements.exportButton.disabled = true;
      setStatus('Pripravujem CSV export…');
      try {
        const result = await exportForContext({ api, context: exportContext, getCurrentContext: currentContext });
        if (result.status === 'stale') return;
        const { file } = result;
        const url = root.URL.createObjectURL(file.blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = file.filename;
        document.body.append(link);
        link.click();
        link.remove();
        root.URL.revokeObjectURL(url);
        setStatus(`CSV export ${file.filename} je pripravený.`);
      } catch (error) {
        showError(error);
      } finally {
        if (sameExportContext(exportContext, currentContext())) {
          elements.exportButton.disabled = !state.reportReady;
        }
      }
    });

    loadSchools();
  }

  const publicApi = { InstitutionApiError, createInstitutionApi, exportForContext, summarizeModules };
  if (root && root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', startDashboard, { once: true });
    } else {
      startDashboard();
    }
  }
  return publicApi;
});
