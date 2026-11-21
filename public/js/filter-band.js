/* gIVEMEGAME.IO — age band picker.
   The band select (#filter-age-band) is a shortcut: it copies its range into
   the free 6-19 min/max selects that getFilters() in script.js reads. Editing
   min/max by hand keeps min <= max and moves the band to the matching preset
   or to "custom". Pure helpers are exported for tests. */
(function (root) {
	'use strict';

	/** Band key for a min/max pair: preset key, '' when empty, else 'custom'. */
	function bandForRange(min, max, bands) {
		if (!min && !max) return '';
		for (const key of Object.keys(bands || {})) {
			if (String(bands[key].min) === String(min) && String(bands[key].max) === String(max)) return key;
		}
		return 'custom';
	}

	/** Keep min <= max: the side the user just changed wins. */
	function orderRange(min, max, changed) {
		if (min && max && Number(min) > Number(max)) {
			return changed === 'max' ? { min: max, max } : { min, max: min };
		}
		return { min, max };
	}

	function wire(doc) {
		const band = doc.getElementById('filter-age-band');
		const minEl = doc.getElementById('filter-age-min');
		const maxEl = doc.getElementById('filter-age-max');
		if (!band || !minEl || !maxEl) return;
		const presets = root.FilterPresets;
		const bands = presets ? presets.AGE_BANDS : {};

		const syncBand = () => {
			const next = bandForRange(minEl.value, maxEl.value, bands);
			if (band.value !== next) band.value = next;
		};

		band.addEventListener('change', () => {
			const opt = band.selectedOptions && band.selectedOptions[0];
			if (band.value === '') {
				minEl.value = '';
				maxEl.value = '';
			} else if (opt && opt.dataset.min && opt.dataset.max) {
				minEl.value = opt.dataset.min;
				maxEl.value = opt.dataset.max;
			}
		});

		const onRange = changed => () => {
			const r = orderRange(minEl.value, maxEl.value, changed);
			minEl.value = r.min;
			maxEl.value = r.max;
			syncBand();
		};
		minEl.addEventListener('change', onRange('min'));
		maxEl.addEventListener('change', onRange('max'));

		// "Surprise me" and other code reset min/max without a change event:
		// re-derive the band after any click or key press.
		const later = () => setTimeout(syncBand, 0);
		doc.addEventListener('click', later, true);
		doc.addEventListener('keyup', later, true);
		syncBand();
	}

	const api = { bandForRange, orderRange, wire };
	if (typeof module === 'object' && module.exports) {
		module.exports = api;
	} else {
		root.FilterBand = api;
		if (root.document) {
			if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', () => wire(root.document));
			else wire(root.document);
		}
	}
})(typeof window !== 'undefined' ? window : this);
