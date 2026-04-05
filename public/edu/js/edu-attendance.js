/**
 * gIVEMEEDU — Attendance page logic
 */
const EduAttendance = (function () {
  'use strict';

  let _classes = [];
  let _students = [];
  let _records = [];
  let _selectedClass = null;
  let _selectedDate = null;

  async function init() {
    const { classes } = await EduAuth.apiFetch('/classes');
    _classes = classes || [];
    renderClassSelect();

    // Default to today
    const dateInput = document.getElementById('att-date');
    if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
  }

  function renderClassSelect() {
    const select = document.getElementById('att-class');
    if (!select) return;
    select.innerHTML = '<option value="">-- Vyberte triedu --</option>' +
      _classes.map(c => `<option value="${c.id}">${esc(c.name)} (${esc(c.school_year)})</option>`).join('');
  }

  async function loadAttendance() {
    _selectedClass = document.getElementById('att-class').value;
    _selectedDate = document.getElementById('att-date').value;
    if (!_selectedClass || !_selectedDate) return;

    const container = document.getElementById('attendance-content');
    container.innerHTML = '<div class="edu-loading"><div class="edu-spinner"></div></div>';

    try {
      const [studentData, attData] = await Promise.all([
        EduAuth.apiFetch(`/students?class_id=${_selectedClass}`),
        EduAuth.apiFetch(`/attendance?class_id=${_selectedClass}&date=${_selectedDate}`)
      ]);
      _students = studentData.students || [];
      _records = attData.attendance || [];
      renderAttendance();
    } catch (e) {
      container.innerHTML = `<div class="edu-alert edu-alert-error">${esc(e.message)}</div>`;
    }
  }

  function renderAttendance() {
    const container = document.getElementById('attendance-content');
    const role = EduApp.getRole();

    if (_students.length === 0) {
      container.innerHTML = '<div class="edu-empty"><div class="edu-empty-icon">&#128100;</div><p>Ziadni ziaci v triede</p></div>';
      return;
    }

    const STATUSES = [
      { value: 'present', label: 'Pritomny', cls: 'edu-badge-present' },
      { value: 'absent', label: 'Nepr.', cls: 'edu-badge-absent' },
      { value: 'late', label: 'Neskoro', cls: 'edu-badge-late' },
      { value: 'excused', label: 'Ospravedl.', cls: 'edu-badge-excused' }
    ];

    let html = '<table class="edu-table"><thead><tr><th>Ziak</th><th>Stav</th><th>Poznamka</th></tr></thead><tbody>';

    const displayStudents = role === 'student'
      ? _students.filter(s => s.student_id === EduAuth.getProfile()?.user?.id)
      : _students;

    for (const s of displayStudents) {
      const rec = _records.find(r => r.student_id === s.student_id);
      const currentStatus = rec?.status || 'present';

      if (role === 'teacher' || role === 'admin') {
        const options = STATUSES.map(st =>
          `<option value="${st.value}" ${currentStatus === st.value ? 'selected' : ''}>${st.label}</option>`
        ).join('');
        html += `<tr>
          <td><strong>${esc(s.display_name || 'Bez mena')}</strong></td>
          <td><select class="edu-select" style="width:auto" data-student="${s.student_id}">${options}</select></td>
          <td><input class="edu-input" style="width:200px" data-student-note="${s.student_id}" value="${esc(rec?.note || '')}" placeholder="Poznamka"></td>
        </tr>`;
      } else {
        const badge = STATUSES.find(st => st.value === currentStatus);
        html += `<tr>
          <td><strong>${esc(s.display_name || 'Bez mena')}</strong></td>
          <td><span class="edu-badge ${badge?.cls || ''}">${badge?.label || currentStatus}</span></td>
          <td>${esc(rec?.note || '')}</td>
        </tr>`;
      }
    }
    html += '</tbody></table>';

    if (role === 'teacher' || role === 'admin') {
      html += '<div style="margin-top:12px"><button class="edu-btn edu-btn-primary" onclick="EduAttendance.save()">Ulozit dochadzku</button></div>';
    }

    container.innerHTML = html;
  }

  async function save() {
    const selects = document.querySelectorAll('#attendance-content select[data-student]');
    const records = [];
    selects.forEach(sel => {
      const studentId = sel.dataset.student;
      const noteInput = document.querySelector(`input[data-student-note="${studentId}"]`);
      records.push({
        student_id: studentId,
        status: sel.value,
        note: noteInput?.value?.trim() || null
      });
    });

    if (records.length === 0) return;
    try {
      await EduAuth.apiFetch('/attendance', {
        method: 'POST',
        body: { class_id: _selectedClass, date: _selectedDate, records }
      });
      EduApp.showAlert('alerts', 'Dochadzka ulozena.', 'info');
    } catch (e) {
      EduApp.showAlert('alerts', 'Chyba: ' + esc(e.message), 'error');
    }
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  return { init, loadAttendance, save };
})();
