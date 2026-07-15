import './style.css';
import * as sync from './sync';
import { initUi } from './ui/app';

initUi();
sync.init();
void sync.refresh();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
	// reload once when an update takes over, but never with unsaved edits
	let hadController = Boolean(navigator.serviceWorker.controller);
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		if (hadController && !sync.busy()) location.reload();
		hadController = true;
	});
	navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => undefined);
}
