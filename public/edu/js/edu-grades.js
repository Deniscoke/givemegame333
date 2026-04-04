/**
 * gIVEMEEDU — Gradebook page logic
 */
const EduGrades = (function () {
  'use strict';

  let _classes = [];
  let _subjects = [];
  let _items = [];
  let _entries = [];
  let _students = [];
  let _selectedClass = null;
  let _selectedSubject = null;

  async function init() {
    const [classData, subjectData] = await Promise.all([
      EduAuth.apiFetch('/classes'),
      EduAuth.apiFetch('/subjects')
    ]);
    _classes = classData.classes || [];
    _subjects = subjectData.subjects || [];
    renderSelectors();
  }

  function renderSelectors() {
    const classSelect = document.getElementById('gb-class');
    const subjectSelect = document.getElementById('gb-subject');
    if (!classSelect) return;

    classSelect.innerHTML = '<option value="">-- Vyberte triedu --</option>' +
      _classes.map(c => `<option value="${c.id}">${esc(c.name)} (${esc(c.school_year)})</option>`).join('');

    subjectSelect.innerHTML = '<option value="">-- Vsetky predmety --</option>' +
      _subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  }

  async function loadGradebook() {
    _selectedClass = document.getElementById('gb-class').value;
    _selectedSubject = document.getElementById('gb-subject').value;
    if (!_selectedClass) return;

    const container = document.getElementById('gradebook-content');
    container.innerHTML = '<div class="edu-loading"><div class="edu-spinner"></div></div>';

    try {
      const [gbData, studentData] = await Promise.all([
        EduAuth.apiFetch(`/gradebook?class_id=${_selectedClass}${_selectedSubject ? '&subject_id=' + _selectedSubject : ''}`),
        EduAuth.apiFetch(`/students?class_id=${_selectedClass}`)
      ]);
      _items = gbData.items || [];
      _entries = gbData.entries || [];
      _students = studentData.students || [];
      renderGradebook();
    } catch (e) {
      container.innerHTML = `<div class="edu-alert edu-alert-error">${e.message}</div>`;
    }
  }

  function renderGradebook() {
    const container = document.getElementById('gradebook-content');
    const role = EduApp.getRole();

    if (_items.length === 0 && _students.length === 0) {
      container.innerHTML = '<div class="edu-empty"><div class="edu-empty-icon">&#128203;</div><p>Ziadne hodnotenia</p></div>';
      return;
    }

    // Build grade matrix: students × items
    let html = '<div style="overflow-x:auto"><table class="edu-table"><thead><tr><th>Ziak</th>';
    for (const item of _items) {
      html += `<th title="${esc(item.title)}">${esc(item.title.substring(0, 15))}${item.title.length > 15 ? '...' : ''}<br><small>${item.type} | v${item.weight}</small></th>`;
    }
    html += '</tr></thead><tbody>';

    // If student role, only show own row
    const studentsToShow = role === 'student'
      ? _students.filter(s => s.student_id === EduAuth.getProfile()?.user?.id)
      : _students;

    for (const student of studentsToShow) {
      html += `<tr><td><strong>${esc(student.display_name || 'Bez mena')}</strong></td>`;
      for (const item of _items) {
        const entry = _entries.find(e => e.grade_item_id === item.id && e.student_id === student.student_id);
        if (role === 'teacher' || role === 'admin') {
          html += `<td><input class="edu-input" style="width:60px;padding:4px;text-align:center"
            data-item="${item.id}" data-student="${student.student_id}"
            value="${entry ? esc(entry.value) : ''}" placeholder="-"></td>`;
        } else {
          html += `<td>${entry ? esc(entry.value) : '-'}</td>`;
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';

    if (role === 'teacher' || role === 'admin') {
      html += '<div style="margin-top:12px"><button class="edu-btn edu-btn-primary" onclick="EduGrades.saveEntries()">Ulozit hodnotenia</button></div>';
    }

    container.innerHTML = html;
  }

  async function saveEntries() {
    const inputs = document.querySelectorAll('#gradebook-content input[data-item]');
    const entries = [];
    inputs.forEach(input => {
      const val = input.value.trim();
      if (!val) return;
      entries.push({
        grade_item_id: input.dataset.item,
        student_id: input.dataset.student,
        value: val
      });
    });
    if (entries.length === 0) return;
    try {
      await EduAuth.apiFetch('/gradebook/entries', { method: 'POST', body: { entries } });
      EduApp.showAlert('alerts', 'Hodnotenia ulozene.', 'info');
    } catch (e) {
      EduApp.showAlert('alerts', 'Chyba: ' + e.message, 'error');
    }
  }

  async function createItem() {
    const title = document.getElementById('gi-title').value.trim();
    const type = document.getElementById('gi-type').value;
    const weight = document.getElementById('gi-weight').value;
    const subject_id = document.getElementById('gb-subject').value || document.getElementById('gi-subject').value;
    if (!title || !_selectedClass) {
      EduApp.showAlert('alerts', 'Vyplnte nazov a vyberte triedu', 'error');
      return;
    }
    if (!subject_id) {
      EduApp.showAlert('alerts', 'Vyberte predmet', 'error');
      return;
    }
    try {
      await EduAuth.apiFetch('/gradebook/items', {
        method: 'POST',
        body: {
          class_id: _selectedClass,
          subject_id,
          title,
          type: type || 'test',
          weight: parseFloat(weight) || 1.0
        }
      });
      document.getElementById('create-item-form').style.display = 'none';
      EduApp.clearAlert('alerts');
      await loadGradebook();
    } catch (e) {
      EduApp.showAlert('alerts', 'Chyba: ' + e.message, 'error');
    }
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  return { init, loadGradebook, saveEntries, createItem };
})();
