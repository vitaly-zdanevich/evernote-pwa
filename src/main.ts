import './style.css';
import { initStore } from './store';
import * as sync from './sync';
import { initUi, rerender } from './ui/app';

function init(): void {
	// paint the shell immediately; notes appear when IndexedDB has loaded
	initUi();
	sync.init();
	void initStore().then(() => {
		rerender();
		void sync.refresh();
	});

	if (import.meta.env.PROD && 'serviceWorker' in navigator) {
		// reload once when an update takes over, but never with unsaved edits
		let hadController = Boolean(navigator.serviceWorker.controller);
		navigator.serviceWorker.addEventListener('controllerchange', () => {
			if (hadController && !sync.busy()) location.reload();
			hadController = true;
		});
		navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => undefined);
	}
}

init();
