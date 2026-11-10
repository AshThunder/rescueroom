// Standalone alerts service: indexes vault events and delivers alerts. Buttons only OPEN signing pages.
// The API server (server/src/index.js) runs the same dispatcher; use one or the other.
// Usage: node alerts/src/alerts.js
import { view, loadState } from '../../scripts/lib/near.js';
import { Indexer, DATA_DIR } from '../../server/src/indexer.js';
import { createDispatcher } from './dispatcher.js';

const st = loadState();
const vaults = (process.env.ALERT_VAULTS || st.vault).split(',');
const indexer = new Indexer(vaults);
const d = createDispatcher({ indexer, dataDir: DATA_DIR, view, mainVault: st.vault });
console.log(`alerts on ${vaults.join(', ')}; channels`, d.channels());
indexer.start();
